import {
  ExchangeAdapter,
  FundingInfo,
  fetchWithTimeout,
} from "./types";

// KuCoin futures uses "XBT" for Bitcoin; all others use standard naming.
// The contracts/active endpoint includes fundingFeeRate, markPrice, and
// nextFundingRateDateTime — no per-symbol calls needed.

const KUCOIN_BASE_MAP: Record<string, string> = {
  XBT: "BTC",
};

function kuCoinBaseToToken(base: string): string {
  const upper = base.toUpperCase();
  return KUCOIN_BASE_MAP[upper] ?? upper;
}

interface KuCoinContract {
  symbol: string; // "XBTUSDTM"
  baseCurrency: string; // "XBT"
  quoteCurrency: string; // "USDT"
  settleCurrency: string; // "USDT"
  status: string; // "Open"
  markPrice: number;
  fundingFeeRate: number; // current funding rate
  nextFundingRateDateTime: number; // ms
  fundingRateGranularity: number; // ms (e.g. 28800000 = 8h)
  type: string; // "FFWCSX" for perpetual swaps
}

interface KuCoinContractsResponse {
  code: string;
  data: KuCoinContract[];
}

export class KuCoinAdapter implements ExchangeAdapter {
  name = "KuCoin";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const res = await fetchWithTimeout(
      "https://api-futures.kucoin.com/api/v1/contracts/active"
    );
    if (!res.ok) throw new Error(`KuCoin HTTP ${res.status}`);
    const data: KuCoinContractsResponse = await res.json();
    if (data.code !== "200000") throw new Error(`KuCoin error: ${data.code}`);

    const result = new Map<string, FundingInfo>();

    for (const c of data.data) {
      // Only USDT-margined perpetual swaps (FFWCSX = funding fee weighted continuous swap)
      if (c.quoteCurrency !== "USDT" || c.settleCurrency !== "USDT") continue;
      if (c.status !== "Open") continue;
      // Exclude quarterly/bi-quarterly contracts
      if (c.type !== "FFWCSX") continue;

      const token = kuCoinBaseToToken(c.baseCurrency);
      if (filterTokens && !filterTokens.has(token)) continue;

      // fundingRateGranularity in ms → intervalHours
      const intervalHours = (c.fundingRateGranularity || 28800000) / 3600000;

      result.set(token, {
        exchange: this.name,
        baseToken: token,
        originalSymbol: c.symbol,
        rawFundingRate: c.fundingFeeRate ?? 0,
        markPrice: c.markPrice ?? 0,
        nextFundingTime: c.nextFundingRateDateTime ?? 0,
        intervalHours,
      });
    }

    return result;
  }
}
