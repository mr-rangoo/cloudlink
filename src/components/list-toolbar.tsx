import Link from "next/link";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Server-rendered list toolbar. Search is a plain GET form (works without JavaScript);
 * filters are links that preserve the other query parameters.
 */
export function SearchForm({ action, q, placeholder, hidden }: { action: string; q?: string; placeholder: string; hidden?: Record<string, string | undefined> }) {
  return (
    <form action={action} method="get" role="search" className="relative w-full sm:max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <label htmlFor="list-search" className="sr-only">
        {placeholder}
      </label>
      <input
        id="list-search"
        name="q"
        defaultValue={q}
        placeholder={placeholder}
        className="h-9 w-full rounded-full border border-border-strong bg-surface pl-8 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      />
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
    </form>
  );
}

export function FilterTabs({ items, active, label }: { items: Array<{ value: string; label: string; href: string; count?: number }>; active: string; label: string }) {
  return (
    <nav aria-label={label} className="max-w-full overflow-x-auto">
      <div className="inline-flex gap-0.5 rounded-full border border-border bg-surface p-1">
        {items.map((i) => {
          const on = i.value === active;
          return (
            <Link
              key={i.value}
              href={i.href}
              aria-current={on ? "page" : undefined}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
                on ? "bg-foreground text-background" : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
              )}
            >
              {i.label}
              {i.count !== undefined ? <span className={cn("tabular rounded-full px-1.5 text-[11px] font-semibold", on ? "bg-background/15" : "bg-surface-muted")}>{i.count}</span> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
