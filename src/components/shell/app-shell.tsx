"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Dialog, DropdownMenu } from "radix-ui";
import { Bell, Building, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, LogOut, Menu, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { NAV_ITEMS, NAV_PARENTS, type NavItem } from "@/lib/navigation";
import { NAV_ICONS } from "@/components/shell/icons";
import { CloudlinkWordmark } from "@/components/shell/logo";
import { AskAi } from "@/components/shell/ask-ai";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export interface ShellUser {
  name: string;
  email: string;
  roles: string[];
}

export interface ShellProps {
  user: ShellUser;
  organization: { id: string; name: string };
  organizations: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string; code: string }>;
  activeBranchId: string | null;
  branchScope: "all" | "restricted";
  permissions: string[];
  theme: "light" | "dark" | "system";
  isDemo: boolean;
  /** Organization logo for the sidebar; the Cloudlink wordmark is shown when there is none. */
  brand?: { name: string; logoUrl: string | null };
  /** Ask AI in the top bar, when the deployment has an assistant adapter. */
  askAi?: { available: boolean; simulated: boolean };
  children: React.ReactNode;
}

const SIDEBAR_KEY = "cloudlink.sidebar";
const sidebarListeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, value ? "collapsed" : "expanded");
  } catch {
    /* storage unavailable: preference is not persisted */
  }
  sidebarListeners.forEach((l) => l());
}

function useSidebarCollapsed(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      sidebarListeners.add(cb);
      return () => sidebarListeners.delete(cb);
    },
    readCollapsed,
    () => false,
  );
}

interface NavCounts {
  sessions: number | null;
  routersOffline: number | null;
  support: number | null;
  reconciliation: number | null;
}

/** Sidebar counts, re-read on navigation and every minute while the tab is visible (failures leave the last value). */
function useNavCounts(pathname: string): NavCounts | null {
  const [counts, setCounts] = React.useState<NavCounts | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api<{ data: NavCounts }>("/navigation/counts")
        .then((res) => {
          if (!cancelled) setCounts(res.data);
        })
        .catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pathname]);
  return counts;
}

/** What a sidebar item's count means; colour is never the only signal (the label is read out and shown on hover). */
function navBadge(slug: string, counts: NavCounts | null): { value: number; label: string; tone: "neutral" | "danger" | "warning" } | null {
  if (!counts) return null;
  if (slug === "sessions" && counts.sessions) return { value: counts.sessions, label: `${counts.sessions} online now`, tone: "neutral" };
  if (slug === "routers" && counts.routersOffline) return { value: counts.routersOffline, label: `${counts.routersOffline} offline`, tone: "danger" };
  if (slug === "support" && counts.support) return { value: counts.support, label: `${counts.support} open tickets`, tone: "neutral" };
  if (slug === "reconciliation" && counts.reconciliation) return { value: counts.reconciliation, label: `${counts.reconciliation} payments to match`, tone: "warning" };
  return null;
}

export function AppShell(props: ShellProps) {
  const { permissions, children } = props;
  const pathname = usePathname();
  const collapsed = useSidebarCollapsed();
  const counts = useNavCounts(pathname);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);


  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleCollapsed = () => writeCollapsed(!collapsed);

  const items = React.useMemo(() => NAV_ITEMS.filter((i) => permissions.includes(i.permission)), [permissions]);

  return (
    <div className="flex min-h-dvh gap-3 bg-background lg:p-3">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>

      {/* Desktop sidebar: a floating panel */}
      <aside
        className={cn(
          "sticky top-3 hidden h-[calc(100dvh-1.5rem)] shrink-0 flex-col overflow-hidden rounded-2xl border border-sidebar-border bg-sidebar transition-[width] duration-200 lg:flex",
          collapsed ? "w-[68px]" : "w-60",
        )}
        aria-label="Primary"
      >
        <SidebarContent items={items} collapsed={collapsed} pathname={pathname} brand={props.brand} counts={counts} onToggleCollapsed={toggleCollapsed} />
      </aside>

      {/* Mobile drawer */}
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 lg:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar lg:hidden" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Close className="absolute right-3 top-4 rounded-md p-1.5 text-sidebar-muted hover:text-white" aria-label="Close navigation">
              <X className="size-5" />
            </Dialog.Close>
            <SidebarContent items={items} collapsed={false} pathname={pathname} brand={props.brand} counts={counts} onNavigate={() => setMobileOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar {...props} onOpenMobile={() => setMobileOpen(true)} onOpenCommand={() => setCommandOpen(true)} />
        {props.isDemo ? (
          <div className="mt-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-1.5 text-center text-xs font-medium text-warning" role="status">
            Demo environment — records are fictional and integrations run in mock mode. No real money or network changes.
          </div>
        ) : null}
        <main id="main" className="mx-auto w-full max-w-[1120px] flex-1 px-4 py-8 sm:px-6">
          <PageTransition pathname={pathname}>{children}</PageTransition>
        </main>
        <footer className="pb-4 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/70">Cloudlink · ISP billing &amp; network</footer>
      </div>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} items={items} />
    </div>
  );
}

