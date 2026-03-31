export interface ArbitrageRow {
  id: string; // `${token}-${exchange}`
  token: string;
  exchange: string;
  rawFunding: number;    // raw decimal rate (e.g. 0.0001)
  intervalHours: number; // funding interval in hours (1 / 4 / 8)
  fundingAPR: number;    // annualized % = rawFunding * (8760 / intervalHours) * 100
  borrowAPR: number;     // Gate borrow APR % (VIP 0, from Gate page)
  netAPR: number;        // fundingAPR - borrowAPR
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

export interface ScanResponse {
  rows: ArbitrageRow[];
  fetchedAt: number;
  errors: Record<string, string>; // exchange → error message
}
