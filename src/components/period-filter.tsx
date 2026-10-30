import { FilterTabs } from "@/components/list-toolbar";
import { buildHref } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "all", label: "All time" },
];

/**
 * Period presets as links, plus a custom date range form (GET). Other list parameters are carried over;
 * the page number is reset.
 */
export function PeriodFilter({ action, current, period, from, to }: { action: string; current: Record<string, string | undefined>; period: string; from?: string; to?: string }) {
  const keep = Object.entries(current).filter(([k, v]) => v && !["period", "from", "to", "page"].includes(k));
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <FilterTabs label="Period" active={period} items={PRESETS.map((p) => ({ ...p, href: buildHref(action, current, { period: p.value === "all" ? undefined : p.value, from: undefined, to: undefined, page: undefined }) }))} />
      <form action={action} className="flex flex-wrap items-center gap-2" aria-label="Custom dates">
        {keep.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="hidden" name="period" value="custom" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={from} required className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-foreground" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={to} required className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-foreground" />
        </label>
        <Button type="submit" size="sm" variant={period === "custom" ? "primary" : "secondary"}>
          Show
        </Button>
      </form>
    </div>
  );
}
