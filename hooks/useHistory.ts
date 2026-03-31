import { useRef, useCallback } from "react";
import { DataPoint, TokenHistory, ArbitrageRow } from "@/types";

const MAX_HISTORY_POINTS = 100;

function addPoint(arr: DataPoint[], value: number, ts: number): DataPoint[] {
  const next = [...arr, { ts, value }];
  return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
}

/**
 * In-memory ring buffer for storing historical data points per token+exchange.
 * Data persists only while the page is open (React component lifetime).
 */
export function useHistory() {
  // Key: `${token}-${exchange}`
  const historyRef = useRef<Map<string, TokenHistory>>(new Map());

  const recordRows = useCallback((rows: ArbitrageRow[]) => {
    for (const row of rows) {
      const key = row.id;
      const existing = historyRef.current.get(key) ?? {
        funding: [],
        spread: [],
        borrow: [],
      };

      historyRef.current.set(key, {
        funding: addPoint(existing.funding, row.fundingAPR, row.updatedAt),
        spread: addPoint(existing.spread, row.spread, row.updatedAt),
        borrow: addPoint(existing.borrow, row.borrowAPR, row.updatedAt),
      });
    }
  }, []);

  const getHistory = useCallback((id: string): TokenHistory => {
    return historyRef.current.get(id) ?? { funding: [], spread: [], borrow: [] };
  }, []);

  return { recordRows, getHistory };
}
