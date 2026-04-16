/**
 * Display helpers for borrow liquidity (USDT + token). Used on client and server.
 * Values stay full-precision in JSON; here we only format strings (no Math.round).
 */

const usdBorrow = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 14,
  useGrouping: true,
});

export function formatUsdBorrowLiquidity(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return usdBorrow.format(n);
}

const tokenWhole = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 14,
  useGrouping: true,
});

const tokenSmall = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 10,
});

/** Native token amount (no currency symbol). */
export function formatTokenBorrowLiquidity(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1) return tokenWhole.format(n);
  return tokenSmall.format(n);
}
