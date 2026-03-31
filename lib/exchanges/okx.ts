import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";

interface OkxInstrument {
  instId: string; // "BTC-USDT-SWAP"
  state: string; // "live"
}

interface OkxFundingRate {
  instId: string;
  fundingRate: string;
  nextFundingRate: string;
  nextFundingTime: string; // ms string
  fundingTime: string;
  method: string;
}

interface OkxFundingResponse {
  code: string;
  data: OkxFundingRate[];
}

interface OkxMarkPrice {
  instId: string;
  markPx: string;
}

// OKX requires per-symbol funding rate calls. We first fetch all USDT SWAP
// instruments, then batch funding rate calls for matched tokens.
export class OkxAdapter implements ExchangeAdapter {
  name = "OKX";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    // Step 1: fetch all perpetual USDT swap instruments
    const instrRes = await fetchWithTimeout(
      "https://www.okx.com/api/v5/public/instruments?instType=SWAP"
    );
    if (!instrRes.ok) throw new Error(`OKX instruments HTTP ${instrRes.status}`);
    const instrData = await instrRes.json();

    const usdtSwaps: OkxInstrument[] = (instrData.data || []).filter(
      (i: OkxInstrument) =>
        i.instId.endsWith("-USDT-SWAP") && i.state === "live"
    );

    // Filter to tokens we care about
    const targets: string[] = [];
    for (const instr of usdtSwaps) {
      const base = normalizeBaseToken(instr.instId);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;
      targets.push(instr.instId);
    }

    if (targets.length === 0) return new Map();

    // Step 2: batch ALL funding rate fetches at once (OKX limit: 20req/2s for public)
    // We run all requests concurrently with a semaphore-like approach
    const CONCURRENT = 30; // max concurrent requests
    const result = new Map<string, FundingInfo>();

    // Process all targets in parallel chunks
    for (let i = 0; i < targets.length; i += CONCURRENT) {
      const chunk = targets.slice(i, i + CONCURRENT);
      const promises = chunk.map(async (instId) => {
        try {
          const url = `https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`;
          const res = await fetchWithTimeout(url, {}, 6000);
          if (!res.ok) return null;
          const d: OkxFundingResponse = await res.json();
          if (d.code !== "0" || !d.data[0]) return null;
          return { instId, data: d.data[0] };
        } catch {
          return null;
        }
      });

      const results = await Promise.all(promises);
      for (const r of results) {
        if (!r) continue;
        const base = normalizeBaseToken(r.instId);
        if (!base) continue;
        const nextFunding = parseInt(r.data.nextFundingTime, 10);
        const nowMs = Date.now();
        const diffH = (nextFunding - nowMs) / 3600000;
        let intervalHours = 8;
        if (diffH <= 1.1) intervalHours = 1;
        else if (diffH <= 4.1) intervalHours = 4;

        result.set(base, {
          exchange: this.name,
          baseToken: base,
          originalSymbol: r.instId,
          rawFundingRate: parseFloat(r.data.fundingRate),
          markPrice: 0,
          nextFundingTime: nextFunding,
          intervalHours,
        });
      }

      if (i + CONCURRENT < targets.length) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    // Step 3: fetch mark prices for matched tokens
    await this.fillMarkPrices(result);

    return result;
  }

  private async fillMarkPrices(
    result: Map<string, FundingInfo>
  ): Promise<void> {
    if (result.size === 0) return;
    try {
      const res = await fetchWithTimeout(
        "https://www.okx.com/api/v5/public/mark-price?instType=SWAP"
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const item of data.data || []) {
        const mp = item as OkxMarkPrice;
        if (!mp.instId.endsWith("-USDT-SWAP")) continue;
        const base = normalizeBaseToken(mp.instId);
        if (!base) continue;
        const info = result.get(base);
        if (info) info.markPrice = parseFloat(mp.markPx);
      }
    } catch {
      // non-fatal
    }
  }
}
