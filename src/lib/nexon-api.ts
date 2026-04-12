import type { TokenBucketLimiter } from "@/lib/nexon-rate-limit";

const NEXON_API_BASE = "https://open.api.nexon.com/maplestory/v1";

/** OCID 단건 fetch 상한(멈춤으로 전체 Promise.all이 꼬리 잡히는 것 방지) */
const OCID_FETCH_TIMEOUT_MS = 14_000;

/**
 * OCID HTTP 단계: 429·5xx 등 일시 오류마다 1회씩 소모(무한 재시도 방지).
 * 한 번의 getCharacterOcid 호출 안에서만 쓰인다.
 */
const OCID_HTTP_RETRY_MAX_ATTEMPTS = 24;

/** 타임아웃·네트워크 등 fetchOcid 바깥에서 잡히는 실패용 전체 파동 */
const OCID_OUTER_MAX_WAVES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After: 초 단위 정수 또는 HTTP-date */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header?.trim()) return null;
  const t = header.trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const sec = Number(t);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.min(120_000, Math.round(sec * 1000));
  }
  const at = Date.parse(t);
  if (!Number.isNaN(at)) {
    return Math.min(120_000, Math.max(0, at - Date.now()));
  }
  return null;
}

function isLikelyFetchTimeout(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "TimeoutError" || e.name === "AbortError")
  );
}

function isRetryableOcidHttpStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export type NexonRequestContext = {
  rateLimiter?: { acquire(): Promise<void> };
};

/**
 * 캐릭터 OCID 식별자 조회 - 존재하면 ocid 반환, 없으면 null
 * @see https://openapi.nexon.com/ko/game/maplestory/?id=14
 */
async function fetchOcid(
  url: string,
  apiKey: string,
  ctx: NexonRequestContext | undefined,
  signal: AbortSignal
): Promise<string | null> {
  for (let attempt = 0; attempt < OCID_HTTP_RETRY_MAX_ATTEMPTS; attempt++) {
    await ctx?.rateLimiter?.acquire();

    const res = await fetch(url, {
      headers: { "x-nxopen-api-key": apiKey },
      signal,
    });

    if (isRetryableOcidHttpStatus(res.status)) {
      await res.text().catch(() => {});
      const waitMs =
        res.status === 429
          ? parseRetryAfterMs(res.headers.get("Retry-After")) ??
            Math.min(10_000, 200 * 2 ** Math.min(attempt, 12))
          : Math.min(8000, 280 * 2 ** Math.min(attempt, 10));
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorCode = errorData?.error?.name;
      if (errorCode === "OPENAPI00003" || res.status === 400) {
        return null;
      }
      throw new Error(errorData?.message || `API 오류: ${res.status}`);
    }

    const data = await res.json();
    return data.ocid ?? null;
  }

  throw new Error(
    `OCID 조회: 일시 오류(429/5xx 등)가 ${OCID_HTTP_RETRY_MAX_ATTEMPTS}회 재시도 후에도 계속됩니다.`
  );
}

export async function getCharacterOcid(
  characterName: string,
  apiKey: string,
  ctx?: NexonRequestContext
): Promise<string | null> {
  const url = `${NEXON_API_BASE}/id?character_name=${encodeURIComponent(characterName)}`;
  let lastError: unknown;
  for (let wave = 0; wave < OCID_OUTER_MAX_WAVES; wave++) {
    const signal = AbortSignal.timeout(OCID_FETCH_TIMEOUT_MS);
    try {
      return await fetchOcid(url, apiKey, ctx, signal);
    } catch (e) {
      lastError = e;
      if (wave < OCID_OUTER_MAX_WAVES - 1) {
        const pause = isLikelyFetchTimeout(e)
          ? Math.min(2500, 350 * (wave + 1))
          : Math.min(2000, 280 * (wave + 1));
        await sleep(pause);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}

export interface OverallRankingEntry {
  date: string;
  ranking: number;
  character_name: string;
  world_name: string;
  class_name: string;
  sub_class_name: string;
  character_level: number;
  character_exp: number;
  character_popularity: number;
  character_guildname: string;
}

export interface OverallRankingResponse {
  ranking: OverallRankingEntry[];
}

function isRankingRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503;
}

export async function getOverallRanking(
  apiKey: string,
  options?: {
    world_name?: string;
    world_type?: 0 | 1;
    page?: number;
    date?: string;
    /** 단일 랭킹 요청 상한(멈춤 방지). 미지정 시 무제한 */
    signal?: AbortSignal;
  },
  ctx?: NexonRequestContext
): Promise<OverallRankingResponse> {
  await ctx?.rateLimiter?.acquire();

  const params = new URLSearchParams();
  if (options?.world_name) params.set("world_name", options.world_name);
  if (options?.world_type !== undefined)
    params.set("world_type", String(options.world_type));
  if (options?.page !== undefined) params.set("page", String(options.page));
  if (options?.date) params.set("date", options.date);

  const url = `${NEXON_API_BASE}/ranking/overall?${params.toString()}`;
  const headers = { "x-nxopen-api-key": apiKey };

  const doFetch = () =>
    fetch(url, {
      headers,
      signal: options?.signal,
    });

  let res = await doFetch();
  if (!res.ok && isRankingRetryableStatus(res.status)) {
    await res.text().catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 180));
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    res = await doFetch();
  }

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData?.message || `API 오류: ${res.status} ${res.statusText}`
    );
  }

  return res.json();
}
