"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Dialog, DropdownMenu } from "radix-ui";
import { Bell, Building, ChevronDown, ChevronsLeft, ChevronsRight, LogOut, Menu, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { NAV_ITEMS, type NavItem } from "@/lib/navigation";
import { NAV_ICONS } from "@/components/shell/icons";
import { CloudlinkWordmark } from "@/components/shell/logo";
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

export function AppShell(props: ShellProps) {
  const { permissions, children } = props;
  const pathname = usePathname();
  const collapsed = useSidebarCollapsed();
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
    <div className="flex min-h-dvh bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        className={cn("sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 lg:flex", collapsed ? "w-[68px]" : "w-64")}
        aria-label="Primary"
      >
        <SidebarContent items={items} collapsed={collapsed} pathname={pathname} brand={props.brand} />
        <button
          type="button"
          onClick={toggleCollapsed}
          className="mx-3 mb-3 flex h-9 items-center justify-center gap-2 rounded-md text-xs text-sidebar-muted hover:bg-sidebar-active hover:text-white"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
        </button>
      </aside>

      {/* Mobile drawer */}
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 lg:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar lg:hidden" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Close className="absolute right-3 top-4 rounded-md p-1.5 text-sidebar-muted hover:text-white" aria-label="Close navigation">
              <X className="size-5" />
            </Dialog.Close>
            <SidebarContent items={items} collapsed={false} pathname={pathname} brand={props.brand} onNavigate={() => setMobileOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar {...props} onOpenMobile={() => setMobileOpen(true)} onOpenCommand={() => setCommandOpen(true)} />
        {props.isDemo ? (
          <div className="border-b border-warning/30 bg-warning-soft px-4 py-1.5 text-center text-xs font-medium text-warning" role="status">
            Demo environment — records are fictional and integrations run in mock mode. No real money or network changes.
          </div>
        ) : null}
        <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <PageTransition pathname={pathname}>{children}</PageTransition>
        </main>
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

function SidebarContent({ items, collapsed, pathname, onNavigate, brand }: { items: NavItem[]; collapsed: boolean; pathname: string; onNavigate?: () => void; brand?: ShellProps["brand"] }) {
  const groups = React.useMemo(() => {
    const map = new Map<string, NavItem[]>();
    for (const i of items) map.set(i.group, [...(map.get(i.group) ?? []), i]);
    return [...map.entries()];
  }, [items]);

  return (
    <>
      <div className={cn("flex h-16 items-center border-b border-sidebar-border", collapsed ? "justify-center px-2" : "px-5")}>
        <Link href="/dashboard" className="rounded-md" aria-label={`${brand?.name ?? "Cloudlink"} dashboard`}>
          {brand?.logoUrl ? (
            <span className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- organization logo served by the app */}
              <img src={brand.logoUrl} alt="" className="size-8 rounded-md bg-white object-contain p-0.5" />
              {collapsed ? <span className="sr-only">{brand.name}</span> : <span className="max-w-[10rem] truncate text-[15px] font-semibold tracking-tight text-white">{brand.name}</span>}
            </span>
          ) : (
            <CloudlinkWordmark collapsed={collapsed} />
          )}
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
        {groups.map(([group, groupItems]) => (
          <div key={group} className="mb-4">
            {!collapsed ? <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">{group}</p> : null}
            <ul className="space-y-0.5">
              {groupItems.map((item) => {
                const Icon = NAV_ICONS[item.icon] ?? NAV_ICONS.LayoutDashboard!;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.slug}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      title={collapsed ? `${item.label}${item.available ? "" : " (not yet available)"}` : undefined}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex h-9 items-center gap-3 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                        active ? "bg-sidebar-active text-white" : "text-sidebar-foreground hover:bg-sidebar-elevated hover:text-white",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <Icon className={cn("size-[18px] shrink-0", active ? "text-cyan" : "text-sidebar-muted group-hover:text-sidebar-foreground")} aria-hidden />
                      {!collapsed ? (
                        <>
                          <span className="truncate">{item.label}</span>
                          {!item.available ? (
                            <span className="ml-auto rounded bg-sidebar-elevated px-1.5 py-0.5 text-[10px] font-medium text-sidebar-muted">Soon</span>
                          ) : null}
                        </>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
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

const menuItemClass = "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-muted";
const menuContentClass = "z-50 min-w-56 rounded-md border border-border bg-surface p-1 shadow-(--shadow-pop)";

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
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur sm:px-6">
      <button type="button" onClick={props.onOpenMobile} className="rounded-md p-2 hover:bg-surface-muted lg:hidden" aria-label="Open navigation">
        <Menu className="size-5" />
      </button>
      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={props.onOpenCommand}
          className="hidden h-9 w-56 items-center gap-2 rounded-md border border-border bg-surface-muted px-3 text-sm text-muted-foreground hover:border-border-strong md:flex"
        >
          <Search className="size-4" aria-hidden />
          <span>Search…</span>
          <kbd className="ml-auto rounded border border-border bg-surface px-1.5 text-[10px] font-medium">Ctrl K</kbd>
        </button>
        <button type="button" onClick={props.onOpenCommand} className="rounded-md p-2 hover:bg-surface-muted md:hidden" aria-label="Search">
          <Search className="size-5" />
        </button>

        {/* Organization selector */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            disabled={busy}
            className="flex h-9 max-w-52 items-center gap-2 rounded-md border border-border px-2.5 text-sm hover:bg-surface-muted"
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

function CommandMenu({ open, onOpenChange, items }: { open: boolean; onOpenChange: (v: boolean) => void; items: NavItem[] }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => `${i.label} ${i.description}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setQuery("");
      setIndex(0);
    }
    onOpenChange(next);
  };

  const go = (item: NavItem | undefined) => {
    if (!item) return;
    handleOpenChange(false);
    router.push(item.href);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div className="fixed inset-0 z-50 bg-slate-950/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-[15vh] z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-pop)">
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
                  placeholder="Jump to a module…"
                  className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  role="combobox"
                  aria-expanded
                  aria-controls="command-results"
                  aria-activedescendant={results[index] ? `cmd-${results[index]!.slug}` : undefined}
                />
              </div>
              <ul id="command-results" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
                {results.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matching modules.</li> : null}
                {results.map((item, i) => {
                  const Icon = NAV_ICONS[item.icon] ?? NAV_ICONS.LayoutDashboard!;
                  return (
                    <li
                      key={item.slug}
                      id={`cmd-${item.slug}`}
                      role="option"
                      aria-selected={i === index}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => go(item)}
                      className={cn("flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm", i === index && "bg-surface-muted")}
                    >
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                      <span className="font-medium">{item.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                      {!item.available ? <span className="ml-auto text-[10px] text-muted-foreground">Phase {item.phase}</span> : null}
                    </li>
                  );
                })}
              </ul>
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Record search across subscribers and invoices arrives with those modules.</p>
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
      <DropdownMenu.Trigger className="relative rounded-md p-2 hover:bg-surface-muted" aria-label={total ? `Notifications: ${total} items need attention` : "Notifications"}>
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
