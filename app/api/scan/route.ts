import { NextResponse } from "next/server";
import { GateFuturesAdapter } from "@/lib/exchanges/gate";
import { BinanceAdapter } from "@/lib/exchanges/binance";
import { OkxAdapter } from "@/lib/exchanges/okx";
import { BybitAdapter } from "@/lib/exchanges/bybit";
import {
  BitgetAdapter,
  fetchBitgetIsolatedMarginBases,
  fetchBitgetBorrowInfo,
} from "@/lib/exchanges/bitget";
import { BingXAdapter } from "@/lib/exchanges/bingx";
import { XtAdapter } from "@/lib/exchanges/xt";
import { MexcAdapter } from "@/lib/exchanges/mexc";
import { BitMartAdapter } from "@/lib/exchanges/bitmart";
import { KuCoinAdapter } from "@/lib/exchanges/kucoin";
import { ExchangeAdapter, toFundingAPR, FundingInfo } from "@/lib/exchanges/types";
import {
  ArbitrageRow,
  BitgetBorrowInfo,
  BitgetMarginPair,
  BitgetMarginSignedBlockReason,
  BitgetScanBorrowMeta,
  ScanResponse,
} from "@/types";

function bitgetBorrowMeta(
  isolatedMarginTokens: number,
  borrowMap: Map<string, BitgetBorrowInfo>,
  borrowFetchOk: boolean,
  signedBorrowConfigured: boolean,
  marginSignedBlocked: BitgetMarginSignedBlockReason | null,
  marginSignedProbeDetail: string
): BitgetScanBorrowMeta {
  let loansWithRateOrPool = 0;
  let utaBorrowLimits = 0;
  let isolatedPublicLimits = 0;
  let isolatedSignedLimits = 0;
  for (const v of borrowMap.values()) {
    if (v.borrowAPR > 0 || v.liquidityToken != null) loansWithRateOrPool++;
    if (v.liquiditySource === "uta-v3-public" && v.liquidityToken != null && v.liquidityToken > 0) {
      utaBorrowLimits++;
    }
    if (
      v.liquiditySource === "isolated-v1-public" &&
      v.liquidityToken != null &&
      v.liquidityToken > 0
    ) {
      isolatedPublicLimits++;
    }
    if (
      v.liquiditySource === "isolated-v2-private" &&
      v.liquidityToken != null &&
      v.liquidityToken > 0
    ) {
      isolatedSignedLimits++;
    }
  }
  return {
    source:
      signedBorrowConfigured && !marginSignedBlocked
        ? "isolated-v2-private+fallback"
        : "uta-v3-public",
    signedBorrowConfigured,
    marginSignedBlocked: marginSignedBlocked ?? undefined,
    marginSignedProbeDetail: marginSignedProbeDetail || undefined,
    isolatedMarginTokens,
    loansWithRateOrPool,
    isolatedSignedLimits,
    isolatedPublicLimits,
    utaBorrowLimits,
    borrowFetchOk,
  };
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Allow long first scan (Bitget × N + exchanges); Vercel / hosted limits may still apply. */
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
        bitgetBorrow: null,
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

export async function GET() {
  const upstream = await tryRespondWithUpstreamScanCopy();
  if (upstream) return upstream;

  const errors: Record<string, string> = {};
  const fetchedAt = Date.now();

  // Step 1: fetch Bitget isolated-margin USDT bases (base borrowable)
  let bitgetPairs: BitgetMarginPair[] = [];
  try {
    const pairs = await fetchBitgetIsolatedMarginBases();
    bitgetPairs = pairs;
  } catch (err) {
    errors["Bitget.MarginPairs"] = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        rows: [],
        fetchedAt,
        errors,
        bitgetBorrow: bitgetBorrowMeta(0, new Map(), false, false, null, ""),
      },
      { status: 200 }
    );
  }

  const bitgetTokens = bitgetPairs.map((p) => p.base.toUpperCase());
  const tokenSet = new Set(bitgetTokens);

  // Step 2: fetch borrow info + all exchange funding in parallel
  const [borrowResult, ...adapterResults] = await Promise.allSettled([
    fetchBitgetBorrowInfo(bitgetPairs),
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

  const borrowMap = new Map<string, BitgetBorrowInfo>();
  let signedBorrowConfigured = false;
  let marginSignedBlocked: BitgetMarginSignedBlockReason | null = null;
  let marginSignedProbeDetail = "";
  if (borrowResult.status === "fulfilled") {
    signedBorrowConfigured = borrowResult.value.signedBorrowConfigured;
    marginSignedBlocked = borrowResult.value.marginSignedBlocked;
    marginSignedProbeDetail = borrowResult.value.marginSignedProbeMsg;
    for (const [token, info] of borrowResult.value.borrowByToken.entries()) {
      borrowMap.set(token, info);
    }
    if (marginSignedBlocked === "no_margin_account") {
      errors["Bitget.MarginAccount"] =
        "Маржинальный счёт Bitget не открыт (ответ API: счёт маржи не существует). В приложении или на сайте Bitget активируйте маржинальную торговлю (изолированную margin). После этого перезапустите скан — иначе лимиты займа часто только из UTA и показываются как «без лимита».";
      if (marginSignedProbeDetail) {
        errors["Bitget.MarginAccount"] += ` Детали: ${marginSignedProbeDetail}.`;
      }
    } else if (marginSignedBlocked === "bad_auth") {
      errors["Bitget.ApiAuth"] =
        "Ошибка подписи Bitget (неверный API key, secret или passphrase в .env.local). Проверьте ключи и passphrase.";
      if (marginSignedProbeDetail) {
        errors["Bitget.ApiAuth"] += ` ${marginSignedProbeDetail}`;
      }
    }
  } else {
    errors["Bitget.Borrow"] =
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

  for (const token of bitgetTokens) {
    const borrow = borrowMap.get(token);
    const borrowAPR = borrow?.borrowAPR ?? 0;
    const spotPrice = borrow?.spotPrice ?? 0;
    const liquidityToken = borrow?.liquidityToken ?? null;
    const liquidityUsdt = borrow?.liquidityUsdt ?? null;
    const borrowPoolFromUta =
      liquidityToken != null &&
      liquidityToken > 0;

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
        borrowPoolFromUta,
        nextFundingTime: funding.nextFundingTime,
        updatedAt: fetchedAt,
      });
    }
  }

  // Sort by netAPR descending by default
  rows.sort((a, b) => b.netAPR - a.netAPR);

  const response: ScanResponse = {
    rows,
    fetchedAt,
    errors,
    bitgetBorrow: bitgetBorrowMeta(
      bitgetTokens.length,
      borrowMap,
      borrowResult.status === "fulfilled",
      signedBorrowConfigured,
      marginSignedBlocked,
      marginSignedProbeDetail
    ),
  };
  return NextResponse.json(response);
}
