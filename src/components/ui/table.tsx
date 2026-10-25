import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Responsive table: a real <table> on md+ screens; on small screens each row collapses into a
 * stacked card using the `data-label` attribute on cells (see `Td`).
 */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function THead(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="hidden border-b border-border bg-surface-muted/60 text-left text-xs font-medium text-muted-foreground md:table-header-group" {...props} />;
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn("px-4 py-2.5 font-medium whitespace-nowrap", className)} {...props} />;
}

export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className="block divide-y divide-border md:table-row-group" {...props} />;
}

export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("block px-4 py-3 hover:bg-surface-muted/40 md:table-row md:px-0 md:py-0", className)} {...props} />;
}

export function Td({ className, label, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { label?: string }) {
  return (
    <td
      data-label={label}
      className={cn(
        "flex items-center justify-between gap-4 py-1 md:table-cell md:px-4 md:py-3",
        "before:text-xs before:font-medium before:text-muted-foreground before:content-[attr(data-label)] md:before:content-none",
        className,
      )}
      {...props}
    />
  );
}

export function Pagination({ page, totalPages, total, hrefFor }: { page: number; totalPages: number; total: number; hrefFor: (page: number) => string }) {
  return (
    <nav className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm" aria-label="Pagination">
      <p className="text-muted-foreground">
        {total} record{total === 1 ? "" : "s"} · page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 hover:bg-surface-muted" rel="prev">
            <ChevronLeft className="size-4" /> Previous
          </Link>
        ) : (
          <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 opacity-40" aria-disabled>
            <ChevronLeft className="size-4" /> Previous
          </span>
        )}
        {page < totalPages ? (
          <Link href={hrefFor(page + 1)} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 hover:bg-surface-muted" rel="next">
            Next <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 opacity-40" aria-disabled>
            Next <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </nav>
  );
}

/** Build list-page URLs preserving current filters. */
export function buildHref(base: string, current: Record<string, string | undefined>, patch: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
