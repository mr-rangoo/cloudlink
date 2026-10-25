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
        className="h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      />
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
    </form>
  );
}

export function FilterTabs({ items, active, label }: { items: Array<{ value: string; label: string; href: string; count?: number }>; active: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {items.map((i) => (
        <Link
          key={i.value}
          href={i.href}
          aria-current={i.value === active ? "page" : undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
            i.value === active ? "bg-accent-soft text-accent" : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
          )}
        >
          {i.label}
          {i.count !== undefined ? <span className="tabular rounded bg-surface px-1.5 text-xs text-muted-foreground">{i.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
