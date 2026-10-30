import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface StripStat {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  href?: string;
  tone?: "default" | "accent" | "danger" | "success";
}

const toneClass = { default: "", accent: "text-accent", danger: "text-danger", success: "text-success" } as const;

/**
 * A row of headline figures in one card. Cells grow to fill each wrapped row; every cell draws its left and top
 * rule and is shifted by 1px, so the card's outer edge hides the rules on the first row and column.
 */
export function StatStrip({ stats, className }: { stats: StripStat[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap overflow-hidden rounded-2xl border border-border bg-surface", className)}>
      {stats.map((s) => {
        const body = (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
            <p className={cn("tabular mt-1.5 truncate font-bold tracking-tight", typeof s.value === "string" && s.value.length > 11 ? "text-lg" : "text-2xl", toneClass[s.tone ?? "default"])} title={typeof s.value === "string" ? s.value : undefined}>
              {s.value}
            </p>
            {s.hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.hint}</p> : null}
          </>
        );
        return (
          <div key={s.label} className="-ml-px -mt-px min-w-0 flex-1 basis-36 border-l border-t border-border px-4 py-4">
            {s.href ? (
              <Link href={s.href} className="block rounded-sm hover:opacity-80">
                {body}
              </Link>
            ) : (
              body
            )}
          </div>
        );
      })}
    </div>
  );
}
