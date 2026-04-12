import { NextRequest } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  getCharacterOcid,
  getOverallRanking,
  type OverallRankingEntry,
} from "@/lib/nexon-api";
import {
  TokenBucketLimiter,
  NEXON_MAX_REQUESTS_PER_SECOND,
} from "@/lib/nexon-rate-limit";
import { isHangulTwoSyllableNickname } from "@/lib/hangul-nick";

/** Vercel 등에서 긴 스캔 허용 (로컬은 무시될 수 있음) */
export const maxDuration = 300;

type ProgressStage = "fetch_ranking" | "scan_ocid" | "page_done";
type ScanPhase = "ranking" | "ranking_ocid" | "ocid";

/** 랭킹·OCID 병렬 구간: 둘 다 반영한 단일 바 */
function overallPercentPipeline(
  rankMerged: number,
  lastPage: number,
  ocidDone: number,
  hangulTotal: number
): number {
  const rPart =
    lastPage > 0 ? Math.min(40, (rankMerged / lastPage) * 40) : 0;
  const oPart =
    hangulTotal > 0
      ? Math.min(60, (ocidDone / hangulTotal) * 60)
      : ocidDone > 0
        ? 5
        : 0;
  return Math.min(100, Math.round((rPart + oPart) * 10) / 10);
}

