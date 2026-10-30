"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Bell, Bot, Building2, CreditCard, FileText, MessageSquare, Package, Palette, Plug, Router, ScrollText, Search, ShieldCheck, Store, Wallet, Wifi, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  label: string;
  hint: string;
  icon: string;
  /** A section of this page (?tab=…) or another page. */
  tab?: string;
  href?: string;
}

export interface SettingsNavGroup {
  group: string;
  items: SettingsNavItem[];
}

const ICONS: Record<string, LucideIcon> = { Bell, Bot, Building2, CreditCard, FileText, MessageSquare, Package, Palette, Plug, Router, ScrollText, ShieldCheck, Store, Wallet, Wifi };

/** Grouped settings menu with a filter box. Links to other pages are marked as such. */
export function SettingsNav({ groups, active }: { groups: SettingsNavGroup[]; active: string }) {
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !needle || `${g.group} ${i.label} ${i.hint}`.toLowerCase().includes(needle)) }))
    .filter((g) => g.items.length);
  return (
    <nav aria-label="Settings sections" className="space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <label htmlFor="settings-filter" className="sr-only">
          Find a setting
        </label>
        <input
          id="settings-filter"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a setting…"
          className="h-10 w-full rounded-xl border border-border-strong bg-surface pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
      </div>
      {filtered.length === 0 ? <p className="px-2 text-sm text-muted-foreground">No setting matches “{q}”.</p> : null}
      {filtered.map((g) => (
        <div key={g.group} className="space-y-1.5">
          <p className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{g.group}</p>
          <ul className="space-y-1">
            {g.items.map((i) => {
              const href = i.tab ? (i.tab === "general" ? "/settings" : `/settings?tab=${i.tab}`) : i.href!;
              const current = i.tab === active;
              const Icon = ICONS[i.icon] ?? Plug;
              return (
                <li key={`${g.group}-${i.label}`}>
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    className={cn("flex items-center gap-3 rounded-xl border px-2.5 py-2 text-sm transition-colors", current ? "border-accent/70 bg-surface" : "border-transparent hover:bg-surface")}
                  >
                    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border", current ? "border-accent/40 bg-accent-soft text-accent" : "border-border bg-surface-muted text-muted-foreground")}>
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium leading-tight">{i.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{i.hint}</span>
                    </span>
                    {i.href ? <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-label="Opens another page" /> : null}
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
