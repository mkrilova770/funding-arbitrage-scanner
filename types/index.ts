export interface ArbitrageRow {
  id: string; // `${token}-${exchange}`
  token: string;
  exchange: string;
  rawFunding: number;    // raw decimal rate (e.g. 0.0001)
  intervalHours: number; // funding interval in hours (1 / 4 / 8)
  fundingAPR: number;    // annualized % = rawFunding * (8760 / intervalHours) * 100
  borrowAPR: number;     // Gate Earn Uni borrow APR % (est_rate × 100)
  tradingFees: number;   // full round-trip fees in % = 2*GateSpotFee + 2*FuturesFee(exchange)
  netAPR: number;        // fundingAPR - borrowAPR - tradingFees
  spread: number;        // (futuresPrice - spotPrice) / spotPrice * 100
  futuresPrice: number;
  spotPrice: number;
  borrowLiquidityToken: number | null; // available native tokens (e.g. 2620 BTC)
  borrowLiquidityUsdt: number | null;  // available USDT equivalent (e.g. 177_090_000)
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

export interface GateBorrowInfo {
  currency: string;                    // e.g. "BTC"
  borrowAPR: number;                   // annualized % (VIP 0)
  liquidityToken: number | null;       // available native tokens
  liquidityUsdt: number | null;        // available USDT equivalent
  spotPrice: number;
}

/** Bitget isolated margin pair (USDT quote) used by `lib/exchanges/bitget.ts`. */
export interface BitgetMarginPair {
  id: string; // e.g. "BTCUSDT" (Bitget margin symbol)
  base: string;
  quote: "USDT";
  /** Whether Bitget marks the base as cross-borrowable (informational). */
  isCrossBorrowable?: boolean;
}

/**
 * Reasons we may skip Bitget signed isolated margin APIs.
 * Returned by `probeBitgetMarginSignedApi()` in `lib/exchanges/bitget.ts`.
 */
export type BitgetMarginSignedBlockReason = "bad_auth" | "no_margin_account";

/** Bitget borrow info (UTA public + optional signed isolated APIs). */
export interface BitgetBorrowInfo {
  currency: string;
  borrowAPR: number;
  liquidityToken: number | null;
  liquidityUsdt: number | null;
  spotPrice: number;
  hasUtaBorrowQuote: boolean;
  hasIsolatedPublicQuote: boolean;
  hasSignedIsolatedQuote: boolean;
  liquiditySource: "isolated-v2-private" | "uta-v3-public" | null;
}

export interface ScanResponse {
  rows: ArbitrageRow[];
  fetchedAt: number;
  errors: Record<string, string>; // exchange → error message
}
