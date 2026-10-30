"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS, NAV_PARENTS } from "@/lib/navigation";

/** "NETWORK — LIVE SESSIONS": the section and page, derived from the navigation catalogue. */
export function PageEyebrow() {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const item = NAV_ITEMS.find((i) => i.href === `/${parts[0] ?? ""}`);
  if (!item) return null;
  const section = item.parent ? (NAV_PARENTS[item.parent]?.label ?? item.group) : item.group;
  const page = parts.length > 1 ? `${item.label} — ${parts[1] === "new" ? "New" : "Details"}` : item.label;
  return (
    <p className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      <span>{section}</span>
      {page !== section ? (
        <>
          <span aria-hidden className="h-px w-4 bg-border-strong" />
          <span>{page}</span>
        </>
      ) : null}
    </p>
  );
}
