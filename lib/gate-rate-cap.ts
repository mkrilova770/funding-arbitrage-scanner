/**
 * Gate isolated margin rate cap data.
 *
 * PRIMARY: Playwright scraper on the Gate rate-cap page (real VIP 0 borrow APR
 *          and actual available pool liquidity).
 * AUTH FALLBACK: Gate API key + /margin/uni/borrowable (requires GATE_API_KEY /
 *          GATE_API_SECRET in .env.local). Returns real pool available amounts.
 * RATE FALLBACK: earn/uni/rate API with the correct VIP 0 service-fee multiplier
 *          (~1.686×) derived from real page observation. No liquidity data.
 *
 * Playwright geo-block fix: set PLAYWRIGHT_PROXY_SERVER=socks5://host:port
 * (optionally PLAYWRIGHT_PROXY_USER / PLAYWRIGHT_PROXY_PASS) in .env.local.
 *
 * Cache TTL: 5 minutes.
 */

import { chromium } from "playwright";
import * as crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GateRateCapEntry {
  token: string;
  borrowApr: number | null;         // VIP 0 annual borrow APR %
  liquidityTokenRaw: number | null; // available native tokens (e.g. 2620 BTC)
  liquidityUsdtRaw: number | null;  // available USDT equivalent (e.g. 177_090_000)
  source: "scrape" | "api-fallback";
  scrapedAt: number;
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — scraping all pages is expensive

interface Cache {
  data: Map<string, GateRateCapEntry>;
  fetchedAt: number;
  source: "scrape" | "api-fallback";
}

let cache: Cache | null = null;
let scrapeInProgress: Promise<Map<string, GateRateCapEntry>> | null = null;

// VIP 0 page candidates (try each in order)
const PAGE_URLS = [
  "https://www.gate.io/trade/introduction/margin-trading/rate-cap/isolated-margin-limit?vip=0",
  "https://www.gate.com/en/trade/introduction/margin-trading/rate-cap/isolated-margin-limit?vip=0",
  "https://www.gate.com/ru/trade/introduction/margin-trading/rate-cap/isolated-margin-limit?vip=0",
];

// VIP 0 borrow service-fee multiplier observed from real page data:
// SKL: est_rate=3.4953 annual → page shows 589.19% → 589.19 / 349.53 = 1.686
const VIP0_MULTIPLIER = 1.686;

// ── Number parser ────────────────────────────────────────────────────────────

export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\s/g, "").replace(",", ".");
  let multiplier = 1;
  const upper = s.toUpperCase();
  if (upper.endsWith("B")) { multiplier = 1_000_000_000; s = s.slice(0, -1); }
  else if (upper.endsWith("M")) { multiplier = 1_000_000;     s = s.slice(0, -1); }
  else if (upper.endsWith("K")) { multiplier = 1_000;          s = s.slice(0, -1); }
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return n * multiplier;
}

function parseBorrowApr(raw: string): number | null {
  if (!raw) return null;
  const parts = raw.trim().split("/");
  const annualPart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const cleaned = annualPart.replace(/%/g, "").replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return n;
}

// ── API fallback ─────────────────────────────────────────────────────────────

interface GateUniRate { currency: string; est_rate: string; }
interface GateUniCurrency {
  currency: string;
  available_lend_amount: string; // currently available in pool (native token units)
  max_lend_amount: string;
}
interface GateSpotTickerFallback { currency_pair: string; last: string; }

