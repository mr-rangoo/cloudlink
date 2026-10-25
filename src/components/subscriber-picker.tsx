"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export interface PickedSubscriber {
  id: string;
  displayName: string;
  accountNumber: string;
}

/** Accessible async combobox that searches subscribers via the API (server enforces scope). */
export function SubscriberPicker({ id, value, onChange, invalid }: { id: string; value: PickedSubscriber | null; onChange: (s: PickedSubscriber | null) => void; invalid?: boolean }) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PickedSubscriber[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<{ data: PickedSubscriber[] }>(`/subscribers?q=${encodeURIComponent(q)}&pageSize=8`, { signal: ctrl.signal });
        setResults(res.data);
        setActive(0);
        setOpen(true);
      } catch {
        /* aborted or failed: keep previous results */
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  if (value) {
    return (
      <div className="flex h-9 items-center justify-between rounded-md border border-border-strong bg-surface-muted px-3 text-sm">
        <span>
          <span className="font-medium">{value.displayName}</span> <span className="font-mono text-xs text-muted-foreground">{value.accountNumber}</span>
        </span>
        <button type="button" onClick={() => onChange(null)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear subscriber">
          <X className="size-4" />
        </button>
      </div>
    );
  }

  const choose = (s: PickedSubscriber | undefined) => {
    if (!s) return;
    onChange(s);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-activedescendant={open && results[active] ? `${id}-opt-${active}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value.trim().length < 2) {
            setResults([]);
            setOpen(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            choose(results[active]);
          } else if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search name, account no. or phone"
        autoComplete="off"
        className={cn(
          "h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
          invalid && "border-danger",
        )}
      />
      {open ? (
        <ul id={`${id}-list`} role="listbox" className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-(--shadow-pop)">
          {loading && !results.length ? <li className="px-3 py-2 text-sm text-muted-foreground">Searching…</li> : null}
          {!loading && !results.length ? <li className="px-3 py-2 text-sm text-muted-foreground">No subscribers found</li> : null}
          {results.map((s, i) => (
            <li
              key={s.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-center justify-between rounded px-3 py-2 text-sm", i === active && "bg-surface-muted")}
            >
              <span className="font-medium">{s.displayName}</span>
              <span className="font-mono text-xs text-muted-foreground">{s.accountNumber}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
