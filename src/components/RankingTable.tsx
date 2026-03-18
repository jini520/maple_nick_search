"use client";

import { useState } from "react";

const TARGET_WORLDS = ["챌린저스", "챌린저스2", "챌린저스3", "챌린저스4"];

export function RankingTable() {
  const [world, setWorld] = useState(TARGET_WORLDS[0]);
  const [page, setPage] = useState(1);
  const [notFoundList, setNotFoundList] = useState<
    { name: string; character_level: number }[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    setError(null);
    setLoading(true);
    setNotFoundList(null);
    setSavedPath(null);

    try {
      const params = new URLSearchParams();
      params.set("world_name", world);
      params.set("page", String(page));
      params.set("date", "2025-12-03");

      const res = await fetch(`/api/check-not-found?${params.toString()}`);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `오류: ${res.status}`);
      }

      const result = await res.json();
      const { notFound, savedPaths } = result;

      setNotFoundList(notFound);
      setSavedPath(savedPaths?.length ? savedPaths.join(", ") : null);
      setPage((prev) => prev + 2);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "조회 중 오류가 발생했습니다."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            월드
          </label>
          <select
            value={world}
            onChange={(e) => setWorld(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            disabled={loading}
          >
            {TARGET_WORLDS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            페이지
          </label>
          <input
            type="number"
            min={1}
            value={page}
            onChange={(e) => setPage(Number(e.target.value) || 1)}
            className="w-20 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            disabled={loading}
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={handleSearch}
            disabled={loading}
            className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "조회 중..." : "조회"}
          </button>
        </div>
      </div>

      {savedPath && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          조회되지 않는 캐릭터 {notFoundList?.length ?? 0}건 → {savedPath} 저장됨
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {notFoundList && notFoundList.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[300px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  #
                </th>
                <th className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  캐릭터명
                </th>
                <th className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  레벨
                </th>
              </tr>
            </thead>
            <tbody>
              {notFoundList.map((entry, index) => (
                <tr
                  key={`${entry.name}-${index}`}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                >
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {index + 1}
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    {entry.name}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {entry.character_level}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notFoundList && notFoundList.length === 0 && !loading && (
        <p className="text-zinc-500 dark:text-zinc-400">
          조회되지 않는 캐릭터가 없습니다.
        </p>
      )}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Data based on NEXON Open API
      </p>
    </div>
  );
}
