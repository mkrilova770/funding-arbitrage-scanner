import { NextResponse } from "next/server";
import { fetchGateMarginPairs } from "@/lib/exchanges/gate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const pairs = await fetchGateMarginPairs();
    return NextResponse.json({ pairs, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
