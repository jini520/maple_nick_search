import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  getOverallRanking,
  findNotFoundCharacters,
} from "@/lib/nexon-api";

export async function GET(request: NextRequest) {
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "NEXON_API_KEY가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const world_name = searchParams.get("world_name");
  const page = searchParams.get("page");
  const date = searchParams.get("date") ?? "2025-12-03";

  if (!world_name || !page) {
    return NextResponse.json(
      { error: "world_name과 page가 필요합니다." },
      { status: 400 }
    );
  }

  try {
    const pageNum = Number(page);
    const resDir = path.join(process.cwd(), "res");
    await mkdir(resDir, { recursive: true });

    const allNotFound: { name: string; character_level: number }[] = [];
    const savedPaths: string[] = [];

    for (const p of [pageNum, pageNum + 1]) {
      const rankingData = await getOverallRanking(apiKey, {
        world_name,
        page: p,
        date,
      });

      if (!rankingData.ranking?.length) continue;

      const notFound = await findNotFoundCharacters(
        rankingData.ranking,
        apiKey
      );

      const filename = `${world_name}_${p}.txt`;
      const filePath = path.join(resDir, filename);
      const content =
        notFound.length > 0 ? notFound.map((e) => e.name).join("\n") : "";
      await writeFile(filePath, content, "utf-8");

      allNotFound.push(...notFound);
      savedPaths.push(`res/${filename}`);
    }

    return NextResponse.json({
      notFound: allNotFound,
      world_name,
      page: pageNum,
      savedPaths,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "조회 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}
