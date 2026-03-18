const NEXON_API_BASE = "https://open.api.nexon.com/maplestory/v1";

/**
 * 캐릭터 OCID 식별자 조회 - 존재하면 ocid 반환, 없으면 null
 * @see https://openapi.nexon.com/ko/game/maplestory/?id=14
 */
export async function getCharacterOcid(
  characterName: string,
  apiKey: string
): Promise<string | null> {
  const url = `${NEXON_API_BASE}/id?character_name=${encodeURIComponent(characterName)}`;

  const res = await fetch(url, {
    headers: { "x-nxopen-api-key": apiKey },
  });

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

/** 동시 요청 수 (연결 풀 제한 회피, 127 이하 권장) */
const OCID_CONCURRENCY = 100;

export interface NotFoundEntry {
  name: string;
  character_level: number;
}

/**
 * 랭킹 데이터의 캐릭터들 중 OCID 조회 시 존재하지 않는 캐릭터 목록 반환
 * 배치 병렬 요청 (동시 연결 제한 회피)
 */
export async function findNotFoundCharacters(
  rankingEntries: { character_name: string; character_level: number }[],
  apiKey: string
): Promise<NotFoundEntry[]> {
  const entries = rankingEntries
    .filter((e) => e.character_name?.trim())
    .map((e) => ({
      name: e.character_name.trim(),
      character_level: e.character_level ?? 0,
    }));

  const notFound: NotFoundEntry[] = [];

  for (let i = 0; i < entries.length; i += OCID_CONCURRENCY) {
    const chunk = entries.slice(i, i + OCID_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (entry) => {
        try {
          const ocid = await getCharacterOcid(entry.name, apiKey);
          return { ...entry, notFound: !ocid };
        } catch {
          return { ...entry, notFound: true };
        }
      })
    );
    notFound.push(
      ...results.filter((r) => r.notFound).map(({ name, character_level }) => ({ name, character_level }))
    );
  }

  return notFound;
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

export async function getOverallRanking(
  apiKey: string,
  options?: {
    world_name?: string;
    world_type?: 0 | 1;
    page?: number;
    date?: string;
  }
): Promise<OverallRankingResponse> {
  const params = new URLSearchParams();
  if (options?.world_name) params.set("world_name", options.world_name);
  if (options?.world_type !== undefined)
    params.set("world_type", String(options.world_type));
  if (options?.page !== undefined) params.set("page", String(options.page));
  if (options?.date) params.set("date", options.date);

  const url = `${NEXON_API_BASE}/ranking/overall?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "x-nxopen-api-key": apiKey,
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData?.message || `API 오류: ${res.status} ${res.statusText}`
    );
  }

  return res.json();
}
