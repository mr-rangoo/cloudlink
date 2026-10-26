"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/components/network-notice";

/** "just now", "42 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function relativeAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Current time, re-read every `everyMs` so relative labels keep moving. */
export function useNow(everyMs = 1000): number | null {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * Re-read the page's server data on an interval while the tab is visible (and once when it becomes visible
 * again). Nothing is computed in the browser: every refresh shows what the server last recorded.
 */
export function AutoRefresh({ seconds, enabled = true, onTick }: { seconds: number; enabled?: boolean; onTick?: () => void }) {
  const router = useRouter();
  const tickRef = React.useRef(onTick);
  React.useEffect(() => {
    tickRef.current = onTick;
  });
  React.useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      tickRef.current?.();
      router.refresh();
    };
    const id = window.setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, seconds, enabled]);
  return null;
}

/** A small status dot; pulses (unless reduced motion is requested) when live. */
export function LiveDot({ live, tone = "success" }: { live: boolean; tone?: "success" | "neutral" }) {
  const color = tone === "success" && live ? "bg-success" : "bg-muted-foreground";
  return (
    <span className="relative inline-flex size-2.5 shrink-0" aria-hidden>
      {live ? <span className={cn("absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping", color)} /> : null}
      <span className={cn("relative inline-flex size-2.5 rounded-full", color)} />
    </span>
  );
}

/** Time elapsed since `since` ("2d 4h", "3h 12m"), ticking each minute. */
export function Elapsed({ since, fallback }: { since: string; fallback: string }) {
  const now = useNow(60_000);
  if (now === null) return <>{fallback}</>;
  return <time dateTime={since}>{formatDuration(Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000)))}</time>;
}

/** "Updated 12 s ago", ticking. Renders the absolute fallback until mounted so server and client markup agree. */
export function UpdatedAgo({ at, prefix = "Updated", fallback }: { at: string | null; prefix?: string; fallback: string }) {
  const now = useNow();
  if (!at) return <>{fallback}</>;
  if (now === null) return <>{fallback}</>;
  return (
    <time dateTime={at} title={new Date(at).toLocaleString("en-KE")}>
      {prefix ? `${prefix} ` : ""}
      {relativeAge(now - new Date(at).getTime())}
    </time>
  );
}
