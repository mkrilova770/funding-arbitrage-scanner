"use client";

import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";

interface StatusBarProps {
  fetchedAt: number;
  isFetching: boolean;
  isError: boolean;
  rowCount: number;
  errors: Record<string, string>;
}

export function StatusBar({
  fetchedAt,
  isFetching,
  isError,
  rowCount,
  errors,
}: StatusBarProps) {
  const errorKeys = Object.keys(errors);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const lastUpdatedSeconds = useMemo(() => {
    if (!fetchedAt) return null;
    const s = Math.floor((now - fetchedAt) / 1000);
    return s >= 0 ? s : 0;
  }, [now, fetchedAt]);

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

      {lastUpdatedSeconds != null && !isFetching && (
        <span className="text-gray-600">
          Last updated: {lastUpdatedSeconds}s ago
        </span>
      )}

      {rowCount > 0 && (
        <span className="text-gray-600">
          {rowCount} opportunities found
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
