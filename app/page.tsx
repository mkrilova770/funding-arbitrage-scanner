"use client";

import { useState } from "react";
import { Providers } from "@/components/Providers";
import { ArbitrageTable } from "@/components/ArbitrageTable";
import { TokenModal } from "@/components/TokenModal";
import { StatusBar } from "@/components/StatusBar";
import { useArbitrageData } from "@/hooks/useArbitrageData";
import { ArbitrageRow } from "@/types";

function Dashboard() {
  const {
    rows,
    fetchedAt,
    errors,
    isLoading,
    isFetching,
    isError,
    getHistory,
    refetch,
  } = useArbitrageData();

  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<ArbitrageRow | null>(null);

  return (
    <div className="min-h-screen bg-[#0a0e17]">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
              FA
            </div>
            <div>
              <h1 className="text-white font-semibold leading-tight">
                Funding Arbitrage Scanner
              </h1>
              <p className="text-gray-500 text-xs leading-tight">
                Gate.io margin short · Long → Futures
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-1 max-w-md">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search token or exchange..."
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {isFetching ? "..." : "↺ Refresh"}
            </button>
          </div>
        </div>
      </header>

      {/* Status bar */}
      <div className="max-w-screen-2xl mx-auto px-4 py-2">
        <StatusBar
          fetchedAt={fetchedAt}
          isFetching={isFetching}
          isError={isError}
          rowCount={rows.length}
          errors={errors}
        />
      </div>

      {/* Legend */}
      <div className="max-w-screen-2xl mx-auto px-4 pb-2">
        <div className="flex flex-wrap gap-4 text-xs text-gray-500">
          <span>
            <span className="text-white">Long →</span> Futures exchange (always)
          </span>
          <span>
            <span className="text-white">Short →</span> Gate.io isolated margin
            (always)
          </span>
          <span className="text-gray-700">·</span>
          <span>
            <span className="text-blue-400">Funding APR</span> = Raw Rate ×
            (8760 / interval_h) × 100
          </span>
          <span className="text-gray-700">·</span>
          <span>
            <span className="text-green-400">Net APR</span> = Funding APR −
            Borrow APR
          </span>
          <span className="text-gray-700">·</span>
          <span>
            <span className="text-purple-400">Spread</span> = (Futures − Spot)
            / Spot × 100 (not in APR)
          </span>
        </div>
      </div>

      {/* Main table */}
      <main className="max-w-screen-2xl mx-auto px-4 pb-8">
        <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <div className="text-gray-400 text-sm">
                Loading data from 10 exchanges...
              </div>
              <div className="text-gray-600 text-xs">
                First load may take 15-30 seconds
              </div>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <div className="text-red-400 text-sm">Failed to load data</div>
              <button
                onClick={() => refetch()}
                className="text-blue-400 text-sm hover:underline"
              >
                Retry
              </button>
            </div>
          ) : (
            <ArbitrageTable
              rows={rows}
              search={search}
              onRowClick={setSelectedRow}
            />
          )}
        </div>
      </main>

      {/* Token Modal */}
      {selectedRow && (
        <TokenModal
          row={selectedRow}
          history={getHistory(selectedRow.id)}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Providers>
      <Dashboard />
    </Providers>
  );
}
