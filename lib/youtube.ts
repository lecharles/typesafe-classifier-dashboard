import { videos as bundled, type Video } from "@/data/youtube";

export type FetchOpts = { query?: string; channelId?: string; max?: number };

/**
 * Returns videos to analyze. Uses the live YouTube Data API v3 when
 * YOUTUBE_API_KEY is set; otherwise falls back to the bundled sample.
 */
export async function fetchVideos(opts: FetchOpts = {}): Promise<{ videos: Video[]; source: "live" | "bundled" }> {
  const key = process.env.YOUTUBE_API_KEY;
  const max = Math.min(opts.max ?? 50, 50);

  if (!key || (!opts.query && !opts.channelId)) {
    return { videos: bundled.slice(0, max), source: "bundled" };
  }

  const params = new URLSearchParams({
    key,
    part: "snippet",
    type: "video",
    maxResults: String(max),
    order: "date",
  });
  if (opts.query) params.set("q", opts.query);
  if (opts.channelId) params.set("channelId", opts.channelId);

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) {
    // On any live-fetch failure, degrade gracefully to bundled data.
    return { videos: bundled.slice(0, max), source: "bundled" };
  }
  const data = await res.json();
  const videos: Video[] = (data.items ?? [])
    .filter((it: { id?: { videoId?: string } }) => it.id?.videoId)
    .map((it: { id: { videoId: string }; snippet: { title: string; description: string; channelTitle: string; publishedAt: string } }) => ({
      id: it.id.videoId,
      title: it.snippet.title,
      description: it.snippet.description,
      channel: it.snippet.channelTitle,
      publishedAt: it.snippet.publishedAt.slice(0, 10),
    }));

  return { videos: videos.length ? videos : bundled.slice(0, max), source: videos.length ? "live" : "bundled" };
}
