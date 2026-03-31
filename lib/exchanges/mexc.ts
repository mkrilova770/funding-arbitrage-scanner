import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";

function nextFundingTime8h(intervalHours = 8): number {
  const now = Date.now();
  const d = new Date(now);
  const h = d.getUTCHours();
  const cycle = intervalHours;
  const nextH = Math.ceil((h + 0.01) / cycle) * cycle;
  d.setUTCHours(nextH % 24, 0, 0, 0);
  if (nextH >= 24) d.setUTCDate(d.getUTCDate() + Math.floor(nextH / 24));
  return d.getTime();
}

// MEXC contract (perpetual futures)
interface MexcFundingRate {
  symbol: string; // "BTC_USDT"
  fundingRate: number;
  nextSettleTime: number; // ms? check API
  // collectCycle is funding interval in hours per MEXC docs
}

interface MexcFundingResponse {
  success: boolean;
  code: number;
  data: {
    symbol: string;
    fundingRate: number;
    nextSettleTime: number;
    collectCycle: number; // interval hours
  };
}

interface MexcContractDetail {
  symbol: string;
  lastPrice: number;
  indexPrice: number;
  fairPrice: number;
  fundingRate: number;
  nextSettleTime?: number;
  collectCycle?: number; // funding interval hours, not always present in ticker
  timestamp?: number;
}

interface MexcContractsResponse {
  success: boolean;
  code: number;
  data: MexcContractDetail[];
}

export class MexcAdapter implements ExchangeAdapter {
  name = "MEXC";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    // MEXC provides a ticker endpoint for all contracts
    const url = "https://contract.mexc.com/api/v1/contract/ticker";
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`MEXC HTTP ${res.status}`);

    let tickers: MexcContractDetail[] = [];
    try {
      const data: MexcContractsResponse = await res.json();
      if (!data.success) throw new Error(`MEXC error code: ${data.code}`);
      tickers = data.data ?? [];
    } catch (e) {
      throw new Error(`MEXC parse error: ${e}`);
    }

    const result = new Map<string, FundingInfo>();
    for (const item of tickers) {
      if (!item.symbol?.endsWith("_USDT")) continue;
      const base = normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;
      if (item.fundingRate === undefined || item.fundingRate === null) continue;

      const intervalHours = item.collectCycle ?? 8;
      // MEXC ticker doesn't include nextSettleTime; calculate from 8h UTC cycle
      const nextFunding = item.nextSettleTime || nextFundingTime8h(intervalHours);

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: item.fundingRate,
        markPrice: item.fairPrice || item.lastPrice || 0,
        nextFundingTime: nextFunding,
        intervalHours,
      });
    }
    return result;
  }
}
