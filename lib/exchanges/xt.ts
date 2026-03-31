import {
  ExchangeAdapter,
  FundingInfo,
  fetchWithTimeout,
} from "./types";

// XT.com perpetual futures — no bulk funding rate endpoint exists.
// Strategy: fetch all available symbols, intersect with filterTokens,
// then batch-fetch per-symbol funding rates in parallel.

interface XtSymbol {
  symbol: string; // "btc_usdt"
  baseCoin: string; // "btc"
  quoteCoin: string; // "usdt"
  contractType: string; // "PERPETUAL"
  tradeSwitch: boolean;
  isDisplay: boolean;
}

interface XtSymbolListResponse {
  returnCode: number;
  result: XtSymbol[];
}

interface XtFundingRateResult {
  symbol: string;
  fundingRate: number;
  nextCollectionTime: number; // ms
  collectionInternal: number; // interval in hours
}

interface XtFundingResponse {
  returnCode: number;
  msgInfo: string;
  result: XtFundingRateResult | null;
}

export class XtAdapter implements ExchangeAdapter {
  name = "XT";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    if (!filterTokens || filterTokens.size === 0) return new Map();

    // Step 1: Get all XT perpetual symbols
    const symbolsRes = await fetchWithTimeout(
      "https://fapi.xt.com/future/market/v1/public/symbol/list"
    );
    if (!symbolsRes.ok) throw new Error(`XT symbols HTTP ${symbolsRes.status}`);
    const symbolsData: XtSymbolListResponse = await symbolsRes.json();
    if (symbolsData.returnCode !== 0)
      throw new Error(`XT symbols error: ${symbolsData.returnCode}`);

    // Build token → XT symbol mapping for tokens we care about
    const tokenSymbolMap = new Map<string, string>();
    for (const s of symbolsData.result) {
      if (s.quoteCoin !== "usdt" || s.contractType !== "PERPETUAL") continue;
      if (!s.tradeSwitch) continue;
      const token = s.baseCoin.toUpperCase();
      if (!filterTokens.has(token)) continue;
      tokenSymbolMap.set(token, s.symbol);
    }

    if (tokenSymbolMap.size === 0) return new Map();

    // Step 2: Fetch all funding rates concurrently
    const result = new Map<string, FundingInfo>();
    const entries = Array.from(tokenSymbolMap.entries());

    const promises = entries.map(async ([token, xtSymbol]) => {
      try {
        const url = `https://fapi.xt.com/future/market/v1/public/q/funding-rate?symbol=${xtSymbol}`;
        const res = await fetchWithTimeout(url, {}, 6000);
        if (!res.ok) return null;
        const data: XtFundingResponse = await res.json();
        if (data.returnCode !== 0 || !data.result) return null;
        return { token, xtSymbol, data: data.result };
      } catch {
        return null;
      }
    });

    const allResults = await Promise.all(promises);
    for (const r of allResults) {
      if (!r) continue;
      result.set(r.token, {
        exchange: this.name,
        baseToken: r.token,
        originalSymbol: r.xtSymbol,
        rawFundingRate: r.data.fundingRate ?? 0,
        markPrice: 0,
        nextFundingTime: r.data.nextCollectionTime ?? 0,
        intervalHours: r.data.collectionInternal ?? 8,
      });
    }

    return result;
  }
}
