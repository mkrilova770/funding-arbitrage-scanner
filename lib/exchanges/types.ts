export interface FundingInfo {
  exchange: string;
  baseToken: string; // normalized, e.g. "BTC"
  originalSymbol: string; // as on exchange, e.g. "BTCUSDT"
  rawFundingRate: number; // decimal, e.g. 0.0001
  markPrice: number;
  nextFundingTime: number; // unix ms
  intervalHours: number; // 1 / 4 / 8
}

export interface ExchangeAdapter {
  name: string;
  /**
   * Fetches funding rates for all available USDT perpetuals.
   * Optionally filters to tokens in the provided set (for efficiency).
   * Returns a map: normalized base token → FundingInfo
   */
  fetchFunding(filterTokens?: Set<string>): Promise<Map<string, FundingInfo>>;
}

/**
 * Normalizes raw funding rate to annualized APR (%).
 * Formula: rawRate * (8760 / intervalHours) * 100
 * Example: 0.0001 every 8h → 0.0001 * (8760/8) * 100 = 10.95%
 */
export function toFundingAPR(rawRate: number, intervalHours: number): number {
  return rawRate * (8760 / intervalHours) * 100;
}

/**
 * Extracts base token from various exchange symbol formats.
 * Handles: BTCUSDT, BTC-USDT-SWAP, BTC_USDT, btc_usdt, XBTUSDTM, BTCUSDTM
 */
export function normalizeBaseToken(symbol: string): string | null {
  const s = symbol.toUpperCase().trim();

  // KuCoin special: XBTUSDTM → BTC
  if (s === "XBTUSDTM") return "BTC";
  // KuCoin: ETHUSDTM, SOLUSDT, etc.
  if (s.endsWith("USDTM")) return s.replace("USDTM", "");
  // OKX swap: BTC-USDT-SWAP
  if (s.endsWith("-USDT-SWAP")) return s.replace("-USDT-SWAP", "");
  // Underscore: BTC_USDT
  if (s.includes("_")) return s.split("_")[0];
  // Dash: BTC-USDT
  if (s.includes("-")) return s.split("-")[0];
  // Plain concat: BTCUSDT
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "");
  return null;
}

function pickOutboundProxyUrl(): string | null {
  const explicit =
    process.env.EXCHANGE_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim();
  return explicit || null;
}

/** Simple fetch with timeout */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const proxyUrl = pickOutboundProxyUrl();
  if (proxyUrl) {
    return await import("@/lib/outbound-fetch").then(({ fetchViaProxy }) =>
      fetchViaProxy(url, proxyUrl, options, timeoutMs)
    );
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