async function fetchFallback(): Promise<Map<string, GateRateCapEntry>> {
  console.log("[gate-rate-cap] Using API fallback (earn/uni/rate × VIP0_MULTIPLIER)");
  const now = Date.now();
  const result = new Map<string, GateRateCapEntry>();

  const [ratesRes, currRes, spotRes] = await Promise.allSettled([
    fetch("https://api.gateio.ws/api/v4/earn/uni/rate", { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.ok ? (r.json() as Promise<GateUniRate[]>) : ([] as GateUniRate[])),
    fetch("https://api.gateio.ws/api/v4/earn/uni/currencies", { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.ok ? (r.json() as Promise<GateUniCurrency[]>) : ([] as GateUniCurrency[])),
    fetch("https://api.gateio.ws/api/v4/spot/tickers", { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.ok ? (r.json() as Promise<GateSpotTickerFallback[]>) : ([] as GateSpotTickerFallback[])),
  ]);

  // available_lend_amount = currently available in the lending pool (native token units)
  const availMap = new Map<string, number>();
  if (currRes.status === "fulfilled") {
    for (const item of currRes.value) {
      const v = parseFloat(item.available_lend_amount || "0");
      if (v > 0) availMap.set(item.currency.toUpperCase(), v);
    }
  }

  // spot prices for converting native token → USDT
  const spotMap = new Map<string, number>();
  if (spotRes.status === "fulfilled") {
    for (const item of spotRes.value) {
      if (item.currency_pair.endsWith("_USDT")) {
        const base = item.currency_pair.replace("_USDT", "").toUpperCase();
        const price = parseFloat(item.last || "0");
        if (price > 0) spotMap.set(base, price);
      }
    }
  }

  if (ratesRes.status === "fulfilled") {
    for (const item of ratesRes.value) {
      const upper = item.currency.toUpperCase();
      const borrowApr = parseFloat(item.est_rate) * VIP0_MULTIPLIER * 100;
      const liquidityTokenRaw = availMap.get(upper) ?? null;
      const spotPrice = spotMap.get(upper) ?? 0;
      const liquidityUsdtRaw =
        liquidityTokenRaw != null && spotPrice > 0
          ? liquidityTokenRaw * spotPrice
          : null;
      result.set(upper, {
        token: upper,
        borrowApr,
        liquidityTokenRaw,
        liquidityUsdtRaw,
        source: "api-fallback",
        scrapedAt: now,
      });
    }
  }

  console.log(`[gate-rate-cap] Fallback: ${result.size} tokens loaded`);
  return result;
}

// ── Gate authenticated borrowable API ────────────────────────────────────────

/**
 * Calls GET /margin/uni/borrowable for each currency pair using Gate API keys.
 * Returns token → available-USDT-equivalent map.
 * Requires GATE_API_KEY + GATE_API_SECRET in environment.
 */
async function fetchBorrowableViaApi(
  tokens: string[]
): Promise<Map<string, { liquidityTokenRaw: number | null; liquidityUsdtRaw: number | null }>> {
  const apiKey = process.env.GATE_API_KEY;
  const apiSecret = process.env.GATE_API_SECRET;
  if (!apiKey || !apiSecret) return new Map();

  console.log(`[gate-rate-cap] Fetching borrowable via Gate API for ${tokens.length} tokens`);
  const result = new Map<string, { liquidityTokenRaw: number | null; liquidityUsdtRaw: number | null }>();

  // Fetch spot prices for USDT conversion
  let spotMap = new Map<string, number>();
  try {
    const tickers: Array<{ currency_pair: string; last: string }> = await fetch(
      "https://api.gateio.ws/api/v4/spot/tickers",
      { signal: AbortSignal.timeout(10_000) }
    ).then((r) => (r.ok ? r.json() : []));
    for (const t of tickers) {
      if (t.currency_pair.endsWith("_USDT")) {
        spotMap.set(t.currency_pair.replace("_USDT", "").toUpperCase(), parseFloat(t.last || "0"));
      }
    }
  } catch { /* ignore */ }

  // Gate API v4 HMAC-SHA512 signature
  function sign(method: string, path: string, query: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const bodyHash = crypto.createHash("sha512").update("").digest("hex");
    const payload = `${method}\n${path}\n${query}\n${bodyHash}\n${ts}`;
    const sig = crypto.createHmac("sha512", apiSecret!).update(payload).digest("hex");
    return { KEY: apiKey!, Timestamp: ts, SIGN: sig };
  }

  // Batch: 10 concurrent calls max to avoid rate limiting
  const CONCURRENCY = 10;
  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const batch = tokens.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (token) => {
        const upper = token.toUpperCase();
        const pair = `${upper}_USDT`;
        const query = `currency=${upper}&currency_pair=${pair}`;
        const headers = sign("GET", "/api/v4/margin/uni/borrowable", query);
        try {
          const res = await fetch(
            `https://api.gateio.ws/api/v4/margin/uni/borrowable?${query}`,
            { headers, signal: AbortSignal.timeout(8_000) }
          );
          if (!res.ok) return;
          const data: { currency: string; borrowable: string } = await res.json();
          const borrowableTokens = parseFloat(data.borrowable || "0");
          if (isNaN(borrowableTokens) || borrowableTokens <= 0) return;
          const spotPrice = spotMap.get(upper) ?? 0;
          result.set(upper, {
            liquidityTokenRaw: borrowableTokens,
            liquidityUsdtRaw: spotPrice > 0 ? borrowableTokens * spotPrice : null,
          });
        } catch { /* ignore per-token errors */ }
      })
    );
  }

  console.log(`[gate-rate-cap] Borrowable API: ${result.size} tokens fetched`);
  return result;
}

