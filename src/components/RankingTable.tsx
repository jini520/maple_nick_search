"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_WORLDS = ["챌린저스", "챌린저스2", "챌린저스3", "챌린저스4"];

/** Nexon 전체 랭킹 API `date`(YYYY-MM-DD) 기본값 */
const DEFAULT_RANKING_DATE = "2026-04-13";

function parseLastPageInput(raw: string): number {
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

type ProgressStage = "fetch_ranking" | "scan_ocid" | "page_done";

type ScanPhase = "ranking" | "ranking_ocid" | "ocid";

type ScanProgress = {
  scanPhase?: ScanPhase;
  lastPage: number;
  currentPage: number;
  stage: ProgressStage;
  pagesDone: number;
  ocidGrandDone: number;
  ocidEstTotal: number;
  ocidPageDone: number;
  ocidPageTotal: number;
  overallPercent: number;
  note?: string;
  /** 순서대로 랭킹 HTTP 조회를 마친 페이지 번호(빈 페이지에서 멈추면 그 번호까지) */
  rankingHttpFinished?: number;
  /** 빈 랭킹 전까지 닉 후보에 합친 랭킹 페이지 수 */
  rankingPagesMerged?: number;
  /** 합치기를 멈춘 페이지(API 랭킹 배열이 비어 있기 시작한 페이지) */
  rankingBreakPage?: number | null;
};

type DonePayload = {
  notFound: { name: string; character_level: number }[];
  world_name: string;
  lastPage: number;
  pagesDone: number;
  csvRelativePath: string;
  /** CSV에 저장된 닉 수 (= OCID 미조회) */
  csvNotFoundCount: number;
  /** 한글 2글자로 선별해 OCID 조회한 닉 수 */
  hangulFilterCount: number;
  rankingStoppedEarly?: boolean;
  rankingStopNote?: string | null;
  rankingHttpFinished?: number;
  rankingPagesMerged?: number;
  rankingBreakPage?: number | null;
  elapsedMsTotal?: number;
  elapsedMsRanking?: number;
  elapsedMsOcid?: number;
};

function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s >= 100 ? `${s.toFixed(1)}초` : `${s.toFixed(2)}초`;
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function stageLabel(progress: ScanProgress): string {
  if (progress.scanPhase === "ranking") {
    if (progress.stage === "page_done") return "랭킹 수집 종료";
    return "랭킹 수집";
  }
  if (progress.scanPhase === "ranking_ocid") {
    return "랭킹 + OCID 병렬";
  }
  if (progress.scanPhase === "ocid") {
    if (progress.stage === "page_done") return "선별 OCID 검사 완료";
    if (progress.stage === "scan_ocid") return "선별 OCID 검사";
  }
  switch (progress.stage) {
    case "fetch_ranking":
      return "랭킹 조회";
    case "scan_ocid":
      return "OCID 검사";
    case "page_done":
      return "완료";
    default:
      return progress.stage;
  }
}

async function consumeSse(
  response: Response,
  handlers: {
    onProgress: (data: ScanProgress) => void;
    onDone: (data: DonePayload) => void;
    onAborted?: () => void;
  },
  signal?: AbortSignal
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("응답 본문을 읽을 수 없습니다.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const parseBlock = (raw: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:"))
        dataLines.push(line.slice(5).trimStart());
    }
    const dataStr = dataLines.join("\n");
    if (!dataStr) return;
    try {
      const data = JSON.parse(dataStr) as unknown;
      if (event === "progress") handlers.onProgress(data as ScanProgress);
      else if (event === "done") handlers.onDone(data as DonePayload);
      else if (event === "error") {
        const msg =
          typeof (data as { message?: string })?.message === "string"
            ? (data as { message: string }).message
            : "오류가 발생했습니다.";
        throw new Error(msg);
      } else if (event === "aborted") handlers.onAborted?.();
    } catch (e) {
      if (e instanceof SyntaxError)
        throw new Error("진행 데이터를 해석하지 못했습니다.");
      throw e;
    }
  };

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        parseBlock(block);
      }
    }
  } catch (e) {
    if (signal?.aborted || (e instanceof Error && e.name === "AbortError"))
      return;
    throw e;
  } finally {
    reader.releaseLock();
  }
}

