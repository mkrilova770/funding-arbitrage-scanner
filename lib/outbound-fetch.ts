import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";

let cachedAgent: HttpsProxyAgent<string> | null | undefined;

function getProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  if (cachedAgent === undefined) {
    cachedAgent = new HttpsProxyAgent(proxyUrl);
  }
  return cachedAgent;
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
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
 * Fetch via HTTP(S) CONNECT proxy (common for cloud/datacenter egress blocks).
 * Uses Node core http/https (works in Next.js route handlers).
 */
export async function fetchViaProxy(
  url: string,
  proxyUrl: string,
  init: RequestInit = {},
  timeoutMs: number
): Promise<Response> {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const method = (init.method ?? "GET").toUpperCase();
  const headers: http.OutgoingHttpHeaders = {};

  if (init.headers) {
    const h = new Headers(init.headers as HeadersInit);
    h.forEach((value, key) => {
      headers[key] = value;
    });
  }

  const timeoutController = new AbortController();
  const mergedSignal = mergeSignals(init.signal, timeoutController.signal);
  const agent = getProxyAgent(proxyUrl);

  return await new Promise<Response>((resolve, reject) => {
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent,
        signal: mergedSignal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            if (Array.isArray(v)) {
              for (const item of v) responseHeaders.append(k, item);
            } else {
              responseHeaders.set(k, v);
            }
          }
          resolve(
            new Response(body, {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            })
          );
        });
      }
    );

    const id = setTimeout(() => {
      timeoutController.abort();
      req.destroy(new Error(`Proxy fetch timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(id);
      reject(err);
    });
    req.on("close", () => clearTimeout(id));

    const body = init.body;
    if (body != null) {
      if (typeof body === "string" || body instanceof Uint8Array) {
        req.end(body);
      } else {
        reject(new Error("Unsupported fetch body type for proxy mode"));
      }
    } else {
      req.end();
    }
  });
}
