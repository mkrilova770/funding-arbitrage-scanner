"use client";

import { ArbitrageRow, TokenHistory } from "@/types";
import { MiniChart } from "./charts/MiniChart";
import { format, formatDistanceToNow } from "date-fns";
import { useEffect } from "react";

interface TokenModalProps {
  row: ArbitrageRow;
  history: TokenHistory;
  onClose: () => void;
}

function MetricRow({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-gray-800">
      <span className="text-gray-400 text-sm">{label}</span>
      <span className={`text-sm font-mono font-medium ${className ?? "text-white"}`}>
        {value}
      </span>
    </div>
  );
}

function fmt(n: number, decimals = 4) {
  return n.toFixed(decimals);
}

function fmtPct(n: number) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(4)}%`;
}

function fmtPrice(n: number) {
  if (n === 0) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

function netColor(n: number) {
  if (n > 5) return "text-green-400";
  if (n > 0) return "text-green-600";
  if (n < 0) return "text-red-400";
  return "text-gray-400";
}

export function TokenModal({ row, history, onClose }: TokenModalProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const nextFundingStr = row.nextFundingTime
    ? formatDistanceToNow(new Date(row.nextFundingTime), { addSuffix: true })
    : "—";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-white">{row.token}</span>
            <span className="text-sm text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
              {row.exchange} futures
            </span>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
              Short → Bitget
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-4">
          {/* Key metric highlighted */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-gray-800 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">Funding APR</div>
              <div className="text-lg font-bold text-blue-400">
                {fmtPct(row.fundingAPR)}
              </div>
            </div>
            <div className="bg-gray-800 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">Borrow APR</div>
              <div className="text-lg font-bold text-orange-400">
                {fmtPct(row.borrowAPR)}
              </div>
            </div>
            <div className="bg-gray-800 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">Net APR</div>
              <div className={`text-lg font-bold ${netColor(row.netAPR)}`}>
                {fmtPct(row.netAPR)}
              </div>
            </div>
          </div>

          {/* Metrics table */}
          <div className="mb-6">
            <MetricRow label="Long (futures)" value={`${row.exchange} — ${row.token}/USDT PERP`} />
            <MetricRow label="Short (margin)" value="Bitget isolated margin" />
            <MetricRow label="Futures price" value={fmtPrice(row.futuresPrice)} />
            <MetricRow label="Bitget spot price" value={fmtPrice(row.spotPrice)} />
            <MetricRow
              label="Raw funding rate"
              value={`${fmt(row.rawFunding * 100, 6)}% / ${row.intervalHours}h`}
            />
            <MetricRow
              label="Spread (futures - spot)"
              value={`${fmtPct(row.spread)}`}
              className={row.spread >= 0 ? "text-blue-400" : "text-red-400"}
            />
            <MetricRow
              label="Pool cap (Bitget public)"
              value={(() => {
                if (row.borrowPoolFromUta === false) {
                  return "— (no Bitget borrow limit from current APIs / keys)";
                }
                const usd = row.borrowLiquidityUsdt;
                const native = row.borrowLiquidityToken;
                if (!usd && !native) return "—";
                const usdStr = usd != null
                  ? usd >= 1_000_000
                    ? `$${(usd / 1_000_000).toFixed(1)}M`
                    : `$${(usd / 1_000).toFixed(0)}K`
                  : null;
                let nativeStr = "";
                if (native != null) {
                  if (native >= 1_000_000) nativeStr = `${(native / 1_000_000).toFixed(2)}M ${row.token}`;
                  else if (native >= 1_000) nativeStr = `${(native / 1_000).toFixed(1)}K ${row.token}`;
                  else if (native >= 1) nativeStr = `${native.toFixed(2)} ${row.token}`;
                  else nativeStr = `${native.toPrecision(3)} ${row.token}`;
                }
                if (nativeStr && usdStr) return `${usdStr} · ${nativeStr}`;
                return nativeStr || usdStr || "—";
              })()}
              className="text-gray-300"
            />
            <MetricRow
              label="Next funding"
              value={nextFundingStr}
            />
            <MetricRow
              label="Updated"
              value={format(new Date(row.updatedAt), "HH:mm:ss")}
              className="text-gray-500"
            />
          </div>

          {/* Charts */}
          <div className="space-y-5">
            <MiniChart
              data={history.funding}
              label="Funding APR history (%)"
              color="#3b82f6"
              unit="%"
            />
            <MiniChart
              data={history.spread}
              label="Spread history (futures vs spot, %)"
              color="#8b5cf6"
              unit="%"
            />
            <MiniChart
              data={history.borrow}
              label="Borrow APR history (%)"
              color="#f97316"
              unit="%"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
