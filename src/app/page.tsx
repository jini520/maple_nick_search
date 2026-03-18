import { RankingTable } from "@/components/RankingTable";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-center px-4 py-16">
        <header className="mb-12 text-center">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 sm:text-3xl">
            휴먼 닉네임
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            메이플스토리 캐릭터 종합 랭킹 조회
            <br />
            <span className="text-sm">
              (챌린저스, 챌린저스2, 챌린저스3, 챌린저스4 월드)
            </span>
          </p>
        </header>

        <RankingTable />
      </main>
    </div>
  );
}
