import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";

// BitMart futures — bulk endpoint returns all symbols with funding rates
interface BitMartSymbol {
  symbol: string; // "BTCUSDT"
  base_currency: string;
  quote_currency: string;
  last_price: string;
  index_price: string;
  funding_rate: string;
  expected_funding_rate: string;
  funding_time: number; // next funding time ms
  funding_interval_hours: number; // 8 for most
  status: string; // "Trading"
}

interface BitMartDetailsResponse {
  code: number;
  message: string;
  data: {
    symbols: BitMartSymbol[];
  };
}

interface BitMartFundingResponse {
  code: number;
  message: string;
  data: {
    symbol: string;
    rate_value: string;
    expected_rate: string;
    funding_time: number;
  };
}

export class BitMartAdapter implements ExchangeAdapter {
  name = "BitMart";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const res = await fetchWithTimeout(
      "https://api-cloud-v2.bitmart.com/contract/public/details"
    );
    if (!res.ok) throw new Error(`BitMart HTTP ${res.status}`);
    const data: BitMartDetailsResponse = await res.json();
    if (data.code !== 1000) throw new Error(`BitMart error: ${data.code}`);

    const symbols = data.data?.symbols ?? [];
    const result = new Map<string, FundingInfo>();

    for (const item of symbols) {
      if (item.quote_currency !== "USDT") continue;
      if (item.status !== "Trading") continue;
      const base = item.base_currency?.toUpperCase() ?? normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;
      if (!item.funding_rate) continue;

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: parseFloat(item.funding_rate),
        markPrice: parseFloat(item.last_price || item.index_price || "0"),
        nextFundingTime: item.funding_time ?? 0,
        intervalHours: item.funding_interval_hours ?? 8,
      });
    }
    return result;
  }
}
