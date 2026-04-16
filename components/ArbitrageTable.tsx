"use client";

import { useState, useMemo, Fragment, useEffect } from "react";
import { ArbitrageRow } from "@/types";
import { formatDistanceToNow } from "date-fns";
import {
  formatUsdBorrowLiquidity,
  formatTokenBorrowLiquidity,
} from "@/lib/liquidity-display";

// ── Local types ──────────────────────────────────────────────────────────────

type SortDir = "asc" | "desc";
type ViewMode = "grouped" | "flat";

type GroupSortKey =
  | "token"
  | "rawFunding"
  | "netAPR"
  | "fundingAPR"
  | "borrowAPR"
  | "tradingFees"
  | "spread"
  | "exchangeCount"
  | "nextFundingTime"
  | "borrowLiquidity";

type FlatSortKey =
  | "token"
  | "exchange"
  | "rawFunding"
  | "fundingAPR"
  | "borrowAPR"
  | "tradingFees"
  | "netAPR"
  | "spread"
  | "nextFundingTime"
  | "borrowLiquidity";

interface TokenGroup {
  token: string;
  opportunities: ArbitrageRow[]; // sorted best → worst by netAPR
  best: ArbitrageRow;
  worst: ArbitrageRow;
  exchangeCount: number;
}

interface ArbitrageTableProps {
  rows: ArbitrageRow[];
  search: string;
  onRowClick: (row: ArbitrageRow) => void;
}

const MIN_LIQUIDITY_USD_LS_KEY = "fa.minLiquidityUsd.v1";

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtPct(n: number, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtRaw(n: number): string {
  if (n === null || n === undefined) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(5)}%`;
}

function fmtRoundTripFeesPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(3)}%`;
}

function fmtAvailBorrow(
  token: number | null | undefined,
  usdt: number | null | undefined,
): string {
  const t = token != null ? formatTokenBorrowLiquidity(token) : null;
  const u = usdt != null ? formatUsdBorrowLiquidity(usdt) : null;
  if (t && u) return `${t} (${u})`;
  if (u) return u;
  if (t) return t;
  return "—";
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "—";
  }
}

function netAprClass(n: number): string {
  if (n > 20) return "text-green-300 font-bold";
  if (n > 10) return "text-green-400 font-semibold";
  if (n > 5) return "text-green-500";
  if (n > 0) return "text-green-700";
  if (n < -10) return "text-red-400";
  if (n < 0) return "text-red-600";
  return "text-gray-400";
}

function fundingAprClass(n: number): string {
  if (n > 30) return "text-blue-300 font-semibold";
  if (n > 10) return "text-blue-400";
  return "text-blue-500";
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-gray-700 ml-1">↕</span>;
  return <span className="text-blue-400 ml-1">{dir === "asc" ? "↑" : "↓"}</span>;
}

// ── Grouping helpers ─────────────────────────────────────────────────────────

/**
 * Row shown in the collapsed group header: exchange with the largest funding APR
 * magnitude (|fundingAPR|). Tie-break: higher algebraic fundingAPR.
 * Expanded sub-rows stay sorted by net APR (best net first).
 */
function pickGroupLeadRow(opps: ArbitrageRow[]): ArbitrageRow {
  return opps.reduce((a, b) => {
    const absA = Math.abs(a.fundingAPR);
    const absB = Math.abs(b.fundingAPR);
    if (absB > absA) return b;
    if (absB < absA) return a;
    return b.fundingAPR > a.fundingAPR ? b : a;
  });
}

function buildGroups(rows: ArbitrageRow[]): TokenGroup[] {
  const map = new Map<string, ArbitrageRow[]>();
  for (const row of rows) {
    const arr = map.get(row.token) ?? [];
    arr.push(row);
    map.set(row.token, arr);
  }
  const groups: TokenGroup[] = [];
  for (const [token, opps] of map) {
    const sorted = [...opps].sort((a, b) => {
      if (b.netAPR !== a.netAPR) return b.netAPR - a.netAPR;
      return Math.abs(a.spread) - Math.abs(b.spread);
    });
    groups.push({
      token,
      opportunities: sorted,
      best: pickGroupLeadRow(opps),
      worst: sorted[sorted.length - 1],
      exchangeCount: sorted.length,
    });
  }
  return groups;
}

