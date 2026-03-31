import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";

// BingX perpetual swap
// API returns data as a flat array (not nested under premiumIndex)
interface BingXItem {
  symbol: string; // "BTC-USDT"
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number; // ms
  fundingIntervalHours: number; // 1 / 4 / 8 per symbol
}

interface BingXResponse {
  code: number;
  msg: string;
  data: BingXItem[];
}

export class BingXAdapter implements ExchangeAdapter {
  name = "BingX";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const url =
      "https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex";
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`BingX HTTP ${res.status}`);
    const data: BingXResponse = await res.json();
    if (data.code !== 0) throw new Error(`BingX error: ${data.code}`);

    const items = data.data ?? [];
    const result = new Map<string, FundingInfo>();

    for (const item of items) {
      if (!item.symbol?.endsWith("-USDT")) continue;
      const base = normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;
      if (!item.lastFundingRate) continue;

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: parseFloat(item.lastFundingRate),
        markPrice: parseFloat(item.markPrice || "0"),
        nextFundingTime: item.nextFundingTime || 0,
        intervalHours: item.fundingIntervalHours ?? 8,
      });
    }
    return result;
  }
}
