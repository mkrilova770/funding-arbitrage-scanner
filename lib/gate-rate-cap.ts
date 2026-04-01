/**
 * Gate isolated margin rate cap data.
 *
 * PRIMARY: Gate API key + /margin/uni/borrowable (requires GATE_API_KEY /
 *          GATE_API_SECRET in .env.local). Fast and stable.
 * API FALLBACK: earn/uni/rate API for APR (plus spot tickers for USDT conversion
 *          when borrowable is available).
 * LAST RESORT: Playwright scraper on the Gate rate-cap page.
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
const MIN_ACCEPTED_SCRAPE_TOKENS = 500; // reject obviously partial runs
const MIN_ACCEPTED_SCRAPE_RATIO = 0.8;  // reject if new scrape << previous good scrape

interface Cache {
  data: Map<string, GateRateCapEntry>;
  fetchedAt: number;
  source: "scrape" | "api-fallback";
  scrapeCount: number;   // tokens from Playwright
  mergedCount: number;   // tokens added from API fallback
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
  // Cell format (Gate.io rate-cap table, VIP0 column):
  //   "daily_rate%/token_annual%\nplatform_daily%/floor_annual%"
  //   e.g. "0.000606%/5.30%\n0.000355%/3.10%"
  // The actual VIP0 borrow rate = max(token_annual, floor_annual)
  // = max of ALL "annual" values found in "X%/Y%" pairs within the cell.
  let maxAnnual = -Infinity;
  for (const m of raw.matchAll(/([\d.]+)%\/([\d.]+)%/g)) {
    const annual = parseFloat(m[2]);
    if (!isNaN(annual)) maxAnnual = Math.max(maxAnnual, annual);
  }
  if (maxAnnual > -Infinity) return maxAnnual;
  // Fallback: plain "X.XX%" with no daily/annual split
  const parts = raw.trim().split("/");
  const annualPart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const cleaned = annualPart.replace(/%/g, "").replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return n;
}

// ── API fallback ─────────────────────────────────────────────────────────────

interface GateUniRate { currency: string; est_rate: string; }
interface GateSpotTickerFallback { currency_pair: string; last: string; }

async function fetchFallback(): Promise<Map<string, GateRateCapEntry>> {
  console.log("[gate-rate-cap] Using API fallback (earn/uni/rate × VIP0_MULTIPLIER)");
  const now = Date.now();
  const result = new Map<string, GateRateCapEntry>();

  const [ratesRes, spotRes] = await Promise.allSettled([
    fetch("https://api.gateio.ws/api/v4/earn/uni/rate", { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.ok ? (r.json() as Promise<GateUniRate[]>) : ([] as GateUniRate[])),
    fetch("https://api.gateio.ws/api/v4/spot/tickers", { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.ok ? (r.json() as Promise<GateSpotTickerFallback[]>) : ([] as GateSpotTickerFallback[])),
  ]);

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
      result.set(upper, {
        token: upper,
        borrowApr,
        // Public APIs do not expose real-time borrowable pool amounts.
        // These are overlaid from authenticated /margin/uni/borrowable.
        liquidityTokenRaw: null,
        liquidityUsdtRaw: null,
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
          if (isNaN(borrowableTokens)) return;
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
          // Column layout:
          //  [0] pair  [1] leverage  [2] assets  [3] availability  [4+] VIP rate cols
          // Pick the FIRST % cell for VIP0 rate (VIP1/VIP2 come after).
          // For availability: prefer a cell containing ≈ (has USDT equivalent);
          // fall back to column 3 directly for rows where no ≈ is present
          // (zero-liquidity rows or rows that omit the USDT conversion).
          let rateCellText = "";
          let availCellText = "";
          for (const text of allCells) {
            if (!rateCellText && /%/.test(text) && text.length < 200) rateCellText = text;
            if (!availCellText && /≈/.test(text)) availCellText = text;
          }
          // Fallback: column 3 is always the availability column
          if (!availCellText && allCells.length > 3) availCellText = allCells[3];
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

        if (row.availCellText && row.availCellText !== "—") {
          // Cell format (when available > 0):
          //   "561.66K\n\n≈ 13.31KUSDT\n\n491.32M"   ← token amt + USDT equivalent
          //   "561.66K\n\n491.32M"                    ← token amt only (no USDT line)
          //   "—"                                     ← nothing available (handled above)
          const splitOnApprox = row.availCellText.split("≈");
          if (splitOnApprox.length >= 2) {
            // First part before ≈ = token amount
            liquidityTokenRaw = parseAmount(splitOnApprox[0].replace(/\n/g, " ").trim());
            // Part after ≈ = USDT equivalent; stop at first newline to avoid platform cap
            const usdtRaw = splitOnApprox[1].split("\n")[0].replace(/USDT/gi, "").trim();
            liquidityUsdtRaw = parseAmount(usdtRaw);
          } else {
            // No ≈ → take first line as token amount (second line is platform cap)
            const firstLine = row.availCellText.split("\n")[0].trim();
            liquidityTokenRaw = parseAmount(firstLine);
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

    // ── Remaining pages ───────────────────────────────────────────────────────
    // Strategy: click the last pagination button and check if the TABLE
    // CONTENT changed. We intentionally do NOT check the disabled/data-disabled
    // attribute because Mantine sets these transitionally (during loading),
    // causing false "last page" detection. Instead we stop only when:
    //   a) the click itself fails (button gone from DOM)
    //   b) the first row pair is the same as the previous page for 2+ iterations
    //   c) we get 0 rows
    //   d) MAX_PAGES guard
    const PAGE_BTN_SEL = ".mantine-GatePagination-item, .mantine-Pagination-item";
    const MAX_PAGES = 300;
    let pageNum = 2;
    let consecutiveUnchanged = 0;
    let lastFirstPair = "";

    while (pageNum <= MAX_PAGES) {
      // Let any in-progress page transition fully settle before clicking
      await page.waitForTimeout(500);

      // Click the "→ next" button (last pagination item).
      // Use a generous 20 s timeout — the proxy can be slow.
      // Retry once on failure before giving up.
      let clicked = await page
        .locator(PAGE_BTN_SEL)
        .last()
        .click({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);

      if (!clicked) {
        // Wait a bit and try one more time before declaring end-of-pages
        await page.waitForTimeout(3_000);
        clicked = await page
          .locator(PAGE_BTN_SEL)
          .last()
          .click({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);

        if (!clicked) {
          console.log(`[gate-rate-cap] Next button not found after retry at page ${pageNum - 1}, stopping`);
          break;
        }
      }

      // Wait for the table to re-render (proxy latency can be high)
      await page.waitForTimeout(2_500);

      const pageRows = await extractRows();
      const firstPair = pageRows[0]?.pair ?? "";

      // If the first row hasn't changed the page didn't advance → last page
      if (firstPair && firstPair === lastFirstPair) {
        consecutiveUnchanged++;
        if (consecutiveUnchanged >= 2) {
          console.log(`[gate-rate-cap] Pagination unchanged × 2 at page ${pageNum - 1}, stopping`);
          break;
        }
        continue;
      }

      if (pageRows.length === 0) break;

      consecutiveUnchanged = 0;
      lastFirstPair = firstPair;
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
      if (borrowable.size === 0) {
        throw new Error("Borrowable API returned 0 tokens (missing permissions or IP restriction)");
      }
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
      throw err;
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
    // Keep scraper as primary source for real market pool availability.
    // /margin/uni/borrowable is account-dependent and may return 0 for empty accounts.
    scrapeInProgress = scrapeRateCap()
      .then(async (data) => {
        // Keep previous good scrape if the new run is clearly partial.
        const prev = cache;
        const prevScrapeCount = prev?.source === "scrape" ? prev.scrapeCount : 0;
        const newScrapeCount = data.size;
        const ratioVsPrev = prevScrapeCount > 0 ? newScrapeCount / prevScrapeCount : 1;
        const isClearlyPartial =
          newScrapeCount < MIN_ACCEPTED_SCRAPE_TOKENS &&
          prevScrapeCount > 0 &&
          ratioVsPrev < MIN_ACCEPTED_SCRAPE_RATIO;

        if (isClearlyPartial && prev) {
          console.warn(
            `[gate-rate-cap] Partial scrape rejected: new=${newScrapeCount}, prev=${prevScrapeCount}, ratio=${ratioVsPrev.toFixed(2)}; keeping previous cache`
          );
          scrapeInProgress = null;
          return prev.data;
        }

        // Merge previously scraped tokens not present in this run.
        // This prevents temporary page/scroll failures from turning rows into "—".
        let mergedFromPrev = 0;
        if (prev?.source === "scrape") {
          for (const [token, oldEntry] of prev.data.entries()) {
            if (!data.has(token)) {
              data.set(token, oldEntry);
              mergedFromPrev++;
            }
          }
          if (mergedFromPrev > 0) {
            console.log(`[gate-rate-cap] Merged ${mergedFromPrev} tokens from previous cache`);
          }
        }

        const scrapeCount = newScrapeCount;
        const mergedCount = 0;
        const src: "scrape" | "api-fallback" = "scrape";
        cache = { data, fetchedAt: Date.now(), source: src, scrapeCount, mergedCount };
        scrapeInProgress = null;
        return data;
      })
      .catch(async (err) => {
        console.error("[gate-rate-cap] Primary source failed, trying fallback:", err?.message ?? err);
        scrapeInProgress = null;
        try {
          // Fallback to API data when scraper fails.
          const fallback = await apiFallbackWithBorrowable();
          const src: "scrape" | "api-fallback" = "api-fallback";
          const scrapeCount = 0;
          const mergedCount = fallback.size;
          cache = { data: fallback, fetchedAt: Date.now(), source: src, scrapeCount, mergedCount };
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
  scrapeCount: number;
  mergedCount: number;
} {
  return {
    size: cache?.data.size ?? 0,
    fetchedAt: cache?.fetchedAt ?? null,
    ageMs: cache ? Date.now() - cache.fetchedAt : null,
    source: cache?.source ?? null,
    scrapeCount: cache?.scrapeCount ?? 0,
    mergedCount: cache?.mergedCount ?? 0,
  };
}
