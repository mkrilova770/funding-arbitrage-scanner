import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";

// Bitget V2 USDT-margined futures
interface BitgetV2Ticker {
  symbol: string; // e.g. "BTCUSDT"
  lastPr: string;
  markPrice: string;
  fundingRate: string;
  ts: string; // ticker timestamp ms
  indexPrice: string;
}

interface BitgetV2Response {
  code: string;
  msg: string;
  data: BitgetV2Ticker[];
}

/**
 * Estimates next funding time for standard 8h intervals (00:00, 08:00, 16:00 UTC).
 * Used as fallback when exchange doesn't provide it directly.
 */
function nextFundingTime8h(): number {
  const now = Date.now();
  const d = new Date(now);
  const h = d.getUTCHours();
  const nextHour = h < 8 ? 8 : h < 16 ? 16 : 24;
  d.setUTCHours(nextHour === 24 ? 0 : nextHour, 0, 0, 0);
  if (nextHour === 24) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

export class BitgetAdapter implements ExchangeAdapter {
  name = "Bitget";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const url =
      "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Bitget HTTP ${res.status}`);
    const data: BitgetV2Response = await res.json();
    if (data.code !== "00000") throw new Error(`Bitget error: ${data.code}`);

    const result = new Map<string, FundingInfo>();
    for (const item of data.data) {
      if (!item.symbol.endsWith("USDT")) continue;
      const base = normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;
      if (!item.fundingRate) continue;

      // Bitget V2 tickers don't expose nextSettleTime; estimate from 8h cycle
      const nextFunding = nextFundingTime8h();

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: parseFloat(item.fundingRate),
        markPrice: parseFloat(item.markPrice || item.lastPr || "0"),
        nextFundingTime: nextFunding,
        intervalHours: 8,
      });
    }
    return result;
  }
}
