/** Safe for logs — never print credentials. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const normalized = proxyUrl.includes("://")
      ? proxyUrl
      : `http://${proxyUrl}`;
    const u = new URL(normalized);
    const host = u.hostname;
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${u.username ? "***@" : ""}${host}${port}`;
  } catch {
    return "(invalid proxy URL)";
  }
}

export function pickGlobalOutboundProxyUrl(): string | null {
  const explicit =
    process.env.EXCHANGE_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim();
  return explicit || null;
}

/** Dedicated proxy for Binance/Bybit (optional). Tried after direct on 403/451 before global. */
export function pickBinanceBybitDedicatedProxyUrl(): string | null {
  return process.env.EXCHANGE_BINANCE_BYBIT_PROXY_URL?.trim() || null;
}
