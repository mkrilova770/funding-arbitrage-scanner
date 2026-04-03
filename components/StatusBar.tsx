"use client";

import { format } from "date-fns";
import type { BitgetScanBorrowMeta } from "@/types";

interface StatusBarProps {
  fetchedAt: number;
  isFetching: boolean;
  isError: boolean;
  rowCount: number;
  errors: Record<string, string>;
  bitgetBorrow?: BitgetScanBorrowMeta | null;
}

export function StatusBar({
  fetchedAt,
  isFetching,
  isError,
  rowCount,
  errors,
  bitgetBorrow,
}: StatusBarProps) {
  const errorKeys = Object.keys(errors);

  const bitgetMarginBlock =
    bitgetBorrow?.marginSignedBlocked === "no_margin_account"
      ? {
          text: "Bitget: маржа не открыта — лимиты займа неполные",
          className:
            "bg-rose-900/45 text-rose-200 border border-rose-600/60",
          title:
            (errors["Bitget.MarginAccount"] ??
              "Активируйте маржинальный счёт в Bitget (изолированная маржа), затем обновите скан. См. ошибку Bitget.MarginAccount.") +
            (bitgetBorrow.marginSignedProbeDetail
              ? ` API: ${bitgetBorrow.marginSignedProbeDetail}`
              : ""),
        }
      : bitgetBorrow?.marginSignedBlocked === "bad_auth"
        ? {
            text: "Bitget: ошибка API ключей",
            className:
              "bg-rose-900/45 text-rose-200 border border-rose-600/60",
            title:
              (errors["Bitget.ApiAuth"] ?? "Проверьте BITGET_API_KEY, секрет и passphrase.") +
              (bitgetBorrow.marginSignedProbeDetail
                ? ` ${bitgetBorrow.marginSignedProbeDetail}`
                : ""),
          }
        : null;

  const bitgetLabel =
    bitgetMarginBlock ??
    (bitgetBorrow && bitgetBorrow.isolatedMarginTokens > 0
      ? bitgetBorrow.borrowFetchOk
        ? {
            text: "Bitget data: public API (fast)",
            className:
              "bg-emerald-900/40 text-emerald-400 border border-emerald-700/50",
            title: (() => {
              const iso = bitgetBorrow.isolatedMarginTokens;
              const lim =
                bitgetBorrow.utaBorrowLimits != null
                  ? bitgetBorrow.utaBorrowLimits
                  : bitgetBorrow.loansWithRateOrPool;
              const isl = bitgetBorrow.isolatedSignedLimits ?? 0;
              if (
                bitgetBorrow.signedBorrowConfigured &&
                !bitgetBorrow.marginSignedBlocked
              ) {
                return `Pairs: /api/v2/margin/currencies. Borrow: signed V2 isolated interest+tier+max-borrow (${isl}/${iso}), UTA margin-loans (~${lim} UTA-only). Spot tickers.`;
              }
              return `Pairs: /api/v2/margin/currencies. Borrow: UTA margin-loans only (~${lim}/${iso} with limit) — add BITGET_* keys + passphrase for full isolated pool. Spot tickers.`;
            })(),
          }
        : {
            text: "Bitget borrow: partial / error",
            className:
              "bg-amber-900/40 text-amber-400 border border-amber-700/50",
            title: "Margin pairs loaded; borrow fetch failed — check Bitget.Borrow in errors.",
          }
      : bitgetBorrow
        ? {
            text: "Bitget borrow: unavailable",
            className:
              "bg-amber-900/40 text-amber-400 border border-amber-700/50",
            title: "No isolated-margin USDT bases or margin currencies request failed.",
          }
        : null);

  return (
    <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            isFetching
              ? "bg-yellow-400 animate-pulse"
              : isError
              ? "bg-red-500"
              : "bg-green-500"
          }`}
        />
        <span>
          {isFetching
            ? "Updating..."
            : isError
            ? "Error"
            : fetchedAt
            ? `Updated ${format(new Date(fetchedAt), "HH:mm:ss")}`
            : "Loading..."}
        </span>
      </div>

      {rowCount > 0 && (
        <span className="text-gray-600">
          {rowCount} opportunities found
        </span>
      )}

      {bitgetLabel && (
        <span
          className={`px-2 py-0.5 rounded text-[11px] font-medium ${bitgetLabel.className}`}
          title={bitgetLabel.title}
        >
          {bitgetLabel.text}
        </span>
      )}

      {errorKeys.length > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-yellow-600">Partial errors:</span>
          {errorKeys.map((key) => (
            <span
              key={key}
              className="bg-yellow-900/30 text-yellow-600 px-1.5 py-0.5 rounded text-xs"
              title={errors[key]}
            >
              {key}
            </span>
          ))}
        </div>
      )}

      <span className="text-gray-700">Auto-refresh: 30s</span>
    </div>
  );
}
