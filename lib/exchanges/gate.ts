import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";
import { GateMarginPair, GateBorrowInfo } from "@/types";

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

interface GateEarnUniRate {
  currency: string; // e.g. "BTC"
  est_rate: string; // annual decimal, e.g. "0.034953"
}

interface GateEarnUniCurrency {
  currency: string; // e.g. "BTC"
  amount?: string; // not always present in API response
  lent_amount?: string; // not always present in API response
  frozen_amount?: string; // not always present in API response
}

interface GateMarginPairLiquidityRaw {
  base: string;
  quote: string;
  max_quote_amount?: string; // platform quote cap in USDT
  status: number;
}

/**
 * Fetch Gate isolated-margin borrow info per token.
 *
 * Public data source (fast, no auth):
 * - Borrow APR: GET /api/v4/earn/uni/rate (est_rate annual decimal)
 * - Liquidity:  GET /api/v4/earn/uni/currencies (available = amount - lent_amount - frozen_amount)
 * - Spot price: GET /api/v4/spot/tickers (for USDT conversion)
 */
export async function fetchGateBorrowInfo(
  tokens: string[]
): Promise<Map<string, GateBorrowInfo>> {
  const [ratesRes, currenciesRes, spotRes] = await Promise.allSettled([
    fetchWithTimeout("https://api.gateio.ws/api/v4/earn/uni/rate", {}, 15_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateEarnUniRate[]>) : ([] as GateEarnUniRate[]))
    ),
    fetchWithTimeout(
      "https://api.gateio.ws/api/v4/earn/uni/currencies",
      {},
      15_000
    ).then((r) =>
      r.ok ? (r.json() as Promise<GateEarnUniCurrency[]>) : ([] as GateEarnUniCurrency[])
    ),
    fetchWithTimeout("https://api.gateio.ws/api/v4/spot/tickers", {}, 15_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateSpotTicker[]>) : ([] as GateSpotTicker[]))
    ),
  ]);
  const marginPairsRes = await fetchWithTimeout(
    "https://api.gateio.ws/api/v4/margin/currency_pairs",
    {},
    15_000
  )
    .then((r) =>
      r.ok
        ? (r.json() as Promise<GateMarginPairLiquidityRaw[]>)
        : ([] as GateMarginPairLiquidityRaw[])
    )
    .catch(() => [] as GateMarginPairLiquidityRaw[]);

  const spotMap = new Map<string, number>();
  if (spotRes.status === "fulfilled") {
    for (const item of spotRes.value) {
      if (item.currency_pair.endsWith("_USDT")) {
        const base = item.currency_pair.replace("_USDT", "").toUpperCase();
        spotMap.set(base, parseFloat(item.last || "0"));
      }
    }
  }

  const aprMap = new Map<string, number>();
  if (ratesRes.status === "fulfilled") {
    for (const item of ratesRes.value) {
      const upper = (item.currency || "").toUpperCase();
      if (!upper) continue;
      const est = parseFloat(item.est_rate || "0");
      if (!Number.isFinite(est) || est <= 0) continue;
      aprMap.set(upper, est * 100);
    }
  }

  const availableTokenMap = new Map<string, number>();
  if (currenciesRes.status === "fulfilled") {
    for (const item of currenciesRes.value) {
      const upper = (item.currency || "").toUpperCase();
      if (!upper) continue;
      const amount = parseFloat(item.amount || "0");
      const lent = parseFloat(item.lent_amount || "0");
      const frozen = parseFloat(item.frozen_amount || "0");
      if (![amount, lent, frozen].every((n) => Number.isFinite(n))) continue;
      const available = amount - lent - frozen;
      if (Number.isFinite(available) && available >= 0) {
        availableTokenMap.set(upper, available);
      }
    }
  }

  // Public fallback for liquidity: margin pair quote cap (USDT).
  const maxQuoteUsdtMap = new Map<string, number>();
  for (const pair of marginPairsRes) {
    if (pair.quote !== "USDT" || pair.status !== 1) continue;
    const upper = (pair.base || "").toUpperCase();
    if (!upper) continue;
    const maxQ = parseFloat(pair.max_quote_amount || "0");
    if (Number.isFinite(maxQ) && maxQ > 0) {
      maxQuoteUsdtMap.set(upper, maxQ);
    }
  }

  const result = new Map<string, GateBorrowInfo>();
  for (const token of tokens) {
    const upper = token.toUpperCase();
    const spotPrice = spotMap.get(upper) ?? 0;
    let liquidityToken = availableTokenMap.get(upper) ?? null;
    let liquidityUsdt =
      liquidityToken != null && spotPrice > 0 ? liquidityToken * spotPrice : null;

    // If Earn Uni currencies lacks pool balance fields, fallback to public margin quote cap.
    if ((liquidityUsdt == null || liquidityUsdt <= 0) && maxQuoteUsdtMap.has(upper)) {
      liquidityUsdt = maxQuoteUsdtMap.get(upper) ?? null;
      if ((liquidityToken == null || liquidityToken <= 0) && liquidityUsdt != null && spotPrice > 0) {
        liquidityToken = liquidityUsdt / spotPrice;
      }
    }

    result.set(upper, {
      currency: upper,
      borrowAPR: aprMap.get(upper) ?? 0,
      liquidityToken,
      liquidityUsdt,
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
