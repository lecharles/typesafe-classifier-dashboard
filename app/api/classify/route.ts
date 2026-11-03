import { NextResponse } from "next/server";
import { classify } from "@/lib/classify";
import { classifyRequest } from "@/lib/schema";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = classifyRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const result = await classify(parsed.data, { provider: parsed.data.provider });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "classification failed";
    return NextResponse.json({ error: message }, { status });
  }
}
