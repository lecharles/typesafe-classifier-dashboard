import { NextResponse } from "next/server";
import { classify } from "@/lib/classify";
import { classifyRequest } from "@/lib/schema";
import { GatewayError } from "@/lib/gateway";

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
    const result = await classify(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof GatewayError ? 502 : 500;
    const message = err instanceof Error ? err.message : "classification failed";
    return NextResponse.json({ error: message }, { status });
  }
}
