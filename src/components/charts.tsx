"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

/** Line style per slot: slot 1 solid, later slots dashed, so series differ by more than colour. */
const DASH: Record<number, string | undefined> = { 1: undefined, 2: "5 3", 3: "2 3", 4: "8 3 2 3" };

function LegendSwatch({ slot }: { slot: number }) {
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="17" y2="4" stroke={`var(--series-${slot})`} strokeWidth="2" strokeDasharray={DASH[slot]} strokeLinecap="round" />
    </svg>
  );
}

function timeFormatter(timeZone: string, spanMs: number, withDate = false) {
  const f = new Intl.DateTimeFormat("en-KE", spanMs <= 36 * 3_600_000 && !withDate ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone } : { day: "numeric", month: "short", ...(withDate ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}), timeZone });
  return (v: number) => f.format(new Date(v));
}

function TimeTooltip({ active, payload, label, series, unit, format, digits }: { active?: boolean; payload?: TooltipEntry[]; label?: number; series: Series[]; unit: string; format: (v: number) => string; digits: number }) {
  if (!active || !payload?.length || label === undefined) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-(--shadow-pop)">
      <p className="mb-1 font-medium text-foreground">{format(Number(label))}</p>
      {series.map((s) => {
        const v = payload.find((p) => p.dataKey === s.key)?.value;
        return (
          <p key={s.key} className="flex items-center justify-between gap-4 text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <LegendSwatch slot={s.slot} />
              {s.label}
            </span>
            <span className="tabular font-medium text-foreground">{v === null || v === undefined ? "No data" : `${Number(v).toLocaleString("en-KE", { maximumFractionDigits: digits })} ${unit}`}</span>
          </p>
        );
      })}
    </div>
  );
}

/**
 * Time-series line chart: one y-axis, 2px lines (dashed from the second series on), gaps where there is no data,
 * crosshair tooltip, and a legend for two or more series. Callers render a data table alongside.
 */
export function LineSeriesChart({
  data,
  series,
  unit,
  timeZone,
  height = 220,
  yMax,
  digits = 1,
  ariaLabel,
}: {
  data: Array<{ t: number } & Record<string, number | null>>;
  series: Series[];
  unit: string;
  timeZone: string;
  height?: number;
  yMax?: number;
  digits?: number;
  ariaLabel: string;
}) {
  const span = data.length > 1 ? data[data.length - 1]!.t - data[0]!.t : 0;
  const tick = React.useMemo(() => timeFormatter(timeZone, span), [timeZone, span]);
  const full = React.useMemo(() => timeFormatter(timeZone, span, true), [timeZone, span]);
  return (
    <figure className="space-y-2" aria-label={ariaLabel}>
      {series.length > 1 ? (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <LegendSwatch slot={s.slot} />
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
      <div style={{ height }} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={tick} tick={{ fill: "var(--chart-ink)", fontSize: 11 }} axisLine={{ stroke: "var(--chart-axis)" }} tickLine={false} minTickGap={28} />
            <YAxis domain={[0, yMax ?? "auto"]} allowDecimals={false} tickFormatter={(v: number) => compact.format(v)} tick={{ fill: "var(--chart-ink)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }} content={<TimeTooltip series={series} unit={unit} format={full} digits={digits} />} />
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="linear"
                stroke={`var(--series-${s.slot})`}
                strokeWidth={2}
                strokeDasharray={DASH[s.slot]}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
