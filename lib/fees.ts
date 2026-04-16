export interface FeesConfig {
  /**
   * Gate spot fee (percent). Used on the short/borrow side.
   * Example: 0.10 means 0.10%.
   */
  spotFeeGatePct: number;
  /**
   * Futures fee (percent) per exchange for the long side.
   * Example: 0.06 means 0.06%.
   */
  futuresFeeByExchangePct: Record<string, number>;
  /** Fallback futures fee if exchange not found in the map (percent). */
  defaultFuturesFeePct: number;
}

export const fees: FeesConfig = {
  // These are conservative defaults; tune to your account tier / maker-vs-taker usage.
  spotFeeGatePct: 0.1,
  defaultFuturesFeePct: 0.06,
  futuresFeeByExchangePct: {
    Binance: 0.06,
    OKX: 0.05,
    Bybit: 0.055,
    Gate: 0.06,
    Bitget: 0.06,
    BingX: 0.06,
    XT: 0.06,
    MEXC: 0.06,
    BitMart: 0.06,
    KuCoin: 0.06,
  },
};

/**
 * Full round-trip fees in percent:
 * TradingFees% = (2 * SpotFeeGate%) + (2 * FuturesFeeExchange%)
 */
export function getTradingFeesPercent(exchangeName: string): number {
  const futures =
    fees.futuresFeeByExchangePct[exchangeName] ?? fees.defaultFuturesFeePct;
  return 2 * fees.spotFeeGatePct + 2 * futures;
}

