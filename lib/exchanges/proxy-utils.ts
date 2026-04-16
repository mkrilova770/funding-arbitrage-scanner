/**
 * Accepts a full proxy URL (`http://user:pass@host:port`) or common provider form
 * `host:port:user:password` (password may contain `:`).
 */
export function normalizeOutboundProxyEnv(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (t.includes("://")) return t;
  const parts = t.split(":");
  if (parts.length >= 4) {
    const host = parts[0]!;
    const port = parts[1]!;
    const user = parts[2]!;
    const password = parts.slice(3).join(":");
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
  }
  return `http://${t}`;
}

/** Safe for logs — never print credentials. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    let normalized = proxyUrl.trim();
    if (!normalized.includes("://")) {
      normalized = normalizeOutboundProxyEnv(normalized);
    }
    const u = new URL(normalized);
    const host = u.hostname;
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${u.username ? "***@" : ""}${host}${port}`;
  } catch {
    return "(invalid proxy URL)";
  }
}

export function pickGlobalOutboundProxyUrl(): string | null {
  const candidates = [
    process.env.EXCHANGE_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
  ];
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return normalizeOutboundProxyEnv(t);
  }
  return null;
}

/** Dedicated proxy for Binance/Bybit (optional). Tried after direct on 403/451 before global. */
export function pickBinanceBybitDedicatedProxyUrl(): string | null {
  const t = process.env.EXCHANGE_BINANCE_BYBIT_PROXY_URL?.trim();
  return t ? normalizeOutboundProxyEnv(t) : null;
}
