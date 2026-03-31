"use client";

import { useQuery } from "@tanstack/react-query";
import { ScanResponse } from "@/types";
import { useHistory } from "./useHistory";
import { useEffect } from "react";

const REFETCH_INTERVAL_MS = 30_000; // 30 seconds

async function fetchScan(): Promise<ScanResponse> {
  const res = await fetch("/api/scan");
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
    retry: 3,
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
    errors: query.data?.errors ?? {},
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    getHistory,
    refetch: query.refetch,
  };
}
