import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";
import type {
  BitgetMarginPair,
  BitgetBorrowInfo,
  BitgetMarginSignedBlockReason,
} from "@/types";
import {
  bitgetSignedGet,
  bitgetSignedPost,
  loadBitgetCredentials,
  type BitgetApiCredentials,
} from "@/lib/bitget-sign";

// Bitget V2 USDT-margined futures
interface BitgetV2Ticker {
  symbol: string; // e.g. "BTCUSDT"
  lastPr: string;
  markPrice: string;
  fundingRate: string;
  ts: string; // ticker timestamp ms
  indexPrice: string;
}

interface BitgetV2Response {
  code: string;
  msg: string;
  data: BitgetV2Ticker[];
}

/**
 * Estimates next funding time for standard 8h intervals (00:00, 08:00, 16:00 UTC).
 * Used as fallback when exchange doesn't provide it directly.
 */
function nextFundingTime8h(): number {
  const now = Date.now();
  const d = new Date(now);
  const h = d.getUTCHours();
  const nextHour = h < 8 ? 8 : h < 16 ? 16 : 24;
  d.setUTCHours(nextHour === 24 ? 0 : nextHour, 0, 0, 0);
  if (nextHour === 24) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

// ─── Isolated margin (borrow side for scan) ────────────────────────────────────

interface BitgetMarginCurrencyRaw {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  isIsolatedBaseBorrowable: boolean;
  /** Present on current Bitget API; isolated-only pairs are often false. */
  isCrossBorrowable?: boolean;
}

interface BitgetMarginCurrenciesResponse {
  code: string;
  msg: string;
  data: BitgetMarginCurrencyRaw[];
}

interface BitgetSpotTicker {
  symbol: string;
  lastPr: string;
}

interface BitgetSpotTickersResponse {
  code: string;
  msg: string;
  data: BitgetSpotTicker[];
}

interface BitgetMarginLoansData {
  dailyInterest: string | null;
  annualInterest: string | null;
  limit: string | null;
}

interface BitgetMarginLoansResponse {
  code: string;
  msg: string;
  data: BitgetMarginLoansData;
}

interface BitgetVipTier {
  level?: string;
  limit?: string;
  annuallyInterestRate?: string;
  yearlyInterestRate?: string;
  annualInterestRate?: string;
}

interface BitgetIsolatedInterestRow {
  baseBorrowAble?: boolean;
  baseMaxBorrowableAmount?: string;
  baseYearlyInterestRate?: string;
  baseAnnuallyInterestRate?: string;
  /** V2 / newer responses (see CCXT `baseVipList`). */
  baseVipList?: BitgetVipTier[];
  /** V1 docs name. */
  baseVips?: BitgetVipTier[];
}

interface BitgetIsolatedInterestResponse {
  code: string;
  msg: string;
  /** Bitset may return one object or an array. */
  data?: BitgetIsolatedInterestRow | BitgetIsolatedInterestRow[] | null;
}

interface BitgetTierRow {
  baseMaxBorrowableAmount?: string;
  maxBorrowableAmount?: string;
}

interface BitgetTierDataResponse {
  code: string;
  msg: string;
  data?: BitgetTierRow[] | null;
}

interface BitgetMaxBorrowableResponse {
  code: string;
  data?: { maxBorrowableAmount?: string };
}

/** Parsed row from V2 signed isolated interest (+ optional tier fill-in). */
interface IsolatedPublicBorrow {
  maxBorrowable: number | null;
  yearlyRateDecimal: number | null;
}

const MARGIN_LOANS_CONCURRENCY = 12;
const ISOLATED_SIGNED_CONCURRENCY = 8;
/** Small gap between signed batches to reduce 429s (~10 req/s per UID on Bitget). */
const ISOLATED_BATCH_DELAY_MS = 25;
const V2_ISOLATED_INTEREST_PATH = "/api/v2/margin/isolated/interest-rate-and-limit";
const V2_ISOLATED_TIER_PATH = "/api/v2/margin/isolated/tier-data";

function emptySignedBorrowMap(
  pairs: BitgetMarginPair[]
): Map<string, IsolatedPublicBorrow | null> {
  const m = new Map<string, IsolatedPublicBorrow | null>();
  for (const p of pairs) m.set(p.base.toUpperCase(), null);
  return m;
}

/**
 * One cheap signed call. Code 50021 = margin account never opened in Bitget (common).
 */
async function probeBitgetMarginSignedApi(
  creds: BitgetApiCredentials
): Promise<{ block: BitgetMarginSignedBlockReason | null; code: string; msg: string }> {
  const res = await bitgetSignedGet(creds, V2_ISOLATED_INTEREST_PATH, { symbol: "BTCUSDT" });
  let json: { code?: string; msg?: string };
  try {
    json = await res.json();
  } catch {
    return { block: null, code: "parse_error", msg: "Invalid JSON" };
  }
  const code = json.code ?? "";
  const msg = json.msg ?? "";
  if (code === "00000") return { block: null, code, msg };
  if (code === "40006") return { block: "bad_auth", code, msg };
  if (code === "50021") return { block: "no_margin_account", code, msg };
  const low = msg.toLowerCase();
  if (low.includes("margin") && low.includes("not exist")) {
    return { block: "no_margin_account", code, msg };
  }
  return { block: null, code, msg };
}

function interestResponseRows(
  data: BitgetIsolatedInterestResponse["data"]
): BitgetIsolatedInterestRow[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  return [data];
}

/** VIP tier 0 often carries `limit` when `baseMaxBorrowableAmount` is 0 or omitted. */
function parseVip0BaseLimit(row: BitgetIsolatedInterestRow): {
  limit: number | null;
  annual: number | null;
} {
  let limit: number | null = null;
  let annual: number | null = null;
  const lists = [row.baseVipList, row.baseVips].filter(
    (x): x is BitgetVipTier[] => Array.isArray(x) && x.length > 0
  );
  for (const tiers of lists) {
    const v0 =
      tiers.find((t) => String(t.level ?? "") === "0") ?? tiers[0];
    const limRaw = v0?.limit;
    const lim =
      limRaw != null && String(limRaw).trim() !== ""
        ? parseFloat(String(limRaw))
        : NaN;
    const annRaw =
      v0?.annuallyInterestRate ??
      v0?.yearlyInterestRate ??
      v0?.annualInterestRate;
    const ann =
      annRaw != null && String(annRaw).trim() !== ""
        ? parseFloat(String(annRaw))
        : NaN;
    if (limit == null && Number.isFinite(lim) && lim > 0) limit = lim;
    if (annual == null && Number.isFinite(ann) && ann > 0) annual = ann;
  }
  return { limit, annual };
}

function parseIsolatedInterestRow(row: BitgetIsolatedInterestRow): IsolatedPublicBorrow | null {
  const maxStr = row.baseMaxBorrowableAmount;
  const yrStr = row.baseAnnuallyInterestRate ?? row.baseYearlyInterestRate;
  const maxParsed =
    maxStr != null && String(maxStr).trim() !== ""
      ? parseFloat(String(maxStr))
      : NaN;
  let maxBorrowable =
    Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : null;

  let yearlyRateDecimal: number | null = null;
  if (yrStr != null && String(yrStr).trim() !== "") {
    const yr = parseFloat(String(yrStr));
    if (Number.isFinite(yr) && yr > 0) yearlyRateDecimal = yr;
  }

  const vip = parseVip0BaseLimit(row);
  if (maxBorrowable == null && vip.limit != null) maxBorrowable = vip.limit;
  if (yearlyRateDecimal == null && vip.annual != null) yearlyRateDecimal = vip.annual;

  if (maxBorrowable == null && yearlyRateDecimal == null) return null;
  return { maxBorrowable, yearlyRateDecimal };
}

function marginPairToIsolatedSymbol(pair: BitgetMarginPair): string {
  const id = pair.id.replace(/_/g, "").toUpperCase();
  if (id.endsWith("USDT")) return id;
  return `${pair.base.toUpperCase()}${pair.quote.toUpperCase()}`;
}

async function fetchIsolatedAccountMaxBorrowable(
  creds: BitgetApiCredentials,
  baseCoin: string,
  symbolId: string
): Promise<number | null> {
  const sym = symbolId.replace(/_/g, "").toUpperCase();
  const body = { coin: baseCoin.toUpperCase(), symbol: sym };
  const paths = [
    "/api/v2/margin/isolated/account/max-borrowable-amount",
    "/api/margin/v1/isolated/account/maxBorrowableAmount",
  ];
  for (const path of paths) {
    const res = await bitgetSignedPost(creds, path, body);
    if (!res.ok) continue;
    let json: BitgetMaxBorrowableResponse;
    try {
      json = await res.json();
    } catch {
      continue;
    }
    if (json.code !== "00000" || json.data?.maxBorrowableAmount == null) continue;
    const v = parseFloat(String(json.data.maxBorrowableAmount));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** V2 signed tier ladder (Bitget decommissioned V1 public margin endpoints). */
async function fetchIsolatedSignedTierBaseSum(
  symbol: string,
  creds: BitgetApiCredentials
): Promise<number | null> {
  const sym = symbol.replace(/_/g, "").toUpperCase();
  const res = await bitgetSignedGet(creds, V2_ISOLATED_TIER_PATH, { symbol: sym });
  if (!res.ok) return null;
  let json: BitgetTierDataResponse;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (json.code !== "00000" || !json.data?.length) return null;
  let sum = 0;
  for (const row of json.data) {
    const s = row.baseMaxBorrowableAmount ?? row.maxBorrowableAmount;
    if (s == null || String(s).trim() === "") continue;
    const v = parseFloat(String(s));
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum > 0 ? sum : null;
}

/** Combine parallel interest + tier responses (tier fills missing base max). */
function mergeInterestRowWithTierSum(
  interest: IsolatedPublicBorrow | null,
  tierSum: number | null
): IsolatedPublicBorrow | null {
  const intMax = interest?.maxBorrowable;
  const hasIntMax = intMax != null && intMax > 0;
  if (hasIntMax) return interest;
  const hasTier = tierSum != null && tierSum > 0;
  if (hasTier) {
    return {
      maxBorrowable: tierSum,
      yearlyRateDecimal: interest?.yearlyRateDecimal ?? null,
    };
  }
  if (interest != null && interest.yearlyRateDecimal != null && interest.yearlyRateDecimal > 0) {
    return interest;
  }
  return null;
}

async function fetchIsolatedSignedInterest(
  symbol: string,
  creds: BitgetApiCredentials
): Promise<IsolatedPublicBorrow | null> {
  const sym = symbol.replace(/_/g, "").toUpperCase();
  const res = await bitgetSignedGet(creds, V2_ISOLATED_INTEREST_PATH, { symbol: sym });
  if (!res.ok) return null;
  let json: BitgetIsolatedInterestResponse;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  const rows = interestResponseRows(json.data);
  if (json.code !== "00000" || rows.length === 0) return null;
  return parseIsolatedInterestRow(rows[0]);
}

async function fetchIsolatedSignedMap(
  pairs: BitgetMarginPair[],
  creds: BitgetApiCredentials
): Promise<Map<string, IsolatedPublicBorrow | null>> {
  const result = new Map<string, IsolatedPublicBorrow | null>();

  async function one(pair: BitgetMarginPair): Promise<void> {
    const tok = pair.base.toUpperCase();
    const s1 = marginPairToIsolatedSymbol(pair);
    const [i1, t1] = await Promise.all([
      fetchIsolatedSignedInterest(s1, creds),
      fetchIsolatedSignedTierBaseSum(s1, creds),
    ]);
    let row = mergeInterestRowWithTierSum(i1, t1);
    if (row == null && s1 !== `${tok}USDT` && pair.quote.toUpperCase() === "USDT") {
      const alt = `${tok}USDT`;
      const [i2, t2] = await Promise.all([
        fetchIsolatedSignedInterest(alt, creds),
        fetchIsolatedSignedTierBaseSum(alt, creds),
      ]);
      row = mergeInterestRowWithTierSum(i2, t2);
    }
    result.set(tok, row);
  }

  for (let i = 0; i < pairs.length; i += ISOLATED_SIGNED_CONCURRENCY) {
    const batch = pairs.slice(i, i + ISOLATED_SIGNED_CONCURRENCY);
    await Promise.all(batch.map((p) => one(p)));
    if (i + ISOLATED_SIGNED_CONCURRENCY < pairs.length) {
      await new Promise((r) => setTimeout(r, ISOLATED_BATCH_DELAY_MS));
    }
  }
  for (const p of pairs) {
    const t = p.base.toUpperCase();
    if (!result.has(t)) result.set(t, null);
  }
  return result;
}

async function fetchBitgetSpotLastMap(): Promise<Map<string, number>> {
  const res = await fetchWithTimeout(
    "https://api.bitget.com/api/v2/spot/market/tickers",
    {},
    15_000
  );
  if (!res.ok) throw new Error(`Bitget spot tickers HTTP ${res.status}`);
  const json: BitgetSpotTickersResponse = await res.json();
  if (json.code !== "00000") {
    throw new Error(`Bitget spot tickers error: ${json.code}`);
  }
  const map = new Map<string, number>();
  for (const t of json.data) {
    if (!t.symbol.endsWith("USDT")) continue;
    const base = normalizeBaseToken(t.symbol);
    if (!base) continue;
    map.set(base, parseFloat(t.lastPr || "0"));
  }
  return map;
}

/** USDT isolated-margin bases with base-coin borrow enabled (unique by base). */
export async function fetchBitgetIsolatedMarginBases(): Promise<BitgetMarginPair[]> {
  const res = await fetchWithTimeout(
    "https://api.bitget.com/api/v2/margin/currencies",
    {},
    15_000
  );
  if (!res.ok) throw new Error(`Bitget margin currencies HTTP ${res.status}`);
  const json: BitgetMarginCurrenciesResponse = await res.json();
  if (json.code !== "00000") {
    throw new Error(`Bitget margin currencies error: ${json.code}`);
  }

  const byBase = new Map<string, BitgetMarginPair>();
  for (const row of json.data) {
    if (row.quoteCoin !== "USDT" || row.status !== "1") continue;
    if (!row.isIsolatedBaseBorrowable) continue;
    const base = row.baseCoin.toUpperCase();
    if (!base || byBase.has(base)) continue;
    byBase.set(base, {
      id: row.symbol,
      base,
      quote: "USDT",
      isCrossBorrowable: row.isCrossBorrowable === true,
    });
  }
  return [...byBase.values()];
}

/**
 * Borrow APR and limit: V2 signed isolated interest + tier-data + account max-borrow (when
 * BITGET_* env set); UTA public margin-loans always. Bitget retired V1 public margin URLs (30032).
 */
export async function fetchBitgetBorrowInfo(
  pairs: BitgetMarginPair[]
): Promise<{
  borrowByToken: Map<string, BitgetBorrowInfo>;
  signedBorrowConfigured: boolean;
  /** Signed isolated APIs skipped: no margin account (50021) or bad key/passphrase (40006). */
  marginSignedBlocked: BitgetMarginSignedBlockReason | null;
  marginSignedProbeMsg: string;
}> {
  const creds = loadBitgetCredentials();
  const signedBorrowConfigured = creds != null;
  let marginSignedBlocked: BitgetMarginSignedBlockReason | null = null;
  let marginSignedProbeMsg = "";

  const spotMap = await fetchBitgetSpotLastMap();

  let signedMapPromise: Promise<Map<string, IsolatedPublicBorrow | null>>;
  if (!creds) {
    signedMapPromise = Promise.resolve(emptySignedBorrowMap(pairs));
  } else {
    const probe = await probeBitgetMarginSignedApi(creds);
    marginSignedProbeMsg =
      probe.block != null
        ? probe.msg
          ? `${probe.code}: ${probe.msg}`
          : probe.code || ""
        : "";
    if (probe.block === "no_margin_account" || probe.block === "bad_auth") {
      marginSignedBlocked = probe.block;
      signedMapPromise = Promise.resolve(emptySignedBorrowMap(pairs));
    } else {
      signedMapPromise = fetchIsolatedSignedMap(pairs, creds);
    }
  }

  const [signedMap, utaMap] = await Promise.all([
    signedMapPromise,
    fetchUtaMarginLoansMap(
      pairs.map((p) => p.base.toUpperCase()),
      spotMap
    ),
  ]);

  const result = new Map<string, BitgetBorrowInfo>();
  for (const pair of pairs) {
    const upper = pair.base.toUpperCase();
    const spotPrice = spotMap.get(upper) ?? 0;
    const signed = signedMap.get(upper) ?? null;
    const uta = utaMap.get(upper)!;

    const signedMax = signed?.maxBorrowable ?? null;
    const utaLiq = uta.liquidityToken;

    const liquidityToken = signedMax ?? utaLiq ?? null;
    const liquidityUsdt =
      liquidityToken != null && spotPrice > 0 ? liquidityToken * spotPrice : null;

    const signedApr =
      signed?.yearlyRateDecimal != null && signed.yearlyRateDecimal > 0
        ? signed.yearlyRateDecimal * 100
        : null;
    const borrowAPR =
      signedApr != null && signedApr > 0 ? signedApr : uta.borrowAPR;

    const hasSignedIsolatedQuote =
      (signedMax != null && signedMax > 0) ||
      (signed?.yearlyRateDecimal != null && signed.yearlyRateDecimal > 0);

    const hasIsolatedPublicQuote = false;

    let liquiditySource: BitgetBorrowInfo["liquiditySource"] = null;
    if (signedMax != null && signedMax > 0) liquiditySource = "isolated-v2-private";
    else if (utaLiq != null && utaLiq > 0) liquiditySource = "uta-v3-public";

    result.set(upper, {
      currency: upper,
      borrowAPR,
      liquidityToken,
      liquidityUsdt,
      spotPrice,
      hasUtaBorrowQuote: uta.hasUtaBorrowQuote,
      hasIsolatedPublicQuote,
      hasSignedIsolatedQuote,
      liquiditySource,
    });
  }

  const accountMaxEnabled =
    process.env.BITGET_ACCOUNT_MAX_BORROW === "1" ||
    process.env.BITGET_ACCOUNT_MAX_BORROW === "true";

  if (creds && accountMaxEnabled && marginSignedBlocked == null) {
    const ACCOUNT_CONCURRENCY = 6;
    const ACCOUNT_DELAY_MS = 0;
    const needAccount = pairs.filter((p) => {
      const u = p.base.toUpperCase();
      const x = result.get(u);
      return x == null || x.liquidityToken == null || x.liquidityToken <= 0;
    });
    for (let i = 0; i < needAccount.length; i += ACCOUNT_CONCURRENCY) {
      const batch = needAccount.slice(i, i + ACCOUNT_CONCURRENCY);
      await Promise.all(
        batch.map(async (p) => {
          const upper = p.base.toUpperCase();
          const cur = result.get(upper);
          if (!cur || (cur.liquidityToken != null && cur.liquidityToken > 0)) return;
          const s1 = marginPairToIsolatedSymbol(p);
          let n = await fetchIsolatedAccountMaxBorrowable(creds, upper, s1);
          if (
            n == null &&
            s1 !== `${upper}USDT` &&
            p.quote.toUpperCase() === "USDT"
          ) {
            n = await fetchIsolatedAccountMaxBorrowable(creds, upper, `${upper}USDT`);
          }
          if (n == null) return;
          const spotPrice = cur.spotPrice;
          result.set(upper, {
            ...cur,
            liquidityToken: n,
            liquidityUsdt: spotPrice > 0 ? n * spotPrice : null,
            liquiditySource: "isolated-v2-private",
            hasSignedIsolatedQuote: true,
          });
        })
      );
      if (i + ACCOUNT_CONCURRENCY < needAccount.length) {
        await new Promise((r) => setTimeout(r, ACCOUNT_DELAY_MS));
      }
    }
  }

  return {
    borrowByToken: result,
    signedBorrowConfigured,
    marginSignedBlocked,
    marginSignedProbeMsg,
  };
}

async function fetchUtaMarginLoansMap(
  tokens: string[],
  spotMap: Map<string, number>
): Promise<
  Map<
    string,
    {
      borrowAPR: number;
      liquidityToken: number | null;
      hasUtaBorrowQuote: boolean;
    }
  >
> {
  const result = new Map<
    string,
    {
      borrowAPR: number;
      liquidityToken: number | null;
      hasUtaBorrowQuote: boolean;
    }
  >();

  async function fetchOne(token: string): Promise<void> {
    const upper = token.toUpperCase();
    const spotPrice = spotMap.get(upper) ?? 0;
    const url = `https://api.bitget.com/api/v3/market/margin-loans?coin=${encodeURIComponent(
      upper
    )}`;
    const res = await fetchWithTimeout(url, {}, 12_000);
    if (!res.ok) return;
    let json: BitgetMarginLoansResponse;
    try {
      json = await res.json();
    } catch {
      return;
    }
    if (json.code !== "00000" || !json.data) {
      result.set(upper, {
        borrowAPR: 0,
        liquidityToken: null,
        hasUtaBorrowQuote: false,
      });
      return;
    }
    const d = json.data;
    const limStr = d.limit;
    const annStr = d.annualInterest;
    const lim =
      limStr != null && String(limStr).trim() !== ""
        ? parseFloat(String(limStr))
        : NaN;
    const annual =
      annStr != null && String(annStr).trim() !== ""
        ? parseFloat(String(annStr))
        : NaN;

    const hasUtaBorrowQuote =
      (Number.isFinite(lim) && lim > 0) ||
      (Number.isFinite(annual) && annual > 0);

    const borrowAPR = Number.isFinite(annual) && annual > 0 ? annual * 100 : 0;
    const liquidityToken = Number.isFinite(lim) && lim > 0 ? lim : null;

    result.set(upper, {
      borrowAPR,
      liquidityToken,
      hasUtaBorrowQuote,
    });
  }

  for (let i = 0; i < tokens.length; i += MARGIN_LOANS_CONCURRENCY) {
    const batch = tokens.slice(i, i + MARGIN_LOANS_CONCURRENCY);
    await Promise.all(batch.map((t) => fetchOne(t)));
  }

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (!result.has(upper)) {
      result.set(upper, {
        borrowAPR: 0,
        liquidityToken: null,
        hasUtaBorrowQuote: false,
      });
    }
  }

  return result;
}

export class BitgetAdapter implements ExchangeAdapter {
  name = "Bitget";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const url =
      "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Bitget HTTP ${res.status}`);
    const data: BitgetV2Response = await res.json();
    if (data.code !== "00000") throw new Error(`Bitget error: ${data.code}`);

    const result = new Map<string, FundingInfo>();
    for (const item of data.data) {
      if (!item.symbol.endsWith("USDT")) continue;
      const base = normalizeBaseToken(item.symbol);
      if (!base) continue;
      if (filterTokens && !filterTokens.has(base)) continue;
      if (!item.fundingRate) continue;

      // Bitget V2 tickers don't expose nextSettleTime; estimate from 8h cycle
      const nextFunding = nextFundingTime8h();

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.symbol,
        rawFundingRate: parseFloat(item.fundingRate),
        markPrice: parseFloat(item.markPrice || item.lastPr || "0"),
        nextFundingTime: nextFunding,
        intervalHours: 8,
      });
    }
    return result;
  }
}