function encodeSse(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

function csvEscapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildHangulNicknamesCsv(nicknames: string[]): string {
  const header = "nickname";
  const lines = [header, ...nicknames.map(csvEscapeCell)];
  return `\uFEFF${lines.join("\n")}\n`;
}

type PageFetchResult = { p: number; ranking: OverallRankingEntry[] };

/** 단일 랭킹 HTTP 상한(너무 길면 슬라이딩 윈도 전체가 꼬리에 묶임) */
const RANKING_PAGE_TIMEOUT_MS = 14_000;

/**
 * 랭킹 전용 버스트: 동시에 많이 돌아올 때도 refill(초당 한도)은 그대로 두고
 * 짧은 순간에 토큰을 더 쌓아 두어 acquire 대기를 줄인다.
 */
const RANKING_TOKEN_BURST_CAPACITY =
  NEXON_MAX_REQUESTS_PER_SECOND * 2;

/** 랭킹 페이지 조회 실패 시 재시도 횟수(첫 시도 + 재시도) */
const RANKING_FETCH_MAX_ATTEMPTS = 4;

/**
 * merge 기준 앞으로 동시에 진행할 랭킹 페이지 수(작을수록 진행률이 촘촘해짐).
 * 호출 빈도는 아래 rankingLimiter로 초당 한도를 맞춘다.
 */
const RANKING_MAX_IN_FLIGHT = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === "function") {
    return anyFn([a, b]);
  }
  const out = new AbortController();
  const abortOut = () => out.abort();
  if (a.aborted || b.aborted) {
    abortOut();
    return out.signal;
  }
  a.addEventListener("abort", abortOut, { once: true });
  b.addEventListener("abort", abortOut, { once: true });
  return out.signal;
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "NEXON_API_KEY가 설정되지 않았습니다." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const { searchParams } = new URL(request.url);
  const world_name = searchParams.get("world_name");
  const last_page_raw = searchParams.get("last_page");
  const date = searchParams.get("date") ?? "2026-04-13";

  if (!world_name || !last_page_raw) {
    return new Response(
      JSON.stringify({ error: "world_name과 last_page가 필요합니다." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const lastPage = Math.floor(Number(last_page_raw));
  if (!Number.isFinite(lastPage) || lastPage < 1) {
    return new Response(
      JSON.stringify({ error: "last_page는 1 이상의 정수여야 합니다." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const limiter = new TokenBucketLimiter(
        RANKING_TOKEN_BURST_CAPACITY,
        NEXON_MAX_REQUESTS_PER_SECOND
      );
      const ctx = { rateLimiter: limiter };

      const send = (event: string, data: unknown) => {
        if (signal.aborted) return;
        controller.enqueue(encodeSse(event, data));
      };

      /** 한글 2글자 닉 → 랭킹에 나온 최고 레벨 */
      const hangulLevelByName = new Map<string, number>();
      let rankingPagesMerged = 0;
      let rankingHttpFinished = 0;
      const rankingBreakPage: number | null = null;
      const rankingStoppedEarly = false;
      const rankingStopNote: string | null = null;

      /** OCID: 닉당 1회만 조회 */
      const ocidScheduled = new Set<string>();
      const ocidNotFoundNames = new Set<string>();
      const ocidTasks: Promise<void>[] = [];
      let ocidDoneCount = 0;

      try {
        if (signal.aborted) {
          send("aborted", { message: "요청이 취소되었습니다." });
        } else {
          const scanStartedAt = Date.now();

          send("progress", {
            scanPhase: "ranking" satisfies ScanPhase,
            lastPage,
            currentPage: 0,
            stage: "fetch_ranking" satisfies ProgressStage,
            pagesDone: 0,
            ocidGrandDone: 0,
            ocidEstTotal: 0,
            ocidPageDone: 0,
            ocidPageTotal: 0,
            overallPercent: 0,
            note: `랭킹 최대 ${RANKING_MAX_IN_FLIGHT}페이지 동시 조회 후, 응답 도착 즉시 한글 2글자 닉만 OCID에 넣습니다.`,
          });

          const rankingProgressEvery = Math.max(
            1,
            Math.min(5, Math.ceil(lastPage / 120))
          );
          const ocidProgressEvery = 25;

          const fetchRankingPage = async (p: number): Promise<PageFetchResult> => {
            let lastError: unknown;
            for (let attempt = 1; attempt <= RANKING_FETCH_MAX_ATTEMPTS; attempt++) {
              if (signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
              }
              try {
                const pageSignal = combineAbortSignals(
                  signal,
                  AbortSignal.timeout(RANKING_PAGE_TIMEOUT_MS)
                );
                const data = await getOverallRanking(
                  apiKey,
                  { world_name, page: p, date, signal: pageSignal },
                  ctx
                );
                return { p, ranking: data.ranking ?? [] };
              } catch (e) {
                lastError = e;
                if (signal.aborted) {
                  throw new DOMException("Aborted", "AbortError");
                }
                if (attempt < RANKING_FETCH_MAX_ATTEMPTS) {
                  await delay(80 * 2 ** (attempt - 1));
                }
              }
            }
            throw lastError instanceof Error
              ? lastError
              : new Error(`랭킹 ${p}페이지 조회에 ${RANKING_FETCH_MAX_ATTEMPTS}회 실패했습니다.`);
          };

          const bumpOcidAndMaybeReport = () => {
            ocidDoneCount += 1;
            const hTotal = hangulLevelByName.size;
            const scheduled = ocidScheduled.size;
            const should =
              scheduled > 0 &&
              (ocidDoneCount === scheduled ||
                ocidDoneCount % ocidProgressEvery === 0);
            if (!should) return;
            const rankDone = rankingPagesMerged;
            const phase: ScanPhase =
              rankDone >= lastPage
                ? "ocid"
                : hTotal > 0
                  ? "ranking_ocid"
                  : "ranking";
            send("progress", {
              scanPhase: phase,
              lastPage,
              currentPage: rankDone,
              stage: "scan_ocid" satisfies ProgressStage,
              pagesDone: rankDone,
              ocidGrandDone: ocidDoneCount,
              ocidEstTotal: Math.max(1, hTotal),
              ocidPageDone: ocidDoneCount,
              ocidPageTotal: Math.max(1, hTotal),
              overallPercent: overallPercentPipeline(
                rankDone,
                lastPage,
                ocidDoneCount,
                Math.max(1, hTotal)
              ),
              rankingHttpFinished: rankDone,
              rankingPagesMerged,
              rankingBreakPage,
            });
          };

          const ingestRankingPayload = (r: PageFetchResult) => {
            for (const row of r.ranking) {
              const raw = row.character_name?.trim() ?? "";
              if (!isHangulTwoSyllableNickname(raw)) continue;
              const lv = row.character_level ?? 0;
              const prev = hangulLevelByName.get(raw);
              if (prev === undefined || lv > prev) hangulLevelByName.set(raw, lv);
              if (ocidScheduled.has(raw)) continue;
              ocidScheduled.add(raw);
              ocidTasks.push(
                (async () => {
                  try {
                    const ocid = await getCharacterOcid(raw, apiKey, ctx);
                    if (!ocid) ocidNotFoundNames.add(raw);
                  } catch {
                    ocidNotFoundNames.add(raw);
                  }
                  bumpOcidAndMaybeReport();
                })()
              );
            }
          };

          let mergeNext = 1;
          let launchNext = 1;
          const pending = new Map<number, PageFetchResult>();
          const inflight = new Map<number, Promise<void>>();

          const startRankingFetch = (p: number) => {
            const run = async () => {
              const r = await fetchRankingPage(p);
              ingestRankingPayload(r);
              pending.set(p, r);
            };
            const task = run();
            inflight.set(
              p,
              task.finally(() => {
                inflight.delete(p);
              })
            );
          };

          while (mergeNext <= lastPage) {
            while (
              launchNext <= lastPage &&
              launchNext - mergeNext < RANKING_MAX_IN_FLIGHT
            ) {
              startRankingFetch(launchNext);
              launchNext += 1;
            }

            if (!pending.has(mergeNext)) {
              if (inflight.size === 0) {
                throw new Error(
                  `랭킹 ${mergeNext}페이지 결과를 기다렸으나 진행 중인 요청이 없습니다.`
                );
              }
              await Promise.race(inflight.values());
            }

            while (pending.has(mergeNext)) {
              const r = pending.get(mergeNext)!;
              pending.delete(mergeNext);
              rankingHttpFinished = mergeNext;
              rankingPagesMerged = mergeNext;

              const inSlowTail = mergeNext > lastPage - 25;
              const shouldReport =
                mergeNext === 1 ||
                mergeNext === lastPage ||
                mergeNext % rankingProgressEvery === 0 ||
                inSlowTail;
              if (shouldReport) {
                const hTotal = hangulLevelByName.size;
                const phase: ScanPhase =
                  hTotal > 0 && ocidDoneCount < ocidScheduled.size
                    ? "ranking_ocid"
                    : "ranking";
                send("progress", {
                  scanPhase: phase,
                  lastPage,
                  currentPage: mergeNext,
                  stage: "fetch_ranking" satisfies ProgressStage,
                  pagesDone: mergeNext,
                  ocidGrandDone: ocidDoneCount,
                  ocidEstTotal: Math.max(1, hTotal),
                  ocidPageDone: ocidDoneCount,
                  ocidPageTotal: Math.max(1, hTotal),
                  overallPercent: overallPercentPipeline(
                    mergeNext,
                    lastPage,
                    ocidDoneCount,
                    Math.max(1, hTotal)
                  ),
                  rankingHttpFinished: mergeNext,
                  rankingPagesMerged,
                  rankingBreakPage,
                });
              }

              mergeNext += 1;
            }
          }

          await Promise.allSettled([...inflight.values()]);

          const rankingEndedAt = Date.now();
          const elapsedMsRanking = rankingEndedAt - scanStartedAt;

          send("progress", {
            scanPhase: "ranking" satisfies ScanPhase,
            lastPage,
            currentPage: rankingHttpFinished,
            stage: "fetch_ranking" satisfies ProgressStage,
            pagesDone: rankingHttpFinished,
            ocidGrandDone: ocidDoneCount,
            ocidEstTotal: Math.max(1, hangulLevelByName.size),
            ocidPageDone: ocidDoneCount,
            ocidPageTotal: Math.max(1, hangulLevelByName.size),
            overallPercent: overallPercentPipeline(
              rankingHttpFinished,
              lastPage,
              ocidDoneCount,
              Math.max(1, hangulLevelByName.size)
            ),
            rankingHttpFinished,
            rankingPagesMerged,
            rankingBreakPage,
          });

          let elapsedMsOcid = 0;
          const sortedHangul = [...hangulLevelByName.keys()].sort((a, b) =>
            a.localeCompare(b, "ko")
          );

          const ocidTotalForWait = hangulLevelByName.size;
          if (ocidTotalForWait > 0) {
            const ocidPhaseStart = Date.now();
            send("progress", {
              scanPhase: "ocid" satisfies ScanPhase,
              lastPage,
              currentPage: rankingPagesMerged,
              stage: "scan_ocid" satisfies ProgressStage,
              pagesDone: rankingPagesMerged,
              ocidGrandDone: ocidDoneCount,
              ocidEstTotal: ocidTotalForWait,
              ocidPageDone: ocidDoneCount,
              ocidPageTotal: ocidTotalForWait,
              overallPercent: overallPercentPipeline(
                lastPage,
                lastPage,
                ocidDoneCount,
                ocidTotalForWait
              ),
              rankingHttpFinished,
              rankingPagesMerged,
              rankingBreakPage,
              note: "랭킹 수집이 끝났습니다. 남은 OCID 응답을 기다립니다.",
            });
            await Promise.all(ocidTasks);
            elapsedMsOcid = Date.now() - ocidPhaseStart;
          }

          const notFound = sortedHangul
            .filter((name) => ocidNotFoundNames.has(name))
            .map((name) => ({
              name,
              character_level: hangulLevelByName.get(name) ?? 0,
            }));

          const ocidTotal = sortedHangul.length;
          const elapsedMsTotal = Date.now() - scanStartedAt;

          const exportsDir = path.join(process.cwd(), "exports");
          await mkdir(exportsDir, { recursive: true });
          const safeWorld = world_name.replace(/[/\\?%*:|"<>]/g, "_");
          const csvNames = notFound
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, "ko"));
          const csvFilename = `ocid_not_found_${safeWorld}_${Date.now()}.csv`;
          const csvAbsolute = path.join(exportsDir, csvFilename);
          const csvContent = buildHangulNicknamesCsv(csvNames);
          await writeFile(csvAbsolute, csvContent, "utf-8");
          const csvRelativePath = `exports/${csvFilename}`;

          send("progress", {
            scanPhase: "ocid" satisfies ScanPhase,
            lastPage,
            currentPage: rankingPagesMerged,
            stage: "page_done" satisfies ProgressStage,
            pagesDone: rankingPagesMerged,
            ocidGrandDone: ocidTotal,
            ocidEstTotal: ocidTotal,
            ocidPageDone: ocidTotal,
            ocidPageTotal: ocidTotal,
            overallPercent: 100,
            rankingHttpFinished,
            rankingPagesMerged,
            rankingBreakPage,
          });

          send("done", {
            notFound,
            world_name,
            lastPage,
            pagesDone: rankingPagesMerged,
            csvRelativePath,
            csvNotFoundCount: csvNames.length,
            hangulFilterCount: sortedHangul.length,
            rankingStoppedEarly,
            rankingStopNote,
            rankingHttpFinished,
            rankingPagesMerged,
            rankingBreakPage,
            elapsedMsTotal,
            elapsedMsRanking,
            elapsedMsOcid,
          });
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError" &&
          signal.aborted
        ) {
          send("aborted", { message: "요청이 취소되었습니다." });
        } else {
          send("error", {
            message:
              error instanceof Error
                ? error.message
                : "조회 중 오류가 발생했습니다.",
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
