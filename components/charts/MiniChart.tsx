"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { DataPoint } from "@/types";
import { format } from "date-fns";

interface MiniChartProps {
  data: DataPoint[];
  label: string;
  color?: string;
  unit?: string;
  height?: number;
}

function formatValue(v: number, unit: string) {
  return `${v.toFixed(4)}${unit}`;
}

export function MiniChart({
  data,
  label,
  color = "#3b82f6",
  unit = "%",
  height = 120,
}: MiniChartProps) {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-gray-500 text-sm"
        style={{ height }}
      >
        Collecting data...
      </div>
    );
  }

  const chartData = data.map((p) => ({
    ts: p.ts,
    value: p.value,
    time: format(new Date(p.ts), "HH:mm"),
  }));

  const values = data.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.abs(max - min) * 0.1 || 0.01;

  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData}>
          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[min - padding, max + padding]}
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v.toFixed(2)}${unit}`}
            width={55}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#9ca3af" }}
            itemStyle={{ color: color }}
            formatter={(v) => [formatValue(Number(v ?? 0), unit), label]}
          />
          <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