// ── Playwright scraper ───────────────────────────────────────────────────────

async function scrapeRateCap(): Promise<Map<string, GateRateCapEntry>> {
  console.log("[gate-rate-cap] Starting Playwright scrape…");
  const now = Date.now();
  const result = new Map<string, GateRateCapEntry>();

  const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER;
  const launchOptions: Parameters<typeof chromium.launch>[0] = { headless: true };
  if (proxyServer) {
    launchOptions.proxy = {
      server: proxyServer,
      ...(process.env.PLAYWRIGHT_PROXY_USER && { username: process.env.PLAYWRIGHT_PROXY_USER }),
      ...(process.env.PLAYWRIGHT_PROXY_PASS && { password: process.env.PLAYWRIGHT_PROXY_PASS }),
    };
    console.log(`[gate-rate-cap] Using proxy: ${proxyServer}`);
  }

  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Try each URL until one loads the rate-cap table
    let foundUrl = "";
    for (const url of PAGE_URLS) {
      console.log(`[gate-rate-cap] Trying URL: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(5_000);

      // Check if we got the compliance redirect
      const currentUrl = page.url();
      const html = await page.content();
      if (currentUrl.includes("state_compliance") || html.includes("state_compliance")) {
        console.log(`[gate-rate-cap] URL blocked (compliance redirect): ${url}`);
        continue;
      }

      foundUrl = url;
      break;
    }

    if (!foundUrl) {
      throw new Error("All Gate page URLs are geo-blocked; using API fallback");
    }

    // Try multiple possible selectors for table rows
    const SELECTORS = [
      "table tbody tr",
      ".ant-table-tbody tr",
      "[class*='table'] tr",
      "[class*='TableBody'] tr",
      "[class*='tbody'] tr",
      "tr[class*='row']",
      "tr",
    ];

    let foundSelector = "";
    for (const sel of SELECTORS) {
      const count = await page.locator(sel).count();
      if (count > 2) {
        foundSelector = sel;
        console.log(`[gate-rate-cap] Using selector "${sel}" (${count} elements)`);
        break;
      }
    }

    if (!foundSelector) {
      const html = await page.content();
      console.log("[gate-rate-cap] Page HTML sample:", html.slice(0, 1000));
      throw new Error("No table rows found on Gate rate-cap page");
    }

    await page.waitForTimeout(2_000);

    // ── Row extractor (runs inside browser context) ───────────────────────────
    type ScrapedRow = { pair: string; rateCellText: string; availCellText: string };
    const extractRows = async (): Promise<ScrapedRow[]> =>
      page.evaluate((selector: string): ScrapedRow[] => {
        const allRows = document.querySelectorAll(selector);
        const result: ScrapedRow[] = [];
        for (const tr of allRows) {
          const cells = Array.from(tr.querySelectorAll("td"));
          if (cells.length < 3) continue;
          const allCells = cells.map((c) => (c as HTMLElement).innerText?.trim() ?? "");
          const pair = allCells[0] ?? "";
          let rateCellText = "";
          let availCellText = "";
          for (const text of allCells) {
            if (!rateCellText && /%/.test(text) && text.length < 100) rateCellText = text;
            if (!availCellText && /≈/.test(text)) availCellText = text;
          }
          if (pair) result.push({ pair, rateCellText, availCellText });
        }
        return result;
      }, foundSelector);

    // ── Parse helper (same logic for each page) ───────────────────────────────
    const parseRows = (rows: ScrapedRow[]) => {
      for (const row of rows) {
        const base = row.pair.includes("/")
          ? row.pair.split("/")[0].trim().toUpperCase()
          : row.pair.trim().toUpperCase();
        if (!base || base === "USDT") continue;

        const borrowApr = parseBorrowApr(row.rateCellText);
        let liquidityTokenRaw: number | null = null;
        let liquidityUsdtRaw: number | null = null;

        if (row.availCellText) {
          const splitOnApprox = row.availCellText.split("≈");
          if (splitOnApprox.length >= 2) {
            liquidityTokenRaw = parseAmount(splitOnApprox[0].replace(/\n/g, "").trim());
            // Take only the part before the next newline to avoid double-suffix issue
            const usdtRaw = splitOnApprox[1].split("\n")[0].replace(/USDT/gi, "").trim();
            liquidityUsdtRaw = parseAmount(usdtRaw);
          } else {
            liquidityTokenRaw = parseAmount(row.availCellText.trim());
          }
        }

        result.set(base, {
          token: base,
          borrowApr,
          liquidityTokenRaw,
          liquidityUsdtRaw,
          source: "scrape",
          scrapedAt: now,
        });
      }
    };

    // ── Page 1 ────────────────────────────────────────────────────────────────
    const page1Rows = await extractRows();
    console.log(`[gate-rate-cap] Page 1: ${page1Rows.length} rows`);
    if (page1Rows.length > 0) {
      console.log("[gate-rate-cap] First row sample:", JSON.stringify(page1Rows[0]));
    }
    parseRows(page1Rows);

    // ── Remaining pages — click "→ next" until disabled ─────────────────────
    // Simple loop: get "disabled" HTML attribute on the last pagination button.
    // On the last page Gate/Mantine sets the disabled attribute on that button.
    // We do NOT rely on totalPages (the visible page numbers are truncated and
    // may not reflect the actual last page).
    const PAGE_BTN_SEL = ".mantine-GatePagination-item, .mantine-Pagination-item";
    const MAX_PAGES = 300;
    let pageNum = 2;
    let consecutiveEmpty = 0;
    let lastFirstPair = "";

    while (pageNum <= MAX_PAGES) {
      await page.waitForTimeout(400);

      // Read "disabled" attribute — returns "" or value if present, null if absent.
      // Also log button texts on first few pages for diagnostics.
      const nextBtn = page.locator(PAGE_BTN_SEL).last();
      const disabledAttr = await nextBtn.getAttribute("disabled").catch(() => "err");

      if (pageNum <= 3) {
        const allTexts = await page.locator(PAGE_BTN_SEL).allInnerTexts().catch(() => [] as string[]);
        console.log(`[gate-rate-cap] Page ${pageNum - 1} pagination buttons: ${JSON.stringify(allTexts)}`);
      }

      if (disabledAttr !== null) {
        console.log(`[gate-rate-cap] Next button disabled at page ${pageNum - 1} (attr="${disabledAttr}")`);
        break;
      }

      await nextBtn.click().catch(() => null);
      await page.waitForTimeout(1_500);

      const pageRows = await extractRows();

      // Detect stuck pagination: same first row as previous page → already on last page
      const firstPair = pageRows[0]?.pair ?? "";
      if (firstPair && firstPair === lastFirstPair) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          console.log(`[gate-rate-cap] Pagination stuck at page ${pageNum - 1}, stopping`);
          break;
        }
        continue;
      }
      consecutiveEmpty = 0;
      lastFirstPair = firstPair;

      if (pageRows.length === 0) break;
      parseRows(pageRows);
      pageNum++;
    }
    console.log(`[gate-rate-cap] Pagination done: ${pageNum - 1} pages`);

    console.log(`[gate-rate-cap] Scrape OK: ${result.size} tokens (${pageNum - 1} pages)`);
  } finally {
    await browser.close();
  }

  // If scrape returned 0 results, use full fallback
  if (result.size === 0) {
    console.log("[gate-rate-cap] Scrape returned 0 tokens, using fallback");
    return apiFallbackWithBorrowable();
  }

  // ── Hybrid merge: fill in tokens NOT found on the rate-cap page ───────────
  // Some tokens exist in earn/uni/currencies (API fallback) but not on the
  // rate-cap page (or were missed by pagination). Merge them so that no data
  // disappears compared to the pre-Playwright API-only state.
  try {
    const apiData = await fetchFallback();
    let added = 0;
    for (const [token, entry] of apiData.entries()) {
      if (!result.has(token)) {
        result.set(token, entry);
        added++;
      }
    }
    if (added > 0) {
      console.log(`[gate-rate-cap] Hybrid merge: added ${added} tokens from API fallback (not on rate-cap page)`);
    }
  } catch (err) {
    console.warn("[gate-rate-cap] Hybrid merge fallback failed:", err);
  }

  return result;
}

// ── Combined fallback: rate API + optional borrowable API ────────────────────

async function apiFallbackWithBorrowable(): Promise<Map<string, GateRateCapEntry>> {
  const base = await fetchFallback();

  // If Gate API keys are configured, overlay real borrowable amounts
  if (process.env.GATE_API_KEY && process.env.GATE_API_SECRET) {
    try {
      const tokens = [...base.keys()];
      const borrowable = await fetchBorrowableViaApi(tokens);
      for (const [token, liq] of borrowable.entries()) {
        const entry = base.get(token);
        if (entry) {
          entry.liquidityTokenRaw = liq.liquidityTokenRaw;
          entry.liquidityUsdtRaw = liq.liquidityUsdtRaw;
        }
      }
      console.log(`[gate-rate-cap] Overlaid borrowable data for ${borrowable.size} tokens`);
    } catch (err) {
      console.warn("[gate-rate-cap] Borrowable API failed:", err);
    }
  } else {
    console.log("[gate-rate-cap] No GATE_API_KEY configured – liquidity data unavailable");
    console.log("[gate-rate-cap] To enable: add GATE_API_KEY + GATE_API_SECRET to .env.local");
    console.log("[gate-rate-cap] To fix geo-block: add PLAYWRIGHT_PROXY_SERVER=socks5://host:port to .env.local");
  }

  return base;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getGateRateCap(): Promise<Map<string, GateRateCapEntry>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!scrapeInProgress) {
    scrapeInProgress = scrapeRateCap()
      .then((data) => {
        const src = [...data.values()][0]?.source ?? "api-fallback";
        cache = { data, fetchedAt: Date.now(), source: src };
        scrapeInProgress = null;
        return data;
      })
      .catch(async (err) => {
        console.error("[gate-rate-cap] Scrape error, using fallback:", err?.message ?? err);
        scrapeInProgress = null;
        try {
          const fallback = await apiFallbackWithBorrowable();
          cache = { data: fallback, fetchedAt: Date.now(), source: "api-fallback" };
          return fallback;
        } catch (fallbackErr) {
          console.error("[gate-rate-cap] Fallback also failed:", fallbackErr);
          return cache?.data ?? new Map<string, GateRateCapEntry>();
        }
      });
  }

  return scrapeInProgress;
}

export function getRateCapCacheInfo(): {
  size: number;
  fetchedAt: number | null;
  ageMs: number | null;
  source: string | null;
} {
  return {
    size: cache?.data.size ?? 0,
    fetchedAt: cache?.fetchedAt ?? null,
    ageMs: cache ? Date.now() - cache.fetchedAt : null,
    source: cache?.source ?? null,
  };
}
