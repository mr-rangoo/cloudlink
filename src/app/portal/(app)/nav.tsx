"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { CloudlinkMark } from "@/components/shell/logo";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/portal/home", label: "Home" },
  { href: "/portal/invoices", label: "Invoices" },
  { href: "/portal/payments", label: "Payments" },
  { href: "/portal/tickets", label: "Support" },
  { href: "/portal/profile", label: "Profile" },
];

export function PortalNav({ organization, customer }: { organization: string; customer: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const logout = async () => {
    try {
      await api("/customer/auth/logout", { method: "POST" });
    } finally {
      router.replace("/portal");
      router.refresh();
    }
  };
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-4 sm:px-6">
        <CloudlinkMark className="size-7" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{organization}</p>
          <p className="truncate text-xs text-muted-foreground">{customer}</p>
        </div>
        <button type="button" onClick={logout} className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground">
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
      </div>
      <nav aria-label="Portal" className="mx-auto max-w-4xl overflow-x-auto px-2 sm:px-4">
        <ul className="flex gap-1 pb-2">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <li key={l.href}>
                <Link href={l.href} aria-current={active ? "page" : undefined} className={cn("inline-flex h-9 items-center rounded-md px-3 text-sm font-medium", active ? "bg-accent-soft text-accent" : "text-muted-foreground hover:bg-surface-muted")}>
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
