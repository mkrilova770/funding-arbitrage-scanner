import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
} from "./types";
import { fetchWithDirectFirstThenProxyOnBlock } from "@/lib/exchanges/direct-then-proxy-fetch";

function parseBinanceFapiBases(): string[] {
  const raw = process.env.BINANCE_FAPI_BASES?.trim();
  if (raw) {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.replace(/\/+$/, "").trim())
      .filter(Boolean);
  }
  return [
    "https://fapi.binance.com",
    "https://fapi1.binance.com",
    "https://fapi2.binance.com",
    "https://fapi3.binance.com",
  ];
}

async function fetchPremiumIndexWithFallback(): Promise<Response> {
  const bases = parseBinanceFapiBases();
  let last: Response | null = null;
  for (const base of bases) {
    const url = `${base}/fapi/v1/premiumIndex`;
    const res = await fetchWithDirectFirstThenProxyOnBlock(url, {}, 15_000);
    last = res;
    if (res.ok) {
      if (base !== bases[0]) {
        console.log(`[Binance] premiumIndex OK via ${base}`);
      }
      return res;
    }
    const snippet = await res
      .clone()
      .text()
      .then((t) => t.slice(0, 400))
      .catch(() => "");
    console.error(
      `[Binance] premiumIndex failed: ${url} → HTTP ${res.status} ${res.statusText} bodySnippet=${JSON.stringify(snippet)}`
    );
  }
  const status = last?.status ?? 0;
  throw new Error(
    `Binance HTTP ${status} after ${bases.length} host(s) — set EXCHANGE_PROXY_URL or BINANCE_FAPI_BASES if blocked (451/403)`
  );
}

// Binance USDT-M perpetuals funding interval is 8 hours for most symbols.
// Some symbols may have 4h or 1h intervals — the premiumIndex endpoint does not
// expose the interval directly, so we default to 8h and override if needed.
const BINANCE_DEFAULT_INTERVAL_HOURS = 8;

interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  nextFundingTime: number; // ms
  interestRate: string;
  time: number;
}

export class BinanceAdapter implements ExchangeAdapter {
  name = "Binance";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const res = await fetchPremiumIndexWithFallback();
    const data: BinancePremiumIndex[] = await res.json();

    const result = new Map<string, FundingInfo>();
    for (const item of data) {
      if (!item.symbol.endsWith("USDT")) continue;
      const base = normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: parseFloat(item.lastFundingRate),
        markPrice: parseFloat(item.markPrice),
        nextFundingTime: item.nextFundingTime,
        intervalHours: BINANCE_DEFAULT_INTERVAL_HOURS,
        // Note: Binance introduced variable funding intervals (1h/4h) for some
        // symbols. The premiumIndex endpoint does not expose this directly.
        // For accuracy, cross-reference with /fapi/v1/fundingInfo if needed.
      });
    }
    return result;
  }
}
