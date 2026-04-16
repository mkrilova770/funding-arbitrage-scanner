import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
} from "./types";
import { fetchWithDirectFirstThenProxyOnBlock } from "@/lib/exchanges/direct-then-proxy-fetch";

function parseBybitApiBases(): string[] {
  const raw = process.env.BYBIT_API_BASES?.trim();
  if (raw) {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.replace(/\/+$/, "").trim())
      .filter(Boolean);
  }
  return ["https://api.bybit.com"];
}

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
    const bases = parseBybitApiBases();
    let lastRes: Response | null = null;
    let data: BybitResponse | null = null;

    for (const base of bases) {
      const url = `${base}/v5/market/tickers?category=linear`;
      const res = await fetchWithDirectFirstThenProxyOnBlock(url, {}, 15_000);
      lastRes = res;
      if (!res.ok) {
        const snippet = await res
          .clone()
          .text()
          .then((t) => t.slice(0, 400))
          .catch(() => "");
        console.error(
          `[Bybit] tickers failed: ${url} → HTTP ${res.status} ${res.statusText} bodySnippet=${JSON.stringify(snippet)}`
        );
        continue;
      }
      const parsed: BybitResponse = await res.json();
      if (parsed.retCode !== 0) {
        console.error(
          `[Bybit] tickers retCode=${parsed.retCode} url=${url} (try next base if configured)`
        );
        continue;
      }
      data = parsed;
      if (base !== bases[0]) {
        console.log(`[Bybit] tickers OK via ${base}`);
      }
      break;
    }

    if (!data) {
      const status = lastRes?.status ?? 0;
      throw new Error(
        `Bybit: no successful tickers response (tried ${bases.length} base(s); last HTTP ${status}). Set EXCHANGE_PROXY_URL or BYBIT_API_BASES if blocked`
      );
    }

    // Bybit also exposes fundingInterval via /v5/market/instruments-info
    // but the tickers endpoint does not include it. We use 8h as default
    // and detect 4h/1h via the known symbol list if needed.
    const result = new Map<string, FundingInfo>();
    for (const item of data.result.list) {
      if (!item.symbol.endsWith("USDT")) continue;
      if (!item.fundingRate) continue;
      const tokenBase = normalizeBaseToken(item.symbol);
      if (!tokenBase) continue;
      if (filterTokens && !filterTokens.has(tokenBase)) continue;

      const nextFunding = parseInt(item.nextFundingTime || "0", 10);
      // Bybit v5 tickers expose fundingIntervalHour directly
      let intervalHours = item.fundingIntervalHour
        ? parseInt(item.fundingIntervalHour, 10)
        : 8;
      if (![1, 2, 4, 8].includes(intervalHours)) intervalHours = 8;

      result.set(tokenBase, {
        exchange: this.name,
        baseToken: tokenBase,
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
