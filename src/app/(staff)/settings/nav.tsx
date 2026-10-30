"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  label: string;
  hint: string;
  /** A section of this page (?tab=…) or another page. */
  tab?: string;
  href?: string;
}

export interface SettingsNavGroup {
  group: string;
  items: SettingsNavItem[];
}

/** Grouped settings menu with a filter box. Links to other pages are marked as such. */
export function SettingsNav({ groups, active }: { groups: SettingsNavGroup[]; active: string }) {
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !needle || `${g.group} ${i.label} ${i.hint}`.toLowerCase().includes(needle)) }))
    .filter((g) => g.items.length);
  return (
    <nav aria-label="Settings sections" className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <label htmlFor="settings-filter" className="sr-only">
          Find a setting
        </label>
        <input
          id="settings-filter"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a setting…"
          className="h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
      </div>
      {filtered.length === 0 ? <p className="px-2 text-sm text-muted-foreground">No setting matches “{q}”.</p> : null}
      {filtered.map((g) => (
        <div key={g.group} className="space-y-1">
          <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.group}</p>
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const href = i.tab ? (i.tab === "general" ? "/settings" : `/settings?tab=${i.tab}`) : i.href!;
              const current = i.tab === active;
              return (
                <li key={`${g.group}-${i.label}`}>
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    className={cn("flex items-start justify-between gap-2 rounded-md px-2.5 py-2 text-sm transition-colors", current ? "bg-accent-soft text-accent" : "hover:bg-surface-muted")}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{i.label}</span>
                      <span className={cn("block truncate text-xs", current ? "text-accent/80" : "text-muted-foreground")}>{i.hint}</span>
                    </span>
                    {i.href ? <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="Opens another page" /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
