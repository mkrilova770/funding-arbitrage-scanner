import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  toFundingAPR,
  fetchWithTimeout,
} from "./types";

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
    const url = "https://fapi.binance.com/fapi/v1/premiumIndex";
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
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