function PageTransition({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <motion.div key={pathname} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}

const OPEN_KEY = "cloudlink.nav.open";

function readOpen(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function NavLink({ item, active, collapsed, counts, onNavigate, nested }: { item: NavItem; active: boolean; collapsed: boolean; counts: NavCounts | null; onNavigate?: () => void; nested?: boolean }) {
  const Icon = NAV_ICONS[item.icon] ?? NAV_ICONS.LayoutDashboard!;
  const badge = navBadge(item.slug, counts);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? `${item.label}${item.available ? "" : " (not yet available)"}${badge ? `: ${badge.label}` : ""}` : badge?.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
        nested ? "h-8" : "h-9",
        active ? "bg-sidebar-active text-white" : "text-sidebar-foreground hover:bg-sidebar-elevated hover:text-white",
        collapsed && "justify-center px-0",
      )}
    >
      {nested && !collapsed ? null : <Icon className={cn("size-4 shrink-0", active ? "text-white" : "text-sidebar-muted group-hover:text-sidebar-foreground")} aria-hidden />}
      {!collapsed ? (
        <>
          <span className="truncate">{item.label}</span>
          {badge ? (
            <span
              className={cn(
                "tabular ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                badge.tone === "danger" ? "bg-danger-soft text-danger" : badge.tone === "warning" ? "bg-warning-soft text-warning" : item.slug === "sessions" ? "bg-success-soft text-success" : "bg-sidebar-elevated text-sidebar-foreground",
              )}
            >
              {badge.value > 999 ? "999+" : badge.value}
              <span className="sr-only"> ({badge.label})</span>
            </span>
          ) : null}
          {!item.available ? <span className="ml-auto rounded bg-sidebar-elevated px-1.5 py-0.5 text-[10px] font-medium text-sidebar-muted">Soon</span> : null}
        </>
      ) : null}
    </Link>
  );
}

