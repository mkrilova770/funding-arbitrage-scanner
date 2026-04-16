import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";

interface BybitTicker {
  symbol: string;
  fundingRate: string;
  nextFundingTime: string; // ms as string
  markPrice: string;
  fundingIntervalHour?: string; // Bybit v5 returns this directly
  fundingRateTimestamp?: string;
}

interface BybitResponse {
  retCode: number;
  result: {
    list: BybitTicker[];
  };
}

export class BybitAdapter implements ExchangeAdapter {
  name = "Bybit";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const url =
      "https://api.bybit.com/v5/market/tickers?category=linear";
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data: BybitResponse = await res.json();

    if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retCode}`);

    // Bybit also exposes fundingInterval via /v5/market/instruments-info
    // but the tickers endpoint does not include it. We use 8h as default
    // and detect 4h/1h via the known symbol list if needed.
    const result = new Map<string, FundingInfo>();
    for (const item of data.result.list) {
      if (!item.symbol.endsWith("USDT")) continue;
      if (!item.fundingRate) continue;
      const base = normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;

      const nextFunding = parseInt(item.nextFundingTime || "0", 10);
      // Bybit v5 tickers expose fundingIntervalHour directly
      let intervalHours = item.fundingIntervalHour
        ? parseInt(item.fundingIntervalHour, 10)
        : 8;
      if (![1, 2, 4, 8].includes(intervalHours)) intervalHours = 8;

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: parseFloat(item.fundingRate),
        markPrice: parseFloat(item.markPrice || "0"),
        nextFundingTime: nextFunding,
        intervalHours,
      });
    }
    return result;
  }
}