function sortGroups(groups: TokenGroup[], key: GroupSortKey, dir: SortDir): TokenGroup[] {
  return [...groups].sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    switch (key) {
      case "token":         av = a.token;                 bv = b.token;                 break;
      case "rawFunding":    av = a.best.rawFunding;       bv = b.best.rawFunding;       break;
      // Sort by the same value shown in the collapsed row (lead exchange)
      case "netAPR":        av = a.best.netAPR;           bv = b.best.netAPR;           break;
      case "fundingAPR":    av = a.best.fundingAPR;       bv = b.best.fundingAPR;       break;
      case "borrowAPR":     av = a.best.borrowAPR;        bv = b.best.borrowAPR;        break;
      case "spread":        av = a.best.spread;           bv = b.best.spread;           break;
      case "exchangeCount": av = a.exchangeCount;         bv = b.exchangeCount;         break;
      case "nextFundingTime":  av = a.best.nextFundingTime || 0;        bv = b.best.nextFundingTime || 0;        break;
      case "borrowLiquidity":  av = a.best.borrowLiquidityUsdt ?? -1;   bv = b.best.borrowLiquidityUsdt ?? -1;   break;
      case "tradingFees":      av = a.best.tradingFees;                 bv = b.best.tradingFees;                 break;
      default:                 av = a.best.netAPR;                      bv = b.best.netAPR;
    }
    if (typeof av === "string" && typeof bv === "string") {
      return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return dir === "asc"
      ? (av as number) - (bv as number)
      : (bv as number) - (av as number);
  });
}

// ── Grouped table ────────────────────────────────────────────────────────────

const GROUP_SORT_COLS: { key: GroupSortKey; label: string; title?: string }[] = [
  { key: "token",               label: "Token" },
  { key: "netAPR",              label: "Net APR",        title: "Best Net APR = Funding APR − Borrow APR − Trading fees" },
  { key: "fundingAPR",          label: "Funding APR",    title: "Best annualized funding APR (%)" },
  { key: "borrowAPR",           label: "Borrow APR",     title: "Gate Earn Uni borrow APR % (est_rate × 100)" },
  { key: "tradingFees",         label: "Fees",           title: "Round-trip trading fees % (2× Gate spot + 2× futures taker, from config)" },
  { key: "spread",           label: "Spread",            title: "Best spread: (futures − spot) / spot × 100%" },
  { key: "borrowLiquidity",  label: "Available Borrow",  title: "Gate available borrow (Earn Uni pool converted to USDT)" },
  { key: "exchangeCount",    label: "Exchanges",         title: "Number of exchanges with a match" },
  { key: "nextFundingTime",     label: "Next Funding",   title: "Next funding time for best exchange" },
];

interface GroupedTableProps {
  groups: TokenGroup[];
  sortKey: GroupSortKey;
  sortDir: SortDir;
  expandedTokens: Set<string>;
  onToggle: (token: string) => void;
  onSort: (key: GroupSortKey) => void;
  onRowClick: (row: ArbitrageRow) => void;
}