function SidebarContent({
  items,
  collapsed,
  pathname,
  onNavigate,
  brand,
  counts,
  onToggleCollapsed,
}: {
  items: NavItem[];
  collapsed: boolean;
  pathname: string;
  onNavigate?: () => void;
  brand?: ShellProps["brand"];
  counts: NavCounts | null;
  onToggleCollapsed?: () => void;
}) {
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  // Sub-menus: open while one of their pages is shown, or when the person opened them (remembered).
  const [opened, setOpened] = React.useState<string[]>([]);
  React.useEffect(() => {
    const saved = readOpen();
    if (saved.length) queueMicrotask(() => setOpened(saved));
  }, []);
  const toggle = (key: string) =>
    setOpened((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: not remembered */
      }
      return next;
    });

  // Group → ordered entries, where an entry is a plain link or a sub-menu of links.
  const groups = React.useMemo(() => {
    const map = new Map<string, Array<{ parent: string; children: NavItem[] } | NavItem>>();
    for (const i of items) {
      const list = map.get(i.group) ?? [];
      if (i.parent) {
        const existing = list.find((e): e is { parent: string; children: NavItem[] } => "parent" in e && !("slug" in e) && e.parent === i.parent);
        if (existing) existing.children.push(i);
        else list.push({ parent: i.parent, children: [i] });
      } else list.push(i);
      map.set(i.group, list);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <>
      <div className={cn("flex h-14 shrink-0 items-center gap-2", collapsed ? "justify-center px-2" : "px-4")}>
        <Link href="/dashboard" className="min-w-0 rounded-md" aria-label={`${brand?.name ?? "Cloudlink"} overview`}>
          {brand?.logoUrl ? (
            <span className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- organization logo served by the app */}
              <img src={brand.logoUrl} alt="" className="size-7 rounded-md bg-white object-contain p-0.5" />
              {collapsed ? <span className="sr-only">{brand.name}</span> : <span className="block max-w-[9.5rem] truncate text-[15px] font-bold tracking-tight text-white">{brand.name}</span>}
            </span>
          ) : collapsed ? (
            <CloudlinkWordmark collapsed />
          ) : (
            <span className="block max-w-[10rem] truncate text-[15px] font-bold tracking-tight text-white">{brand?.name ?? "Cloudlink"}</span>
          )}
        </Link>
        {onToggleCollapsed && !collapsed ? (
          <button type="button" onClick={onToggleCollapsed} className="ml-auto rounded-md p-1 text-sidebar-muted hover:bg-sidebar-elevated hover:text-white" aria-label="Collapse sidebar">
            <ChevronsLeft className="size-4" />
          </button>
        ) : null}
      </div>
      <nav className="flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Main navigation">
        {groups.map(([group, entries]) => {
          const admin = group === "Administration";
          const adminOpen = !admin || opened.includes("admin") || entries.some((e) => "slug" in e && isActive(e.href));
          return (
            <div key={group} className={cn("mt-3", admin && "mt-5 border-t border-sidebar-border pt-3")}>
              {!collapsed ? (
                admin ? (
                  <button type="button" onClick={() => toggle("admin")} aria-expanded={adminOpen} className="mb-1 flex w-full items-center px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted hover:text-sidebar-foreground">
                    {group}
                    <ChevronRight className={cn("ml-auto size-3.5 transition-transform", adminOpen && "rotate-90")} aria-hidden />
                  </button>
                ) : group !== "Overview" ? (
                  <p className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">{group}</p>
                ) : null
              ) : null}
              {adminOpen || collapsed ? (
                <ul className="space-y-0.5">
                  {entries.map((entry) => {
                    if ("slug" in entry) {
                      return (
                        <li key={entry.slug}>
                          <NavLink item={entry} active={isActive(entry.href)} collapsed={collapsed} counts={counts} onNavigate={onNavigate} />
                        </li>
                      );
                    }
                    const meta = NAV_PARENTS[entry.parent] ?? { label: entry.parent, icon: "LayoutDashboard" };
                    const ParentIcon = NAV_ICONS[meta.icon] ?? NAV_ICONS.LayoutDashboard!;
                    const childActive = entry.children.some((c) => isActive(c.href));
                    const open = collapsed || childActive || opened.includes(entry.parent);
                    return (
                      <li key={entry.parent}>
                        {!collapsed ? (
                          <button
                            type="button"
                            onClick={() => toggle(entry.parent)}
                            aria-expanded={open}
                            className={cn("group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors", childActive ? "text-white" : "text-sidebar-foreground hover:bg-sidebar-elevated hover:text-white")}
                          >
                            <ParentIcon className="size-4 shrink-0 text-sidebar-muted group-hover:text-sidebar-foreground" aria-hidden />
                            <span className="truncate">{meta.label}</span>
                            <ChevronRight className={cn("ml-auto size-3.5 text-sidebar-muted transition-transform", open && "rotate-90")} aria-hidden />
                          </button>
                        ) : null}
                        {open ? (
                          <ul className={cn("space-y-0.5", !collapsed && "ml-[1.15rem] mt-0.5 border-l border-sidebar-border pl-2")}>
                            {entry.children.map((c) => (
                              <li key={c.slug}>
                                <NavLink item={c} nested={!collapsed} active={isActive(c.href)} collapsed={collapsed} counts={counts} onNavigate={onNavigate} />
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>
      {onToggleCollapsed && collapsed ? (
        <button type="button" onClick={onToggleCollapsed} className="mx-2 mb-3 flex h-9 items-center justify-center rounded-lg text-sidebar-muted hover:bg-sidebar-elevated hover:text-white" aria-label="Expand sidebar">
          <ChevronsRight className="size-4" />
        </button>
      ) : null}
    </>
  );
}

function Breadcrumbs() {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const first = NAV_ITEMS.find((i) => i.slug === parts[0]);
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
      <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <li>
          <Link href="/dashboard" className="hover:text-foreground">
            Home
          </Link>
        </li>
        {first && first.slug !== "dashboard" ? (
          <>
            <li aria-hidden>/</li>
            <li className={cn(parts.length === 1 && "font-medium text-foreground")} aria-current={parts.length === 1 ? "page" : undefined}>
              {parts.length > 1 ? (
                <Link href={first.href} className="hover:text-foreground">
                  {first.label}
                </Link>
              ) : (
                first.label
              )}
            </li>
          </>
        ) : null}
        {parts.length > 1 ? (
          <>
            <li aria-hidden>/</li>
            <li className="truncate font-medium text-foreground" aria-current="page">
              {parts[1] === "new" ? "New" : "Details"}
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}

const menuItemClass = "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-muted";
const menuContentClass = "z-50 min-w-56 rounded-xl border border-border bg-surface p-1 shadow-(--shadow-pop)";

function Topbar(props: ShellProps & { onOpenMobile: () => void; onOpenCommand: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const patchSession = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      await api("/auth/session", { method: "PATCH", body });
      toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch context.");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  const setTheme = (theme: "light" | "dark" | "system") => {
    document.cookie = `cloudlink_theme=${theme}; path=/; max-age=31536000; samesite=lax`;
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    router.refresh();
  };

  const activeBranch = props.branches.find((b) => b.id === props.activeBranchId);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-3 backdrop-blur sm:px-4 lg:top-3 lg:rounded-2xl lg:border">
      <button type="button" onClick={props.onOpenMobile} className="rounded-md p-2 hover:bg-surface-muted lg:hidden" aria-label="Open navigation">
        <Menu className="size-5" />
      </button>
      <div className="min-w-0 lg:w-56">
        <Breadcrumbs />
      </div>

      <div className="mx-auto hidden min-w-0 max-w-md flex-1 items-center gap-2 md:flex">
        <button
          type="button"
          onClick={props.onOpenCommand}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-background px-3.5 text-[13px] text-muted-foreground hover:border-border-strong"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="truncate">Search subscribers, routers, payments…</span>
          <kbd className="ml-auto shrink-0 rounded border border-border bg-surface px-1.5 text-[10px] font-medium">Ctrl K</kbd>
        </button>
        {props.askAi?.available ? <AskAi simulated={props.askAi.simulated} /> : null}
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2 md:ml-0">
        <button type="button" onClick={props.onOpenCommand} className="rounded-md p-2 hover:bg-surface-muted md:hidden" aria-label="Search">
          <Search className="size-5" />
        </button>
        {props.askAi?.available ? (
          <span className="md:hidden">
            <AskAi simulated={props.askAi.simulated} />
          </span>
        ) : null}

        {/* Organization selector */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            disabled={busy}
            className="flex h-9 max-w-48 items-center gap-2 rounded-full border border-border px-3 text-[13px] hover:bg-surface-muted"
            aria-label={`Organization: ${props.organization.name}. Branch: ${activeBranch?.name ?? "All branches"}`}
          >
            <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="hidden truncate sm:inline">
              {props.organization.name}
              <span className="text-muted-foreground"> · {activeBranch?.code ?? "All"}</span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className={menuContentClass}>
              <DropdownMenu.Label className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Organization</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={props.organization.id} onValueChange={(id) => id !== props.organization.id && patchSession({ organizationId: id }, "Organization switched")}>
                {props.organizations.map((o) => (
                  <DropdownMenu.RadioItem key={o.id} value={o.id} className={menuItemClass}>
                    <DropdownMenu.ItemIndicator className="size-1.5 rounded-full bg-accent" />
                    {o.name}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Branch {props.branchScope === "restricted" ? "(restricted access)" : ""}
              </DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={props.activeBranchId ?? "all"}
                onValueChange={(v) => patchSession({ branchId: v === "all" ? null : v }, "Branch filter updated")}
              >
                <DropdownMenu.RadioItem value="all" className={menuItemClass}>
                  <DropdownMenu.ItemIndicator className="size-1.5 rounded-full bg-accent" />
                  {props.branchScope === "all" ? "All branches" : "All my branches"}
                </DropdownMenu.RadioItem>
                {props.branches.map((b) => (
                  <DropdownMenu.RadioItem key={b.id} value={b.id} className={menuItemClass}>
                    <DropdownMenu.ItemIndicator className="size-1.5 rounded-full bg-accent" />
                    {b.name} <span className="ml-auto text-xs text-muted-foreground">{b.code}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <NotificationCenter />

        {/* User menu */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent hover:ring-2 hover:ring-accent/30" aria-label="Account menu">
            {props.user.name
              .split(" ")
              .map((p) => p[0])
              .slice(0, 2)
              .join("")
              .toUpperCase()}
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className={menuContentClass}>
              <div className="px-2 py-2">
                <p className="text-sm font-semibold">{props.user.name}</p>
                <p className="text-xs text-muted-foreground">{props.user.email}</p>
                <p className="mt-1 text-xs capitalize text-muted-foreground">{props.user.roles.join(", ") || "No roles"}</p>
              </div>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Theme</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={props.theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
                <DropdownMenu.RadioItem value="light" className={menuItemClass}>
                  <Sun className="size-4" /> Light
                  <DropdownMenu.ItemIndicator className="ml-auto size-1.5 rounded-full bg-accent" />
                </DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="dark" className={menuItemClass}>
                  <Moon className="size-4" /> Dark
                  <DropdownMenu.ItemIndicator className="ml-auto size-1.5 rounded-full bg-accent" />
                </DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="system" className={menuItemClass}>
                  <Monitor className="size-4" /> System
                  <DropdownMenu.ItemIndicator className="ml-auto size-1.5 rounded-full bg-accent" />
                </DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item className={cn(menuItemClass, "text-danger")} onSelect={logout}>
                <LogOut className="size-4" /> Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

interface SearchHit {
  type: "subscriber" | "invoice" | "payment" | "router" | "ticket" | "lead";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const HIT_ICON: Record<SearchHit["type"], string> = { subscriber: "Users", invoice: "FileText", payment: "Wallet", router: "Router", ticket: "LifeBuoy", lead: "UserPlus" };
const HIT_LABEL: Record<SearchHit["type"], string> = { subscriber: "Subscriber", invoice: "Invoice", payment: "Payment", router: "Router", ticket: "Ticket", lead: "Lead" };

type CommandEntry = { key: string; href: string; icon: string; title: string; subtitle: string; tag?: string; group: "Records" | "Modules" };

/** Server record search (debounced); stale responses are ignored. */
function useRecordSearch(query: string) {
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [state, setState] = React.useState<"idle" | "loading" | "done" | "error">("idle");
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      setState("loading");
      api<{ data: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`)
        .then((res) => {
          if (cancelled) return;
          setHits(res.data);
          setState("done");
        })
        .catch(() => {
          if (!cancelled) setState("error");
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);
  return query.trim().length < 2 ? { hits: [], state: "idle" as const } : { hits, state };
}

function CommandMenu({ open, onOpenChange, items }: { open: boolean; onOpenChange: (v: boolean) => void; items: NavItem[] }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const { hits, state } = useRecordSearch(query);
  const results = React.useMemo((): CommandEntry[] => {
    const q = query.trim().toLowerCase();
    const modules = (q ? items.filter((i) => `${i.label} ${i.description}`.toLowerCase().includes(q)) : items).map(
      (i): CommandEntry => ({ key: `m-${i.slug}`, href: i.href, icon: i.icon, title: i.label, subtitle: i.description, tag: i.available ? undefined : `Phase ${i.phase}`, group: "Modules" }),
    );
    const records = hits.map((h): CommandEntry => ({ key: `r-${h.type}-${h.id}`, href: h.href, icon: HIT_ICON[h.type], title: h.title, subtitle: h.subtitle, tag: HIT_LABEL[h.type], group: "Records" }));
    return [...records, ...modules];
  }, [items, query, hits]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setQuery("");
      setIndex(0);
    }
    onOpenChange(next);
  };

  const go = (entry: CommandEntry | undefined) => {
    if (!entry) return;
    handleOpenChange(false);
    router.push(entry.href);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div className="fixed inset-0 z-50 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-[15vh] z-50 w-[min(600px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-(--shadow-pop)">
              <Dialog.Title className="sr-only">Search Cloudlink</Dialog.Title>
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search className="size-4 text-muted-foreground" aria-hidden />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setIndex((i) => Math.min(i + 1, results.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setIndex((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      go(results[index]);
                    }
                  }}
                  placeholder="Search records or jump to a module…"
                  className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  role="combobox"
                  aria-expanded
                  aria-controls="command-results"
                  aria-activedescendant={results[index] ? `cmd-${results[index]!.key}` : undefined}
                />
                {state === "loading" ? <span className="text-[11px] text-muted-foreground">Searching…</span> : null}
              </div>
              <ul id="command-results" role="listbox" className="max-h-96 overflow-y-auto p-1.5">
                {results.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">{state === "loading" ? "Searching…" : "No matching records or modules."}</li> : null}
                {state === "error" ? <li className="px-3 py-2 text-xs text-danger">Record search failed. Modules are still listed.</li> : null}
                {results.map((entry, i) => {
                  const Icon = NAV_ICONS[entry.icon] ?? NAV_ICONS.LayoutDashboard!;
                  const heading = i === 0 || results[i - 1]!.group !== entry.group;
                  return (
                    <React.Fragment key={entry.key}>
                      {heading ? (
                        <li role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {entry.group}
                        </li>
                      ) : null}
                      <li
                        id={`cmd-${entry.key}`}
                        role="option"
                        aria-selected={i === index}
                        onMouseEnter={() => setIndex(i)}
                        onClick={() => go(entry)}
                        className={cn("flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm", i === index && "bg-surface-muted")}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{entry.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">{entry.subtitle}</span>
                        </span>
                        {entry.tag ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{entry.tag}</span> : null}
                      </li>
                    </React.Fragment>
                  );
                })}
              </ul>
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Type 2+ characters: names, account numbers, phones, invoice and receipt numbers, M-Pesa codes, routers, tickets.</p>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}

interface AlertItem {
  key: string;
  tone: "danger" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
  count: number;
}

/** Live "needs attention" items from the server (permission-filtered). Refreshed whenever the menu opens. */
function NotificationCenter() {
  const [items, setItems] = React.useState<AlertItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      const res = await api<{ data: AlertItem[] }>("/alerts");
      setItems(res.data);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    api<{ data: AlertItem[] }>("/alerts")
      .then((res) => {
        if (!cancelled) setItems(res.data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const total = items?.reduce((a, i) => a + i.count, 0) ?? 0;
  const toneDot = { danger: "bg-danger", warning: "bg-warning", info: "bg-info" } as const;

  return (
    <DropdownMenu.Root onOpenChange={(o) => o && void load()}>
      <DropdownMenu.Trigger className="relative rounded-full p-2 hover:bg-surface-muted" aria-label={total ? `Notifications: ${total} items need attention` : "Notifications"}>
        <Bell className="size-5" />
        {total ? <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">{total > 9 ? "9+" : total}</span> : null}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuContentClass, "w-80")}>
          <DropdownMenu.Label className="px-2 py-1.5 text-sm font-semibold">Needs attention</DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {error ? <p className="px-2 py-3 text-sm text-danger">Could not load alerts.</p> : null}
          {items && items.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">All clear. Nothing needs your attention.</p> : null}
          {items?.map((a) => (
            <DropdownMenu.Item key={a.key} asChild className={cn(menuItemClass, "items-start py-2")}>
              <Link href={a.href}>
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", toneDot[a.tone])} aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium">{a.title}</span>
                  <span className="block text-xs text-muted-foreground">{a.detail}</span>
                </span>
              </Link>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
