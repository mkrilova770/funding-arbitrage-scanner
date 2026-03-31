import { NextResponse } from "next/server";
import { fetchGateMarginPairs, fetchGateBorrowInfo, GateFuturesAdapter } from "@/lib/exchanges/gate";
import { BinanceAdapter } from "@/lib/exchanges/binance";
import { OkxAdapter } from "@/lib/exchanges/okx";
import { BybitAdapter } from "@/lib/exchanges/bybit";
import { BitgetAdapter } from "@/lib/exchanges/bitget";
import { BingXAdapter } from "@/lib/exchanges/bingx";
import { XtAdapter } from "@/lib/exchanges/xt";
import { MexcAdapter } from "@/lib/exchanges/mexc";
import { BitMartAdapter } from "@/lib/exchanges/bitmart";
import { KuCoinAdapter } from "@/lib/exchanges/kucoin";
import { ExchangeAdapter, toFundingAPR, FundingInfo } from "@/lib/exchanges/types";
import { ArbitrageRow, ScanResponse } from "@/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// All exchange adapters
const adapters: ExchangeAdapter[] = [
  new BinanceAdapter(),
  new OkxAdapter(),
  new BybitAdapter(),
  new GateFuturesAdapter(),
  new BitgetAdapter(),
  new BingXAdapter(),
  new XtAdapter(),
  new MexcAdapter(),
  new BitMartAdapter(),
  new KuCoinAdapter(),
];

export async function GET() {
  const errors: Record<string, string> = {};
  const fetchedAt = Date.now();

  // Step 1: fetch Gate isolated margin pairs
  let gatePairs: { base: string; id: string }[] = [];
  try {
    const pairs = await fetchGateMarginPairs();
    gatePairs = pairs;
  } catch (err) {
    errors["Gate.MarginPairs"] = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ rows: [], fetchedAt, errors }, { status: 200 });
  }

  const gateTokens = gatePairs.map((p) => p.base.toUpperCase());
  const tokenSet = new Set(gateTokens);

  // Step 2: fetch borrow info + all exchange funding in parallel
  const [borrowResult, ...adapterResults] = await Promise.allSettled([
    fetchGateBorrowInfo(gateTokens),
    ...adapters.map((adapter) =>
      adapter
        .fetchFunding(tokenSet)
        .then((map) => ({ name: adapter.name, map }))
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          return { name: adapter.name, map: new Map<string, FundingInfo>(), error: msg };
        })
    ),
  ]);

  // Build borrow map
  const borrowMap = new Map<
    string,
    { borrowAPR: number; liquidityToken: number | null; liquidityUsdt: number | null; spotPrice: number }
  >();
  if (borrowResult.status === "fulfilled") {
    for (const [token, info] of borrowResult.value.entries()) {
      borrowMap.set(token, {
        borrowAPR: info.borrowAPR,
        liquidityToken: info.liquidityToken,
        liquidityUsdt: info.liquidityUsdt,
        spotPrice: info.spotPrice,
      });
    }
  } else {
    errors["Gate.Borrow"] =
      borrowResult.reason instanceof Error
        ? borrowResult.reason.message
        : String(borrowResult.reason);
  }

  // Build exchange funding maps
  const exchangeFundingMaps = new Map<string, Map<string, FundingInfo>>();
  for (const result of adapterResults) {
    if (result.status === "fulfilled") {
      const { name, map, error } = result.value as {
        name: string;
        map: Map<string, FundingInfo>;
        error?: string;
      };
      if (error) errors[name] = error;
      exchangeFundingMaps.set(name, map);
    }
  }

  // Step 3: build arbitrage rows
  const rows: ArbitrageRow[] = [];

  for (const token of gateTokens) {
    const borrow = borrowMap.get(token);
    const borrowAPR = borrow?.borrowAPR ?? 0;
    const spotPrice = borrow?.spotPrice ?? 0;
    const liquidityToken = borrow?.liquidityToken ?? null;
    const liquidityUsdt = borrow?.liquidityUsdt ?? null;

    for (const [exchangeName, fundingMap] of exchangeFundingMaps.entries()) {
      const funding = fundingMap.get(token);
      if (!funding) continue;

      const fundingAPR = toFundingAPR(funding.rawFundingRate, funding.intervalHours);

      const spread =
        spotPrice > 0 && funding.markPrice > 0
          ? ((funding.markPrice - spotPrice) / spotPrice) * 100
          : 0;

      const netAPR = fundingAPR - borrowAPR;

      rows.push({
        id: `${token}-${exchangeName}`,
        token,
        exchange: exchangeName,
        rawFunding: funding.rawFundingRate,
        intervalHours: funding.intervalHours,
        fundingAPR,
        borrowAPR,
        netAPR,
        spread,
        futuresPrice: funding.markPrice,
        spotPrice,
        borrowLiquidityToken: liquidityToken,
        borrowLiquidityUsdt: liquidityUsdt,
        nextFundingTime: funding.nextFundingTime,
        updatedAt: fetchedAt,
      });
    }
  }

  // Sort by netAPR descending by default
  rows.sort((a, b) => b.netAPR - a.netAPR);

  const response: ScanResponse = { rows, fetchedAt, errors };
  return NextResponse.json(response);
}
