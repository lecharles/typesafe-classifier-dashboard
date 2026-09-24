import { NextResponse } from "next/server";
import { fetchVideos } from "@/lib/youtube";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q") ?? undefined;
  const channelId = searchParams.get("channelId") ?? undefined;
  const { videos, source } = await fetchVideos({ query, channelId });
  return NextResponse.json({ videos, source, liveEnabled: Boolean(process.env.YOUTUBE_API_KEY) });
}