function GroupedTable({
  groups,
  sortKey,
  sortDir,
  expandedTokens,
  onToggle,
  onSort,
  onRowClick,
}: GroupedTableProps) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-gray-800 text-left">
          {/* Expand toggle */}
          <th className="w-8 px-3 py-3" />
          {/* Token (sortable) */}
          <th
            className="px-3 py-3 text-gray-400 font-medium cursor-pointer hover:text-white select-none whitespace-nowrap"
            onClick={() => onSort("token")}
          >
            Token
            <SortIcon active={sortKey === "token"} dir={sortDir} />
          </th>
          {/* Lead exchange — not sortable (largest |Funding APR| in group) */}
          <th
            className="px-3 py-3 text-gray-400 font-medium whitespace-nowrap"
            title="Exchange with the largest Funding APR magnitude in this token group"
          >
            Best Exchange
          </th>
          {/* Raw Funding — sortable */}
          <th
            className="px-3 py-3 text-gray-400 font-medium cursor-pointer hover:text-white select-none whitespace-nowrap"
            title="Best raw funding rate from exchange"
            onClick={() => onSort("rawFunding")}
          >
            Raw Funding
            <SortIcon active={sortKey === "rawFunding"} dir={sortDir} />
          </th>
          {/* Remaining sortable columns (skip token, already rendered above) */}
          {GROUP_SORT_COLS.filter((c) => c.key !== "token").map((col) => (
            <th
              key={col.key}
              className="px-3 py-3 text-gray-400 font-medium cursor-pointer hover:text-white select-none whitespace-nowrap"
              title={col.title}
              onClick={() => onSort(col.key)}
            >
              {col.label}
              <SortIcon active={sortKey === col.key} dir={sortDir} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const expanded = expandedTokens.has(group.token);
          const { best, worst } = group;
          const hasRange =
            group.exchangeCount > 1 && worst.netAPR !== best.netAPR;
          const lastIdx = group.opportunities.length - 1;

          return (
            <Fragment key={group.token}>
              {/* ── Main group row ── */}
              <tr
                onClick={() => onToggle(group.token)}
                className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer transition-colors group"
              >
                {/* Expand icon */}
                <td className="px-3 py-2.5 text-gray-600 text-xs">
                  <span
                    className={`inline-block transition-transform duration-150 ${
                      expanded ? "rotate-90" : ""
                    }`}
                  >
                    ▶
                  </span>
                </td>
                {/* Token */}
                <td className="px-3 py-2.5 font-semibold text-white group-hover:text-blue-400 transition-colors">
                  {group.token}
                </td>
                {/* Best Exchange */}
                <td className="px-3 py-2.5 text-gray-300 text-xs">
                  {best.exchange}
                </td>
                {/* Raw Funding */}
                <td className="px-3 py-2.5 font-mono text-gray-400 text-xs">
                  {fmtRaw(best.rawFunding)}
                  <span className="text-gray-600 ml-1">/{best.intervalHours}h</span>
                </td>
                {/* Net APR with optional range */}
                <td className={`px-3 py-2.5 font-mono ${netAprClass(best.netAPR)}`}>
                  <span>{fmtPct(best.netAPR, 2)}</span>
                  {hasRange && (
                    <span className="block text-gray-600 text-xs leading-none mt-0.5">
                      → {fmtPct(worst.netAPR, 2)}
                    </span>
                  )}
                </td>
                {/* Funding APR */}
                <td className={`px-3 py-2.5 font-mono ${fundingAprClass(best.fundingAPR)}`}>
                  {fmtPct(best.fundingAPR, 2)}
                </td>
                {/* Borrow APR */}
                <td className="px-3 py-2.5 font-mono text-orange-400">
                  {fmtPct(best.borrowAPR, 2)}
                </td>
                {/* Fees (round-trip) */}
                <td className="px-3 py-2.5 font-mono text-amber-200/90 text-xs whitespace-nowrap">
                  {fmtRoundTripFeesPct(best.tradingFees)}
                </td>
                {/* Spread */}
                <td className="px-3 py-2.5 font-mono text-purple-400">
                  {fmtPct(best.spread, 3)}
                </td>
                {/* Available Borrow */}
                <td className="px-3 py-2.5 font-mono text-cyan-400 text-xs whitespace-nowrap">
                  {fmtAvailBorrow(best.borrowLiquidityToken, best.borrowLiquidityUsdt)}
                </td>
                {/* Exchange count */}
                <td className="px-3 py-2.5 text-center">
                  <span className="px-2 py-0.5 bg-gray-800 rounded-full text-gray-300 text-xs">
                    {group.exchangeCount}
                  </span>
                </td>
                {/* Next Funding */}
                <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                  {fmtTime(best.nextFundingTime)}
                </td>
              </tr>

              {/* ── Expanded sub-rows ── */}
              {expanded &&
                group.opportunities.map((opp, idx) => (
                  <tr
                    key={opp.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRowClick(opp);
                    }}
                    className={`border-b border-gray-800/20 cursor-pointer transition-colors ${
                      idx === 0
                        ? "bg-green-950/25 hover:bg-green-950/45"
                        : "bg-gray-900/20 hover:bg-gray-800/25"
                    }`}
                  >
                    {/* Tree line */}
                    <td className="px-3 py-2 text-gray-700 text-xs text-right select-none">
                      {idx === 0 ? "┌" : idx === lastIdx ? "└" : "├"}
                    </td>
                    {/* Token col — empty (shown in parent) */}
                    <td className="px-3 py-2" />
                    {/* Exchange */}
                    <td className="px-3 py-2 text-xs">
                      <span className={idx === 0 ? "text-green-400 font-semibold" : "text-gray-300"}>
                        {opp.exchange}
                      </span>
                      {idx === 0 && (
                        <span className="ml-1.5 text-green-700 text-xs">★</span>
                      )}
                    </td>
                    {/* Raw Funding */}
                    <td className="px-3 py-2 font-mono text-gray-500 text-xs">
                      {fmtRaw(opp.rawFunding)}
                      <span className="text-gray-700 ml-1">/{opp.intervalHours}h</span>
                    </td>
                    {/* Net APR */}
                    <td className={`px-3 py-2 font-mono text-xs ${netAprClass(opp.netAPR)}`}>
                      {fmtPct(opp.netAPR, 2)}
                    </td>
                    {/* Funding APR */}
                    <td className={`px-3 py-2 font-mono text-xs ${fundingAprClass(opp.fundingAPR)}`}>
                      {fmtPct(opp.fundingAPR, 2)}
                    </td>
                    {/* Borrow APR */}
                    <td className="px-3 py-2 font-mono text-xs text-orange-400">
                      {fmtPct(opp.borrowAPR, 2)}
                    </td>
                    {/* Fees */}
                    <td className="px-3 py-2 font-mono text-xs text-amber-200/80 whitespace-nowrap">
                      {fmtRoundTripFeesPct(opp.tradingFees)}
                    </td>
                    {/* Spread */}
                    <td className="px-3 py-2 font-mono text-xs text-purple-400">
                      {fmtPct(opp.spread, 3)}
                    </td>
                    {/* Available Borrow — same for all exchanges of a token, show only in first sub-row */}
                    <td className="px-3 py-2 font-mono text-xs text-cyan-400/60 whitespace-nowrap">
                      {idx === 0
                        ? fmtAvailBorrow(opp.borrowLiquidityToken, opp.borrowLiquidityUsdt)
                        : ""}
                    </td>
                    {/* Exchanges count — empty for sub-row */}
                    <td className="px-3 py-2" />
                    {/* Next Funding */}
                    <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                      {fmtTime(opp.nextFundingTime)}
                    </td>
                  </tr>
                ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Flat table ───────────────────────────────────────────────────────────────

const FLAT_COLUMNS: { key: FlatSortKey; label: string; title?: string }[] = [
  { key: "token",               label: "Token" },
  { key: "exchange",            label: "Exchange" },
  { key: "rawFunding",          label: "Raw Funding" },
  { key: "fundingAPR",          label: "Funding APR",    title: "Annualized funding APR (%)" },
  { key: "borrowAPR",           label: "Borrow APR",     title: "Gate Earn Uni borrow APR % (est_rate × 100)" },
  { key: "tradingFees",         label: "Fees",           title: "Round-trip trading fees % (2× Gate spot + 2× futures taker)" },
  { key: "spread",          label: "Spread",           title: "(futures − spot) / spot × 100%" },
  { key: "netAPR",          label: "Net APR",          title: "Net APR = Funding APR − Borrow APR − Trading fees" },
  { key: "borrowLiquidity", label: "Available Borrow", title: "Gate available borrow (Earn Uni pool converted to USDT)" },
  { key: "nextFundingTime", label: "Next Funding" },
];

interface FlatTableProps {
  rows: ArbitrageRow[];
  sortKey: FlatSortKey;
  sortDir: SortDir;
  onSort: (key: FlatSortKey) => void;
  onRowClick: (row: ArbitrageRow) => void;
}

function FlatTable({ rows, sortKey, sortDir, onSort, onRowClick }: FlatTableProps) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-gray-800 text-left">
          {FLAT_COLUMNS.map((col) => (
            <th
              key={col.key}
              className="px-3 py-3 text-gray-400 font-medium cursor-pointer hover:text-white select-none whitespace-nowrap"
              title={col.title}
              onClick={() => onSort(col.key)}
            >
              {col.label}
              <SortIcon active={sortKey === col.key} dir={sortDir} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            onClick={() => onRowClick(row)}
            className="border-b border-gray-800/50 hover:bg-gray-800/50 cursor-pointer transition-colors group"
          >
            <td className="px-3 py-2.5 font-semibold text-white group-hover:text-blue-400 transition-colors">
              {row.token}
            </td>
            <td className="px-3 py-2.5 text-gray-300">{row.exchange}</td>
            <td className="px-3 py-2.5 font-mono text-gray-400 text-xs">
              {fmtRaw(row.rawFunding)}
              <span className="text-gray-600 ml-1">/{row.intervalHours}h</span>
            </td>
            <td className={`px-3 py-2.5 font-mono ${fundingAprClass(row.fundingAPR)}`}>
              {fmtPct(row.fundingAPR, 2)}
            </td>
            <td className="px-3 py-2.5 font-mono text-orange-400">
              {fmtPct(row.borrowAPR, 2)}
            </td>
            <td className="px-3 py-2.5 font-mono text-amber-200/90 text-xs whitespace-nowrap">
              {fmtRoundTripFeesPct(row.tradingFees)}
            </td>
            <td className="px-3 py-2.5 font-mono text-purple-400">
              {fmtPct(row.spread, 3)}
            </td>
            <td className={`px-3 py-2.5 font-mono ${netAprClass(row.netAPR)}`}>
              {fmtPct(row.netAPR, 2)}
            </td>
            <td className="px-3 py-2.5 font-mono text-cyan-400 text-xs whitespace-nowrap">
              {fmtAvailBorrow(row.borrowLiquidityToken, row.borrowLiquidityUsdt)}
            </td>
            <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
              {fmtTime(row.nextFundingTime)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function ArbitrageTable({ rows, search, onRowClick }: ArbitrageTableProps) {
  const [mode, setMode] = useState<ViewMode>("grouped");
  const [groupSortKey, setGroupSortKey] = useState<GroupSortKey>("netAPR");
  const [flatSortKey, setFlatSortKey] = useState<FlatSortKey>("netAPR");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedTokens, setExpandedTokens] = useState<Set<string>>(new Set());
  const [minLiquidityUsd, setMinLiquidityUsd] = useState<number>(0);

  // Load/persist minimum liquidity filter (USD)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(MIN_LIQUIDITY_USD_LS_KEY);
      if (!raw) return;
      const n = Number(raw);
      if (!Number.isNaN(n) && n >= 0) setMinLiquidityUsd(n);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MIN_LIQUIDITY_USD_LS_KEY, String(minLiquidityUsd));
    } catch {
      // ignore
    }
  }, [minLiquidityUsd]);

  function toggleExpand(token: string) {
    setExpandedTokens((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  function handleModeChange(newMode: ViewMode) {
    setMode(newMode);
    setSortDir("desc");
    setGroupSortKey("netAPR");
    setFlatSortKey("netAPR");
  }

  function handleGroupSort(key: GroupSortKey) {
    if (key === groupSortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setGroupSortKey(key); setSortDir("desc"); }
  }

  function handleFlatSort(key: FlatSortKey) {
    if (key === flatSortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setFlatSortKey(key); setSortDir("desc"); }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const ok =
          r.token.toLowerCase().includes(q) || r.exchange.toLowerCase().includes(q);
        if (!ok) return false;
      }
      if (minLiquidityUsd > 0) {
        const liq = r.borrowLiquidityUsdt ?? 0;
        if (liq < minLiquidityUsd) return false;
      }
      return true;
    });
  }, [rows, search, minLiquidityUsd]);

  const groups = useMemo(
    () => sortGroups(buildGroups(filtered), groupSortKey, sortDir),
    [filtered, groupSortKey, sortDir]
  );

  const flatRows = useMemo(() => {
    function getFlatValue(row: ArbitrageRow, key: FlatSortKey): number | string {
      if (key === "borrowLiquidity") return row.borrowLiquidityUsdt ?? -1;
      if (key === "tradingFees") return row.tradingFees;
      const v = row[key as keyof ArbitrageRow];
      return (v === null ? -1 : v) as number | string;
    }
    return [...filtered].sort((a, b) => {
      const av = getFlatValue(a, flatSortKey);
      const bv = getFlatValue(b, flatSortKey);
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc"
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number);
    });
  }, [filtered, flatSortKey, sortDir]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500">
        No data yet. Waiting for scan...
      </div>
    );
  }

  return (
    <div>
      {/* Mode toggle bar */}
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500 mr-1">View:</span>
        <button
          onClick={() => handleModeChange("grouped")}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === "grouped"
              ? "bg-blue-600 text-white"
              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
          }`}
        >
          Grouped by token
        </button>
        <button
          onClick={() => handleModeChange("flat")}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === "flat"
              ? "bg-blue-600 text-white"
              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
          }`}
        >
          All rows
        </button>
        <span className="text-xs text-gray-600 ml-2">
          {mode === "grouped"
            ? `${groups.length} tokens · ${rows.length} pairs`
            : `${flatRows.length} rows${flatRows.length !== rows.length ? ` (${rows.length} total)` : ""}`}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">Min Liquidity $</span>
          <input
            type="number"
            min={0}
            step={100}
            value={minLiquidityUsd}
            onChange={(e) =>
              setMinLiquidityUsd(Math.max(0, Number(e.target.value) || 0))
            }
            placeholder="0"
            title="Hide rows where Available Borrow (USDT) is below this threshold"
            className="w-36 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        {mode === "grouped" ? (
          <GroupedTable
            groups={groups}
            sortKey={groupSortKey}
            sortDir={sortDir}
            expandedTokens={expandedTokens}
            onToggle={toggleExpand}
            onSort={handleGroupSort}
            onRowClick={onRowClick}
          />
        ) : (
          <FlatTable
            rows={flatRows}
            sortKey={flatSortKey}
            sortDir={sortDir}
            onSort={handleFlatSort}
            onRowClick={onRowClick}
          />
        )}
      </div>
    </div>
  );
}
