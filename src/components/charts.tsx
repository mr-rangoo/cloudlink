"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/utils";

/**
 * Cloudlink bar chart. Conventions (data-viz guide): one y-axis, thin bars with 4px rounded data-ends,
 * fixed categorical slot order (never cycled), recessive grid, legend for ≥2 series, hover tooltip on every bar,
 * and a data table rendered by the caller (relief for the light-mode contrast warning and for screen readers).
 */
export interface Series {
  key: string;
  label: string;
  slot: 1 | 2 | 3 | 4 | 5 | 6;
}

type Row = Record<string, string | number>;

const compact = new Intl.NumberFormat("en-KE", { notation: "compact", maximumFractionDigits: 1 });

function monthLabel(v: string): string {
  if (!/^\d{4}-\d{2}$/.test(v)) return v;
  const [y, m] = v.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-KE", { month: "short", year: "2-digit", timeZone: "UTC" });
}

interface TooltipEntry {
  dataKey?: string | number | ((obj: unknown) => unknown);
  name?: string | number;
  value?: number | string | Array<number | string>;
}

function ChartTooltip({ active, payload, label, currency, series }: { active?: boolean; payload?: TooltipEntry[]; label?: string | number; currency?: string; series: Series[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-(--shadow-pop)">
      <p className="mb-1 font-medium text-foreground">{monthLabel(String(label))}</p>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        return (
          <p key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ background: `var(--series-${s?.slot ?? 1})` }} aria-hidden />
              {s?.label ?? p.name}
            </span>
            <span className="tabular font-medium text-foreground">{currency ? formatMoney(Number(p.value ?? 0).toFixed(2), currency) : Number(p.value ?? 0).toLocaleString("en-KE")}</span>
          </p>
        );
      })}
    </div>
  );
}

export function BarSeriesChart({ data, xKey, series, currency, stacked, height = 260, ariaLabel }: { data: Row[]; xKey: string; series: Series[]; currency?: string; stacked?: boolean; height?: number; ariaLabel: string }) {
  const numeric = React.useMemo(() => data.map((r) => ({ ...r, ...Object.fromEntries(series.map((s) => [s.key, Number(r[s.key] ?? 0)])) })), [data, series]);
  return (
    <figure className="space-y-2" aria-label={ariaLabel}>
      {series.length > 1 ? (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: `var(--series-${s.slot})` }} aria-hidden />
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
      <div style={{ height }} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={numeric} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey={xKey} tickFormatter={monthLabel} tick={{ fill: "var(--chart-ink)", fontSize: 11 }} axisLine={{ stroke: "var(--chart-axis)" }} tickLine={false} />
            <YAxis tickFormatter={(v: number) => compact.format(v)} tick={{ fill: "var(--chart-ink)", fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
            <Tooltip cursor={{ fill: "var(--surface-muted)", opacity: 0.6 }} content={<ChartTooltip currency={currency} series={series} />} />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={`var(--series-${s.slot})`}
                stackId={stacked ? "stack" : undefined}
                radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 0, 0]}
                maxBarSize={36}
                stroke={stacked ? "var(--surface)" : undefined}
                strokeWidth={stacked ? 2 : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
