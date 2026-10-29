"use client";

import * as React from "react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  href?: string;
  onSelect?: () => void;
  tone?: "danger";
  disabled?: boolean;
  /** Draws a separator above this item. */
  separated?: boolean;
  external?: boolean;
}

const itemClass = "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-surface-muted";

/** "…" row menu. Items either navigate (href) or run a callback that usually opens a confirmation dialog. */
export function RowMenu({ items, label, align = "end", trigger }: { items: MenuItem[]; label: string; align?: "start" | "end"; trigger?: React.ReactNode }) {
  if (!items.length) return null;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {trigger ?? (
          <button type="button" className="inline-flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={label}>
            <MoreHorizontal className="size-4" />
          </button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-(--shadow-pop)">
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.separated ? <DropdownMenu.Separator className="my-1 h-px bg-border" /> : null}
              {item.href ? (
                <DropdownMenu.Item asChild disabled={item.disabled} className={cn(itemClass, item.tone === "danger" && "text-danger")}>
                  {item.external ? (
                    <a href={item.href} target="_blank" rel="noreferrer noopener">
                      {item.label}
                    </a>
                  ) : (
                    <Link href={item.href}>{item.label}</Link>
                  )}
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item disabled={item.disabled} onSelect={item.onSelect} className={cn(itemClass, item.tone === "danger" && "text-danger")}>
                  {item.label}
                </DropdownMenu.Item>
              )}
            </React.Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
