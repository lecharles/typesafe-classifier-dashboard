"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { AXIS, GRID, colorAt } from "./palette";

export type HistogramDatum = { bin: string; count: number };

export function Histogram({
  data,
  height = 240,
  color,
  colorByIndex = false,
}: {
  data: HistogramDatum[];
  height?: number;
  color?: string;
  colorByIndex?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="bin" tick={{ fill: AXIS, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fill: AXIS, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          contentStyle={{ background: "#141925", border: "1px solid #262f42", borderRadius: 10, color: "#e6e9ef" }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} fill={color ?? colorAt(0)}>
          {colorByIndex && data.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