function ProgressPanel({ progress }: { progress: ScanProgress }) {
  const pct = Math.min(100, Math.max(0, progress.overallPercent));
  const ocidPct =
    (progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid") &&
    progress.ocidEstTotal > 0
      ? Math.min(
          100,
          Math.round((progress.ocidGrandDone / progress.ocidEstTotal) * 1000) /
            10
        )
      : 0;

  return (
    <section
      className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/90 sm:p-6"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            진행 상황
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid"
              ? `한글 2글자 닉 ${progress.ocidEstTotal.toLocaleString("ko-KR")}명 대상 · `
              : `페이지 ${progress.currentPage} / ${progress.lastPage} · `}
            {stageLabel(progress)}
          </p>
        </div>
        <span className="tabular-nums text-2xl font-semibold tracking-tight text-blue-600 dark:text-blue-400">
          {pct.toFixed(1)}%
        </span>
      </div>

      <div
        className="mb-6 h-2.5 overflow-hidden rounded-full bg-zinc-200/90 dark:bg-zinc-800"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="전체 진행률"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-[width] duration-200 ease-out dark:from-blue-500 dark:to-indigo-400"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid"
              ? "랭킹 반영"
              : "랭킹 응답"}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid"
              ? (progress.rankingPagesMerged ?? progress.pagesDone)
              : progress.pagesDone}
            <span className="text-zinc-400 dark:text-zinc-500"> / </span>
            {progress.lastPage}
          </p>
          {progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid" ? (
            <div className="mt-1 space-y-1 text-xs text-zinc-500 dark:text-zinc-500">
              <p>
                닉 후보에 반영한 랭킹 페이지 수입니다. 요청은{" "}
                {progress.lastPage.toLocaleString("ko-KR")}페이지까지 보냈고,
                HTTP 응답은{" "}
                {(progress.rankingHttpFinished ?? progress.lastPage).toLocaleString(
                  "ko-KR"
                )}
                페이지입니다.
              </p>
            </div>
          ) : (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              1페이지부터 최대 50개까지 동시에 조회합니다. 랭킹 응답이 오는 대로
              한글 2글자 닉은 곧바로 OCID 조회에도 넣습니다.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            OCID 검사 (선별)
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid"
              ? progress.ocidGrandDone.toLocaleString("ko-KR")
              : "—"}
            <span className="text-zinc-400 dark:text-zinc-500"> / </span>
            <span className="text-zinc-600 dark:text-zinc-300">
              {progress.ocidEstTotal > 0
                ? progress.ocidEstTotal.toLocaleString("ko-KR")
                : progress.scanPhase === "ranking"
                  ? "도착 시"
                  : "—"}
            </span>
          </p>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
            role="progressbar"
            aria-valuenow={Math.round(ocidPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="선별 OCID 검사 진행률"
          >
            <div
              className="h-full rounded-full bg-zinc-500 transition-[width] duration-200 ease-out dark:bg-zinc-400"
              style={{
                width: `${(progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid") && progress.ocidEstTotal > 0 ? ocidPct : 0}%`,
              }}
            />
          </div>
          {(progress.scanPhase === "ocid" || progress.scanPhase === "ranking_ocid") &&
            progress.ocidPageTotal > 0 && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
              배치 진행: {progress.ocidPageDone.toLocaleString("ko-KR")} /{" "}
              {progress.ocidPageTotal.toLocaleString("ko-KR")}
            </p>
          )}
        </div>
      </div>

      {progress.note && (
        <p className="mt-4 text-xs text-amber-700 dark:text-amber-300/90">
          {progress.note}
        </p>
      )}
    </section>
  );
}

