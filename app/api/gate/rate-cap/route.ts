import { NextResponse } from "next/server";
import { getGateRateCap, getRateCapCacheInfo } from "@/lib/gate-rate-cap";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/gate/rate-cap?token=BTC
 *
 * Debug endpoint: returns Gate isolated-margin rate cap data for a specific token
 * (or all tokens if ?token is omitted).
 * Also includes cache metadata.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenParam = searchParams.get("token")?.toUpperCase() ?? null;

  try {
    const data = await getGateRateCap();
    const cacheInfo = getRateCapCacheInfo();

    if (tokenParam) {
      const entry = data.get(tokenParam) ?? null;
      return NextResponse.json({
        token: tokenParam,
        found: entry !== null,
        data: entry,
        cache: cacheInfo,
        fetchedAt: Date.now(),
      });
    }

    // Return all tokens
    const all = Object.fromEntries(data.entries());
    return NextResponse.json({
      count: data.size,
      data: all,
      cache: cacheInfo,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
