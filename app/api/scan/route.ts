import { NextResponse } from "next/server";
import {
  GateFuturesAdapter,
  fetchGateBorrowInfo,
  fetchGateMarginPairs,
} from "@/lib/exchanges/gate";
import { BinanceAdapter } from "@/lib/exchanges/binance";
import { OkxAdapter } from "@/lib/exchanges/okx";
import { BybitAdapter } from "@/lib/exchanges/bybit";
import { BitgetAdapter } from "@/lib/exchanges/bitget";
import { BingXAdapter } from "@/lib/exchanges/bingx";
import { XtAdapter } from "@/lib/exchanges/xt";
import { MexcAdapter } from "@/lib/exchanges/mexc";
import { BitMartAdapter } from "@/lib/exchanges/bitmart";
import { KuCoinAdapter } from "@/lib/exchanges/kucoin";
import {
  ExchangeAdapter,
  toFundingAPR,
  FundingInfo,
} from "@/lib/exchanges/types";
import { ArbitrageRow, ScanResponse } from "@/types";
import { getTradingFeesPercent } from "@/lib/fees";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

/**
 * When `SCAN_UPSTREAM_URL` is set (e.g. Railway app origin), this route returns a **read-only
 * copy** of `GET {origin}/api/scan` only — no POST body, no mutations on the remote host.
 */
function scanUpstreamBase(): string | null {
  const raw = process.env.SCAN_UPSTREAM_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

async function tryRespondWithUpstreamScanCopy(): Promise<NextResponse | null> {
  const base = scanUpstreamBase();
  if (!base) return null;

  const url = `${base}/api/scan`;
  const timeoutMs = Math.max(
    5_000,
    parseInt(process.env.SCAN_UPSTREAM_TIMEOUT_MS ?? "120000", 10) || 120_000
  );

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    console.log(`[scan] read-only copy: GET ${url} → HTTP ${res.status}, ${body.length} B`);

    const ct =
      res.headers.get("Content-Type")?.split(";")[0]?.trim() || "application/json";

    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": ct,
        "X-Scan-Data-Source": "upstream-readonly-copy",
        "X-Scan-Upstream-Base": base,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[scan] upstream read-only copy failed: ${msg}`);
    const errFetchedAt = Date.now();
    return NextResponse.json(
      {
        rows: [],
        fetchedAt: errFetchedAt,
        errors: { "Scan.Upstream": msg },
      },
      {
        status: 502,
        headers: {
          "X-Scan-Data-Source": "upstream-error",
          "X-Scan-Upstream-Base": base,
        },
      }
    );
  }
}

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

const SWR_TTL_MS = Math.max(
  5_000,
  parseInt(process.env.SCAN_SWR_TTL_MS ?? "45000", 10) || 45_000
);

let lastGoodResponse: ScanResponse | null = null;
let refreshInProgress: Promise<void> | null = null;

/** Last successful funding map per exchange; used when a refresh fails so rows are not wiped. */
let lastExchangeFundingByName = new Map<string, Map<string, FundingInfo>>();

async function buildScanResponse(): Promise<ScanResponse> {
  const errors: Record<string, string> = {};
  const fetchedAt = Date.now();

  // Step 1: fetch Gate isolated-margin USDT bases (borrow side universe)
  let gatePairs: { base: string; id: string }[] = [];
  try {
    const pairs = await fetchGateMarginPairs();
    gatePairs = pairs.map((p) => ({ base: p.base, id: p.id }));
  } catch (err) {
    errors["Gate.MarginPairs"] = err instanceof Error ? err.message : String(err);
    return { rows: [], fetchedAt, errors };
  }

  const gateTokens = [...new Set(gatePairs.map((p) => p.base.toUpperCase()))];
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

  const borrowMap = new Map<
    string,
    { borrowAPR: number; liquidityToken: number | null; liquidityUsdt: number | null; spotPrice: number }
  >();
  if (borrowResult.status === "fulfilled") {
    for (const [token, info] of borrowResult.value.entries()) {
      borrowMap.set(token, info);
    }
  } else {
    errors["Gate.Borrow"] =
      borrowResult.reason instanceof Error
        ? borrowResult.reason.message
        : String(borrowResult.reason);
  }

  // Build exchange funding maps (merge with per-exchange stale cache on failure)
  const exchangeFundingMaps = new Map<string, Map<string, FundingInfo>>();
  adapterResults.forEach((result, i) => {
    const adapter = adapters[i];
    const name = adapter.name;

    if (result.status === "rejected") {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      const stale = lastExchangeFundingByName.get(name);
      if (stale && stale.size > 0) {
        exchangeFundingMaps.set(name, stale);
        errors[name] = `${msg} (cached funding until next successful fetch)`;
      } else {
        errors[name] = msg;
        exchangeFundingMaps.set(name, new Map());
      }
      return;
    }

    const { map, error } = result.value as {
      name: string;
      map: Map<string, FundingInfo>;
      error?: string;
    };

    if (error) {
      const stale = lastExchangeFundingByName.get(name);
      if (stale && stale.size > 0) {
        exchangeFundingMaps.set(name, stale);
        errors[name] = `${error} (cached funding until next successful fetch)`;
      } else {
        errors[name] = error;
        exchangeFundingMaps.set(name, map);
      }
      return;
    }

    lastExchangeFundingByName.set(name, new Map(map));
    exchangeFundingMaps.set(name, map);
  });

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

      const tradingFees = getTradingFeesPercent(exchangeName);
      const netAPR = fundingAPR - borrowAPR - tradingFees;

      rows.push({
        id: `${token}-${exchangeName}`,
        token,
        exchange: exchangeName,
        rawFunding: funding.rawFundingRate,
        intervalHours: funding.intervalHours,
        fundingAPR,
        borrowAPR,
        tradingFees,
        netAPR,
        spread,
        futuresPrice: funding.markPrice,
        spotPrice,
        borrowLiquidityToken: liquidityToken,
        borrowLiquidityUsdt: liquidityUsdt,
        borrowPoolFromUta: liquidityToken != null && liquidityToken > 0,
        nextFundingTime: funding.nextFundingTime,
        updatedAt: fetchedAt,
      });
    }
  }

  // Sort by netAPR descending by default
  rows.sort((a, b) => b.netAPR - a.netAPR);

  return { rows, fetchedAt, errors };
}

export async function GET() {
  const upstream = await tryRespondWithUpstreamScanCopy();
  if (upstream) return upstream;

  const now = Date.now();
  const cached = lastGoodResponse;
  const ageMs = cached ? now - cached.fetchedAt : null;
  const isFresh = cached && ageMs != null && ageMs < SWR_TTL_MS;

  // Fresh cache: return immediately
  if (cached && isFresh) {
    return NextResponse.json(cached, {
      headers: {
        "X-Scan-Cache": "hit",
        "X-Scan-Cache-Age-Ms": String(ageMs),
      },
    });
  }

  // Stale cache: return immediately and refresh in background
  if (cached && !isFresh) {
    if (!refreshInProgress) {
      refreshInProgress = buildScanResponse()
        .then((data) => {
          lastGoodResponse = data;
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[scan] background refresh failed: ${msg}`);
        })
        .finally(() => {
          refreshInProgress = null;
        });
    }
    return NextResponse.json(cached, {
      headers: {
        "X-Scan-Cache": "stale",
        "X-Scan-Cache-Age-Ms": String(ageMs ?? ""),
      },
    });
  }

  // Cold start: build synchronously
  const data = await buildScanResponse();
  lastGoodResponse = data;
  return NextResponse.json(data, { headers: { "X-Scan-Cache": "miss" } });
}
