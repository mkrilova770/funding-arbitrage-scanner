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

let loggedBinanceBybitProxyOnce = false;

/**
 * Binance/Bybit: if EXCHANGE_BINANCE_BYBIT_PROXY_URL or EXCHANGE_PROXY_URL (or
 * HTTPS_PROXY/HTTP_PROXY) is set, all requests go through that proxy immediately.
 * Otherwise uses direct fetch with timeout.
 */
export async function fetchBinanceBybitWithProxyOrDirect(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const proxyUrl =
    pickBinanceBybitDedicatedProxyUrl() || pickGlobalOutboundProxyUrl();

  if (proxyUrl) {
    if (!loggedBinanceBybitProxyOnce) {
      loggedBinanceBybitProxyOnce = true;
      console.log(
        `[Binance/Bybit] using outbound proxy ${redactProxyUrl(proxyUrl)}`
      );
    }
    return fetchViaProxy(url, proxyUrl, init, timeoutMs);
  }

  const timeoutController = new AbortController();
  const id = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    const signal =
      mergeAbortSignals(init.signal, timeoutController.signal) ??
      timeoutController.signal;
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(id);
  }
}
