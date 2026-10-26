"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { ActionDialog } from "@/components/action-dialog";
import { useMutation } from "@/components/use-mutation";
import { AutoRefresh, LiveDot, UpdatedAgo } from "@/components/live";
import { api, ApiError } from "@/lib/api-client";

const LIVE_PREF = "cloudlink_sessions_live";
const SYNC_EVERY_S = 30; // matches the server's de-duplication window, so viewers share one router read
const REFRESH_EVERY_S = 10;

function readLivePref(): boolean {
  try {
    return window.localStorage.getItem(LIVE_PREF) !== "off";
  } catch {
    return true;
  }
}

function saveLivePref(on: boolean) {
  try {
    window.localStorage.setItem(LIVE_PREF, on ? "on" : "off");
  } catch {
    // Storage may be unavailable (private window); the toggle still works for this visit.
  }
}

/**
 * Live mode: while the page is open and visible, ask the worker to re-read the routers every 30 s and re-render
 * from the database every 10 s. Sessions shown are always what the last sync recorded, with its age.
 */
export function LiveSessionsControl({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  const [live, setLive] = React.useState(true);
  const [problem, setProblem] = React.useState<string | null>(null);
  const lastAsk = React.useRef(0);
  React.useEffect(() => {
    if (!readLivePref()) queueMicrotask(() => setLive(false));
  }, []);

  const askSync = React.useCallback(() => {
    if (Date.now() - lastAsk.current < SYNC_EVERY_S * 1000) return;
    lastAsk.current = Date.now();
    api("/network/sessions", { method: "POST" })
      .then(() => setProblem(null))
      .catch((err) => setProblem(err instanceof ApiError ? err.message : "Could not reach the server"));
  }, []);
  React.useEffect(() => {
    if (live && document.visibilityState === "visible") askSync();
  }, [live, askSync]);

  const toggle = () => {
    setLive((v) => {
      saveLivePref(!v);
      return !v;
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <AutoRefresh seconds={REFRESH_EVERY_S} enabled={live} onTick={askSync} />
      <button
        type="button"
        onClick={toggle}
        aria-pressed={live}
        className="inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 font-medium text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LiveDot live={live} />
        {live ? "Live" : "Paused"}
      </button>
      <span aria-live="polite">
        <UpdatedAgo at={lastSyncedAt} prefix="Synced" fallback={lastSyncedAt ? "Synced" : "Not synced yet"} />
      </span>
      {problem ? <span className="text-danger">Live sync unavailable: {problem}</span> : null}
    </div>
  );
}

/** Queue a session sync; the worker reads the routers, so re-read the page shortly after. */
export function RefreshSessionsButton() {
  const router = useRouter();
  const { mutate, pending } = useMutation();
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={async () => {
        const ok = await mutate("/network/sessions", { method: "POST" }, { success: "Session sync queued" });
        if (ok) setTimeout(() => router.refresh(), 3000);
      }}
    >
      <RefreshCw /> Refresh from routers
    </Button>
  );
}

export function ResolveAlertButton({ alertId, message }: { alertId: string; message: string }) {
  return (
    <ActionDialog
      label="Resolve"
      triggerVariant="ghost"
      title="Resolve alert"
      description={message}
      path={`/network/alerts/${alertId}/resolve`}
      success="Alert resolved"
      impact="Resolving records that the problem was handled. A new alert is raised if it happens again."
      extraBody={(v) => ({ note: v.note })}
    >
      {(errors) => (
        <Field id={`ra-note-${alertId}`} label="Note (optional)" error={errors.note}>
          <Input name="note" />
        </Field>
      )}
    </ActionDialog>
  );
}

export function OperationActions({ id, status, label }: { id: string; status: string; label: string }) {
  return (
    <span className="flex flex-wrap gap-2">
      {status === "FAILED" ? <RetryButton id={id} /> : null}
      {status === "QUEUED" || status === "RETRYING" ? (
        <ActionDialog
          label="Cancel"
          triggerVariant="ghost"
          triggerSize="md"
          tone="danger"
          title="Cancel operation"
          description={label}
          path={`/network/operations/${id}/cancel`}
          reason="required"
          success="Operation cancelled"
          impact="The operation will not run. The subscription's network status is marked as needing attention until a new operation succeeds."
        />
      ) : null}
    </span>
  );
}

function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const { mutate, pending } = useMutation();
  return (
    <Button
      loading={pending}
      onClick={async () => {
        const ok = await mutate(`/network/operations/${id}/retry`, { method: "POST" }, { success: "Retry queued" });
        if (ok) setTimeout(() => router.refresh(), 3000);
      }}
    >
      <RotateCcw /> Retry
    </Button>
  );
}
