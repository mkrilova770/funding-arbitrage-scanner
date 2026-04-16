/**
 * Display helpers for borrow liquidity (USDT + token). Used on client and in Gate server logs.
 * No Math.round / toFixed(0); preserves fractional values from the API until display.
 */

const usdUnder1k = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 14,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  compactDisplay: "short",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsdBorrowLiquidity(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return usdUnder1k.format(0);
  const abs = Math.abs(n);
  if (abs < 1000) return usdUnder1k.format(n);
  return usdCompact.format(n);
}

const tokenLarge = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 2,
});

const tokenMedium = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
});

const tokenSmall = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
});

/** Native token amount (no currency symbol). */
export function formatTokenBorrowLiquidity(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return tokenLarge.format(n);
  if (abs >= 1) return tokenMedium.format(n);
  return tokenSmall.format(n);
}