export function RankingTable() {
  const [world, setWorld] = useState(TARGET_WORLDS[0]);
  const [rankingDate, setRankingDate] = useState(DEFAULT_RANKING_DATE);
  const [endPageInput, setEndPageInput] = useState("1");
  const [notFoundList, setNotFoundList] = useState<
    { name: string; character_level: number }[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [csvExport, setCsvExport] = useState<{
    path: string;
    count: number;
    filterCount: number;
    earlyStop?: boolean;
    note?: string | null;
    elapsedMsTotal: number;
    elapsedMsRanking: number;
    elapsedMsOcid: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const abortInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => () => abortInFlight(), [abortInFlight]);

  async function handleSearch() {
    abortInFlight();
    const lastPage = parseLastPageInput(endPageInput);
    setEndPageInput(String(lastPage));

    setError(null);
    setLoading(true);
    setNotFoundList(null);
    setCsvExport(null);
    setProgress({
      scanPhase: "ranking",
      lastPage,
      currentPage: 1,
      stage: "fetch_ranking",
      pagesDone: 0,
      ocidGrandDone: 0,
      ocidEstTotal: 0,
      ocidPageDone: 0,
      ocidPageTotal: 0,
      overallPercent: 0,
    });

    const ac = new AbortController();
    abortRef.current = ac;

    const params = new URLSearchParams();
    params.set("world_name", world);
    params.set("last_page", String(lastPage));
    params.set("date", rankingDate);

    try {
      const res = await fetch(`/api/check-not-found?${params.toString()}`, {
        signal: ac.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          (errData as { error?: string }).error || `오류: ${res.status}`
        );
      }

      if (!res.body) throw new Error("스트림을 열 수 없습니다.");

      await consumeSse(
        res,
        {
          onProgress: (data) => setProgress(data),
          onDone: (data) => {
            setNotFoundList(data.notFound);
            setCsvExport({
              path: data.csvRelativePath,
              count: data.csvNotFoundCount,
              filterCount: data.hangulFilterCount,
              earlyStop: data.rankingStoppedEarly,
              note: data.rankingStopNote,
              elapsedMsTotal: data.elapsedMsTotal ?? 0,
              elapsedMsRanking: data.elapsedMsRanking ?? 0,
              elapsedMsOcid: data.elapsedMsOcid ?? 0,
            });
            setProgress((prev) =>
              prev
                ? {
                    ...prev,
                    scanPhase: "ocid",
                    overallPercent: 100,
                    stage: "page_done",
                  }
                : null
            );
          },
          onAborted: () => {},
        },
        ac.signal
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("조회가 취소되었습니다.");
      } else {
        setError(
          err instanceof Error ? err.message : "조회 중 오류가 발생했습니다."
        );
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  /** 셀렉트·숫자 입력·버튼 동일 높이 (브라우저 기본 패딩 차이 최소화) */
  const controlClass =
    "box-border h-11 w-full rounded-xl border border-zinc-200/90 bg-white px-3.5 text-sm leading-none text-zinc-900 shadow-sm transition-[border-color,box-shadow] outline-none focus:border-blue-500/70 focus:ring-[3px] focus:ring-blue-500/20 dark:border-zinc-600/90 dark:bg-zinc-900/80 dark:text-zinc-100 dark:focus:border-blue-400/70 dark:focus:ring-blue-400/20";

  return (
    <div className="flex w-full flex-col gap-8">
      <section className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-[0_1px_0_rgba(0,0,0,0.03),0_12px_40px_-12px_rgba(0,0,0,0.12)] dark:border-zinc-700/80 dark:bg-zinc-900/90 dark:shadow-[0_1px_0_rgba(255,255,255,0.04),0_12px_40px_-12px_rgba(0,0,0,0.45)] sm:p-6">
        <div className="mb-5 flex flex-col gap-1 border-b border-zinc-100 pb-5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            조회 조건
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            랭킹 응답이 올 때마다 한글{" "}
            <strong className="font-medium text-zinc-700 dark:text-zinc-300">
              2글자
            </strong>{" "}
            닉만 골라 OCID를 조회합니다. 랭킹은 아래{" "}
            <strong className="font-medium text-zinc-700 dark:text-zinc-300">
              기준일
            </strong>
            의 종합 랭킹 데이터를 씁니다. OCID가 없는 닉은{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">
              exports/
            </code>{" "}
            아래 CSV로 저장합니다.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-3">
            <div className="min-w-0 flex-1">
              <label
                htmlFor="world"
                className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
              >
                월드
              </label>
              <div className="relative">
                <select
                  id="world"
                  value={world}
                  onChange={(e) => setWorld(e.target.value)}
                  disabled={loading}
                  className={`${controlClass} cursor-pointer appearance-none pr-10 disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {TARGET_WORLDS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500">
                  <svg
                    className="size-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    <path d="M6 9l6 6 6-6" strokeLinecap="round" />
                  </svg>
                </span>
              </div>
            </div>

            <div className="w-full shrink-0 sm:w-[7.5rem]">
              <label
                htmlFor="endPage"
                className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
              >
                마지막 페이지
              </label>
              <input
                id="endPage"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={endPageInput}
                onChange={(e) => setEndPageInput(e.target.value)}
                disabled={loading}
                className={`${controlClass} tabular-nums disabled:cursor-not-allowed disabled:opacity-60`}
              />
            </div>

            <div className="w-full shrink-0 sm:w-[11.25rem]">
              <label
                htmlFor="rankingDate"
                className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
              >
                랭킹 기준일 (API date)
              </label>
              <input
                id="rankingDate"
                type="date"
                value={rankingDate}
                onChange={(e) => {
                  const v = e.target.value;
                  setRankingDate(v || DEFAULT_RANKING_DATE);
                }}
                disabled={loading}
                className={`${controlClass} min-w-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60`}
              />
            </div>

            <div className="flex min-h-11 gap-2 sm:shrink-0 sm:justify-end">
              {loading && (
                <button
                  type="button"
                  onClick={() => abortInFlight()}
                  className="inline-flex h-11 min-w-[4.5rem] flex-1 shrink-0 items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700/80 sm:flex-none"
                >
                  취소
                </button>
              )}
              <button
                type="button"
                onClick={handleSearch}
                disabled={loading}
                className="inline-flex h-11 min-w-[7.5rem] flex-1 shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-medium text-white shadow-md shadow-blue-600/25 transition-[background,box-shadow,transform] hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-600/30 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 dark:bg-blue-500 dark:shadow-blue-500/20 dark:hover:bg-blue-400 sm:flex-none"
              >
                {loading ? (
                  <>
                    <Spinner className="size-4 animate-spin" />
                    조회 중
                  </>
                ) : (
                  "조회"
                )}
              </button>
            </div>
          </div>
          <p className="text-[11px] leading-4 text-zinc-500 dark:text-zinc-500">
            마지막 페이지: 1부터 입력한 번호까지 스캔합니다.
          </p>
        </div>
      </section>

      {loading && progress && <ProgressPanel progress={progress} />}

      {csvExport && !loading && (
        <div className="rounded-xl border border-sky-200/90 bg-sky-50/90 px-4 py-3 text-sm text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-100">
          <p className="font-medium">
            OCID 미조회 닉네임 {csvExport.count.toLocaleString("ko-KR")}건을
            CSV로 저장했습니다.
            <span className="mt-1 block text-xs font-normal text-sky-900/75 dark:text-sky-200/70">
              (한글 2글자 선별{" "}
              {csvExport.filterCount.toLocaleString("ko-KR")}명 중)
            </span>
          </p>
          <p className="mt-2 text-xs font-medium text-sky-950 dark:text-sky-100">
            소요 시간: 전체 {formatDurationMs(csvExport.elapsedMsTotal)} ·
            랭킹 수집 완료까지 {formatDurationMs(csvExport.elapsedMsRanking)} ·
            OCID 구간 {formatDurationMs(csvExport.elapsedMsOcid)}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-sky-900/80 dark:text-sky-200/75">
            랭킹과 OCID가 동시에 진행되므로, 구간 시간의 합이 전체와 같지 않을
            수 있습니다.
          </p>
          <p className="mt-1 break-all font-mono text-xs text-sky-900/80 dark:text-sky-200/70">
            {csvExport.path}
          </p>
          {csvExport.earlyStop && csvExport.note && (
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-200/90">
              {csvExport.note}
            </p>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200/90 bg-red-50/90 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
        >
          {error}
        </div>
      )}

      {notFoundList && notFoundList.length > 0 && !loading && (
        <section className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-surface shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/90">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800 sm:px-5">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              결과
            </h2>
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {notFoundList.length}명
            </span>
          </div>
          <div className="max-h-[min(24rem,50vh)] overflow-x-auto overflow-y-auto">
            <table className="w-full min-w-[320px] text-left text-sm">
              <thead>
                <tr className="sticky top-0 border-b border-zinc-100 bg-zinc-50/95 text-xs font-medium uppercase tracking-wide text-zinc-500 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-800/95 dark:text-zinc-400">
                  <th className="w-14 px-4 py-3 sm:px-5">#</th>
                  <th className="px-4 py-3 sm:px-5">캐릭터명</th>
                  <th className="w-24 px-4 py-3 text-right sm:px-5">레벨</th>
                </tr>
              </thead>
              <tbody>
                {notFoundList.map((entry, index) => (
                  <tr
                    key={`${entry.name}-${index}`}
                    className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50/80 dark:border-zinc-800/80 dark:hover:bg-zinc-800/40"
                  >
                    <td className="px-4 py-3 tabular-nums text-zinc-500 dark:text-zinc-400 sm:px-5">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100 sm:px-5">
                      {entry.name}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400 sm:px-5">
                      {entry.character_level}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {notFoundList && notFoundList.length === 0 && !loading && (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/50 px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-900/30">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            조회되지 않는 캐릭터가 없습니다
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            다른 마지막 페이지나 월드로 다시 시도해 보세요.
          </p>
        </div>
      )}

      <p className="text-center text-[11px] text-zinc-400 dark:text-zinc-600">
        Data based on NEXON Open API
      </p>
    </div>
  );
}
