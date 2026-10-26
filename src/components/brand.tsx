"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { CloudlinkMark } from "@/components/shell/logo";
import { cn } from "@/lib/utils";

/** The organization's logo, or the Cloudlink mark when none was uploaded. */
export function BrandMark({ logoUrl, className }: { logoUrl: string | null; className?: string }) {
  if (!logoUrl) return <CloudlinkMark className={className} />;
  // eslint-disable-next-line @next/next/no-img-element -- organization logo served by the app itself
  return <img src={logoUrl} alt="" className={cn("size-8 rounded-md bg-white object-contain p-0.5", className)} />;
}

type Mode = "light" | "dark" | "system";
const COOKIE = "cloudlink_theme";

function readMode(): Mode | null {
  const m = document.cookie.match(/(?:^|;\s*)cloudlink_theme=(light|dark|system)/);
  return (m?.[1] as Mode) ?? null;
}

function saveMode(mode: Mode) {
  document.cookie = `${COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
}

function applyMode(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Applies the organization's default mode for visitors who have not chosen one themselves. */
export function DefaultMode({ mode }: { mode: Mode }) {
  React.useEffect(() => {
    if (readMode() || mode === "light") return;
    applyMode(mode);
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyMode("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);
  return null;
}

/** Light / dark / system switch for customers (remembered in a cookie, same as the staff theme menu). */
export function ThemeToggle({ fallback }: { fallback: Mode }) {
  const [mode, setMode] = React.useState<Mode>(fallback);
  React.useEffect(() => {
    const saved = readMode();
    if (saved && saved !== fallback) queueMicrotask(() => setMode(saved));
  }, [fallback]);
  const choose = (m: Mode) => {
    setMode(m);
    saveMode(m);
    applyMode(m);
  };
  const options: Array<[Mode, string, React.ComponentType<{ className?: string }>]> = [
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
    ["system", "System", Monitor],
  ];
  return (
    <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-md border border-border p-0.5">
      {options.map(([m, label, Icon]) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          aria-label={label}
          title={label}
          onClick={() => choose(m)}
          className={cn("inline-flex size-7 items-center justify-center rounded", mode === m ? "bg-accent-soft text-accent" : "text-muted-foreground hover:bg-surface-muted")}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
