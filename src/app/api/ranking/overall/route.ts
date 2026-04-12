import { NextRequest, NextResponse } from "next/server";
import { getOverallRanking } from "@/lib/nexon-api";

export async function GET(request: NextRequest) {
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "NEXON_API_KEY가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const world_name = searchParams.get("world_name") ?? undefined;
  const world_type = searchParams.get("world_type");
  const page = searchParams.get("page");
  const date = searchParams.get("date") ?? "2026-04-13";

  try {
    const data = await getOverallRanking(apiKey, {
      world_name,
      world_type:
        world_type !== null && world_type !== undefined
          ? (Number(world_type) as 0 | 1)
          : undefined,
      page: page !== null && page !== undefined ? Number(page) : undefined,
      date: date || undefined,
    });

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "랭킹 조회 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}
