"use client";

import { useQuery } from "@tanstack/react-query";
import { ScanResponse } from "@/types";
import { useHistory } from "./useHistory";
import { useEffect } from "react";

const REFETCH_INTERVAL_MS = 30_000; // 30 seconds
/** Abort slow scans so UI can show error instead of infinite spinner */
const SCAN_FETCH_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.NEXT_PUBLIC_SCAN_TIMEOUT_MS ?? "120000", 10) || 120_000
);

async function fetchScan(): Promise<ScanResponse> {
  const res = await fetch("/api/scan", {
    signal: AbortSignal.timeout(SCAN_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Scan API error: ${res.status}`);
  return res.json();
}

export function useArbitrageData() {
  const { recordRows, getHistory } = useHistory();

  const query = useQuery<ScanResponse>({
    queryKey: ["arbitrage-scan"],
    queryFn: fetchScan,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: REFETCH_INTERVAL_MS,
    retry: (failureCount, err) => {
      const name = err instanceof Error ? err.name : "";
      const msg = err instanceof Error ? err.message : String(err);
      if (name === "AbortError" || msg.includes("aborted") || msg.includes("timeout")) {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });

  // Accumulate history on every successful fetch
  useEffect(() => {
    if (query.data?.rows) {
      recordRows(query.data.rows);
    }
  }, [query.data, recordRows]);

  return {
    rows: query.data?.rows ?? [],
    fetchedAt: query.data?.fetchedAt ?? 0,
    bitgetBorrow: query.data?.bitgetBorrow ?? null,
    errors: query.data?.errors ?? {},
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    getHistory,
    refetch: query.refetch,
  };
}
