import { NextResponse } from "next/server";
import { fetchGateBorrowInfo } from "@/lib/exchanges/gate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokensParam = searchParams.get("tokens");
  const tokens = tokensParam ? tokensParam.split(",").filter(Boolean) : [];

  if (tokens.length === 0) {
    return NextResponse.json({ error: "tokens param required" }, { status: 400 });
  }

  try {
    const borrowMap = await fetchGateBorrowInfo(tokens);
    const result = Object.fromEntries(borrowMap.entries());
    return NextResponse.json({ borrow: result, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
