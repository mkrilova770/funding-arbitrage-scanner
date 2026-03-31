import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";
import { GateMarginPair, GateBorrowInfo } from "@/types";
import { getGateRateCap } from "@/lib/gate-rate-cap";

// ─── Margin pairs ───────────────────────────────────────────────────────────

interface GateMarginPairRaw {
  id: string; // "BTC_USDT"
  base: string;
  quote: string;
  leverage: number;
  min_base_amount: string;
  min_quote_amount: string;
  max_quote_amount: string;
  status: number; // 1 = trading enabled
}

export async function fetchGateMarginPairs(): Promise<GateMarginPair[]> {
  const res = await fetchWithTimeout(
    "https://api.gateio.ws/api/v4/margin/currency_pairs"
  );
  if (!res.ok) throw new Error(`Gate margin pairs HTTP ${res.status}`);
  const data: GateMarginPairRaw[] = await res.json();

  return data
    .filter((p) => p.quote === "USDT" && p.status === 1)
    .map((p) => ({ id: p.id, base: p.base, quote: p.quote }));
}

// ─── Borrow rates & liquidity ────────────────────────────────────────────────

interface GateSpotTicker {
  currency_pair: string;
  last: string;
  lowest_ask: string;
  highest_bid: string;
}

/**
 * Fetch Gate isolated-margin borrow info per token.
 *
 * Borrow APR and available liquidity come from the Playwright scraper
 * (real VIP 0 values from the Gate isolated-margin rate-cap page).
 * Spot prices are still fetched from the public Gate API for spread calculation.
 */
export async function fetchGateBorrowInfo(
  tokens: string[]
): Promise<Map<string, GateBorrowInfo>> {
  const [rateCapResult, spotResult] = await Promise.allSettled([
    getGateRateCap(),
    fetchWithTimeout("https://api.gateio.ws/api/v4/spot/tickers").then((r) =>
      r.ok ? (r.json() as Promise<GateSpotTicker[]>) : ([] as GateSpotTicker[])
    ),
  ]);

  const spotMap = new Map<string, number>();
  if (spotResult.status === "fulfilled") {
    for (const item of spotResult.value) {
      if (item.currency_pair.endsWith("_USDT")) {
        const base = item.currency_pair.replace("_USDT", "").toUpperCase();
        spotMap.set(base, parseFloat(item.last || "0"));
      }
    }
  }

  const scraped =
    rateCapResult.status === "fulfilled"
      ? rateCapResult.value
      : new Map<string, import("@/lib/gate-rate-cap").GateRateCapEntry>();

  const result = new Map<string, GateBorrowInfo>();
  for (const token of tokens) {
    const upper = token.toUpperCase();
    const entry = scraped.get(upper);
    const spotPrice = spotMap.get(upper) ?? 0;

    result.set(upper, {
      currency: upper,
      borrowAPR: entry?.borrowApr ?? 0,
      liquidityToken: entry?.liquidityTokenRaw ?? null,
      liquidityUsdt: entry?.liquidityUsdtRaw ?? null,
      spotPrice,
    });
  }
  return result;
}

// ─── Gate futures funding (as one of the 10 exchanges) ──────────────────────

interface GateContract {
  name: string; // "BTC_USDT"
  mark_price: string;
  funding_rate: string; // current funding rate decimal
  funding_next_apply: number; // unix seconds
  funding_interval: number; // seconds (e.g. 28800 = 8h)
}

export class GateFuturesAdapter implements ExchangeAdapter {
  name = "Gate";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const res = await fetchWithTimeout(
      "https://fx-api.gateio.ws/api/v4/futures/usdt/contracts"
    );
    if (!res.ok) throw new Error(`Gate futures HTTP ${res.status}`);
    const data: GateContract[] = await res.json();

    const result = new Map<string, FundingInfo>();
    for (const item of data) {
      if (!item.name.endsWith("_USDT")) continue;
      const base = item.name.replace("_USDT", "").toUpperCase();
      if (filterTokens && !filterTokens.has(base)) continue;

      const intervalHours = (item.funding_interval || 28800) / 3600;

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.name,
        rawFundingRate: parseFloat(item.funding_rate || "0"),
        markPrice: parseFloat(item.mark_price || "0"),
        nextFundingTime: (item.funding_next_apply || 0) * 1000,
        intervalHours,
      });
    }
    return result;
  }
}

// Suppress unused import warning — normalizeBaseToken is re-exported from types
void normalizeBaseToken;
