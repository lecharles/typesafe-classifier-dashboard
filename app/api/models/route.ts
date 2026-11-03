import { NextResponse } from "next/server";
import { listModels } from "@/lib/jev";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";

/** Connectivity/credential check: proxies GET https://api.typesafe.ai/v1/models. */
export async function GET() {
  try {
    const models = await listModels();
    return NextResponse.json({ models });
  } catch (err) {
    const status = err instanceof JevError && err.status >= 400 && err.status < 500 ? err.status : 502;
    const message = err instanceof Error ? err.message : "model list failed";
    return NextResponse.json({ error: message }, { status });
  }
}
