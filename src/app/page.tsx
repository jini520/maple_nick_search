import { RankingTable } from "@/components/RankingTable";

export default function Home() {
  return (
    <div className="page-gradient min-h-screen text-zinc-900 dark:text-zinc-50">
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 pb-20 pt-16 sm:px-6 sm:pt-20">
        <header className="mb-10 text-center sm:mb-12">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-200/80 bg-white/70 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm backdrop-blur-sm dark:border-zinc-700/80 dark:bg-zinc-900/60 dark:text-zinc-400">
            <span
              className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
              aria-hidden
            />
            NEXON Open API
          </div>
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            휴먼 닉네임
          </h1>
          <p className="mx-auto mt-3 max-w-md text-pretty text-sm leading-relaxed text-zinc-600 dark:text-zinc-400 sm:text-base">
            종합 랭킹에 올라와 있지만 캐릭터 조회 API에서 찾을 수 없는 닉네임을
            모아 봅니다.
            <span className="mt-2 block text-xs text-zinc-500 dark:text-zinc-500">
              챌린저스 · 챌린저스2 · 챌린저스3 · 챌린저스4
            </span>
          </p>
        </header>

        <RankingTable />
      </main>
    </div>
  );
}
