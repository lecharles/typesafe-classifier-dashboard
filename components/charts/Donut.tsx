"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { colorAt } from "./palette";

export type DonutDatum = { name: string; value: number };

export function Donut({
  data,
  height = 260,
  onSelect,
}: {
  data: DonutDatum[];
  height?: number;
  /** Called with the slice name on click (also makes slices clickable). */
  onSelect?: (name: string) => void;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
          stroke="none"
        >
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={colorAt(i)}
              onClick={onSelect ? () => onSelect(d.name) : undefined}
              style={{ cursor: onSelect ? "pointer" : "auto" }}
            />
          ))}
        </Pie>
        <Tooltip
          formatter={(v: number) => [`${v} (${total ? Math.round((v / total) * 100) : 0}%)`, ""]}
          contentStyle={{ background: "#141925", border: "1px solid #262f42", borderRadius: 10, color: "#e6e9ef" }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "#9aa4b8" }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
