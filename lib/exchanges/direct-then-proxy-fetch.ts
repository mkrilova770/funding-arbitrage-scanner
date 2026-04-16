import { fetchViaProxy } from "@/lib/outbound-fetch";
import {
  pickBinanceBybitDedicatedProxyUrl,
  pickGlobalOutboundProxyUrl,
  redactProxyUrl,
} from "@/lib/exchanges/proxy-utils";

function mergeAbortSignals(
  a?: AbortSignal | null,
  b?: AbortSignal | null
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (!a) return b ?? undefined;
  if (!b) return a ?? undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/**
 * Binance/Bybit: try direct egress first (so Gate etc. can stay unproxied when only
 * EXCHANGE_BINANCE_BYBIT_PROXY_URL is set). On HTTP 403/451, retry via dedicated
 * proxy, then global EXCHANGE_PROXY_URL / HTTPS_PROXY / HTTP_PROXY.
 */
export async function fetchWithDirectFirstThenProxyOnBlock(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const timeoutController = new AbortController();
  const id = setTimeout(() => timeoutController.abort(), timeoutMs);
  let directRes: Response;
  try {
    const signal =
      mergeAbortSignals(init.signal, timeoutController.signal) ??
      timeoutController.signal;
    directRes = await fetch(url, {
      ...init,
      signal,
    });
  } finally {
    clearTimeout(id);
  }

  if (directRes.ok) return directRes;

  const blocked = directRes.status === 403 || directRes.status === 451;
  if (!blocked) return directRes;

  const dedicated = pickBinanceBybitDedicatedProxyUrl();
  const globalP = pickGlobalOutboundProxyUrl();
  const proxyOrder = [dedicated, globalP].filter(
    (p, i, a): p is string => Boolean(p) && a.indexOf(p) === i
  );

  if (proxyOrder.length === 0) {
    console.warn(
      `[exchange-fetch] ${url} → HTTP ${directRes.status} (direct). Set EXCHANGE_BINANCE_BYBIT_PROXY_URL or EXCHANGE_PROXY_URL (http://USER:PASS@HOST:PORT) on Railway.`
    );
    return directRes;
  }

  let lastProxied: Response | null = null;
  for (const proxyUrl of proxyOrder) {
    console.warn(
      `[exchange-fetch] ${url} → HTTP ${directRes.status} (direct), retry via proxy ${redactProxyUrl(proxyUrl)}`
    );
    try {
      const proxied = await fetchViaProxy(url, proxyUrl, init, timeoutMs);
      lastProxied = proxied;
      if (proxied.ok) return proxied;
      if (proxied.status !== 403 && proxied.status !== 451) return proxied;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[exchange-fetch] proxy retry failed: ${msg}`);
    }
  }

  return lastProxied ?? directRes;
}
