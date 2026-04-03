export interface ArbitrageRow {
  id: string; // `${token}-${exchange}`
  token: string;
  exchange: string;
  rawFunding: number;    // raw decimal rate (e.g. 0.0001)
  intervalHours: number; // funding interval in hours (1 / 4 / 8)
  fundingAPR: number;    // annualized % = rawFunding * (8760 / intervalHours) * 100
  borrowAPR: number;     // Bitget borrow APR % (UTA public annualInterest × 100; see margin-loans)
  netAPR: number;        // fundingAPR - borrowAPR
  spread: number;        // (futuresPrice - spotPrice) / spotPrice * 100
  futuresPrice: number;
  spotPrice: number;
  borrowLiquidityToken: number | null; // available native tokens (e.g. 2620 BTC)
  borrowLiquidityUsdt: number | null;  // available USDT equivalent (e.g. 177_090_000)
  /**
   * False when no public borrow limit was found (isolated interestRateAndLimit + UTA margin-loans both empty).
   */
  borrowPoolFromUta: boolean;
  nextFundingTime: number; // unix ms
  updatedAt: number;       // unix ms
}

export interface DataPoint {
  ts: number; // unix ms
  value: number;
}

export interface TokenHistory {
  funding: DataPoint[];
  spread: DataPoint[];
  borrow: DataPoint[];
}

export interface GateMarginPair {
  id: string;   // e.g. "BTC_USDT"
  base: string; // e.g. "BTC"
  quote: string; // e.g. "USDT"
}

/** Bitget margin/currencies row (USDT isolated base). */
export interface BitgetMarginPair extends GateMarginPair {
  isCrossBorrowable: boolean;
}

export interface GateBorrowInfo {
  currency: string;                    // e.g. "BTC"
  borrowAPR: number;                   // annualized % (VIP 0)
  liquidityToken: number | null;       // available native tokens
  liquidityUsdt: number | null;        // available USDT equivalent
  spotPrice: number;
}

/** Bitget: borrow APR and pool from public isolated interest + UTA margin-loans + spot */
export interface BitgetBorrowInfo {
  currency: string;
  borrowAPR: number;
  liquidityToken: number | null;
  liquidityUsdt: number | null;
  spotPrice: number;
  /** True if margin-loans returned a usable limit and/or rate for this coin. */
  hasUtaBorrowQuote: boolean;
  /** True if isolated public v1 interestRateAndLimit returned base max borrow and/or yearly rate. */
  hasIsolatedPublicQuote: boolean;
  /** Where the displayed borrow *limit* came from (APR may combine sources). */
  liquiditySource:
    | "isolated-v2-private"
    | "isolated-v1-public"
    | "uta-v3-public"
    | null;
  /** Signed GET /api/v2/margin/isolated/interest-rate-and-limit returned usable base fields. */
  hasSignedIsolatedQuote: boolean;
}

/** Signed isolated borrow APIs unavailable: open margin in Bitget app, or fix API credentials. */
export type BitgetMarginSignedBlockReason = "no_margin_account" | "bad_auth";

/** Borrow-side load status for the status bar (parity with deployed Gate scanner UI). */
export interface BitgetScanBorrowMeta {
  /** How borrow limits were loaded (V2 signed isolated + UTA, or UTA only if no API keys). */
  source: "isolated-v2-private+fallback" | "uta-v3-public";
  /** All of BITGET_API_KEY, BITGET_API_SECRET, BITGET_PASSPHRASE were set */
  signedBorrowConfigured: boolean;
  /**
   * Keys present but signed isolated endpoints were skipped (e.g. margin never opened → 50021).
   * Limits then fall back to UTA margin-loans only (often null / «no limit» for alts).
   */
  marginSignedBlocked?: BitgetMarginSignedBlockReason | null;
  /** Bitget API code:message from the margin probe (when marginSignedBlocked is set). */
  marginSignedProbeDetail?: string;
  /** Unique USDT isolated-margin bases (isIsolatedBaseBorrowable) */
  isolatedMarginTokens: number;
  /** Tokens with non-zero APR or non-null pool from either source */
  loansWithRateOrPool: number;
  /** Tokens where signed v2 API supplied a positive base max borrow */
  isolatedSignedLimits: number;
  /** Tokens where isolated public v1 returned a positive base max borrow */
  isolatedPublicLimits: number;
  /** Tokens where only UTA margin-loans returned a positive limit */
  utaBorrowLimits: number;
  borrowFetchOk: boolean;
}

export interface ScanResponse {
  rows: ArbitrageRow[];
  fetchedAt: number;
  errors: Record<string, string>; // exchange → error message
  bitgetBorrow?: BitgetScanBorrowMeta | null;
}
