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
}

export interface ScanResponse {
  rows: ArbitrageRow[];
  fetchedAt: number;
  errors: Record<string, string>; // exchange → error message
}
