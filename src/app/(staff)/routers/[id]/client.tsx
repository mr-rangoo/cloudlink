"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock, FileCode2, FileText, Globe, Power, Stethoscope, Tag, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { formValues, useMutation } from "@/components/use-mutation";
import { cn } from "@/lib/utils";

/** Operations run in the worker: re-read the page a little later to show their result. */
function useLaterRefresh() {
  const router = useRouter();
  return React.useCallback(() => {
    setTimeout(() => router.refresh(), 2500);
    setTimeout(() => router.refresh(), 7000);
  }, [router]);
}

/** Read-only router requests (diagnosis, logs): no confirmation needed. */
export function RouterQueryButton({ routerId, type, pending }: { routerId: string; type: "router.diagnose" | "router.logs"; pending?: boolean }) {
  const later = useLaterRefresh();
  const { mutate, pending: sending } = useMutation();
  const label = type === "router.diagnose" ? "Run diagnosis" : "Fetch latest logs";
  return (
    <Button
      variant="secondary"
      loading={sending}
      disabled={pending}
      onClick={async () => {
        const ok = await mutate(`/routers/${routerId}/operations`, { method: "POST", body: { type } }, { success: type === "router.diagnose" ? "Diagnosis queued" : "Log fetch queued" });
        if (ok) later();
      }}
    >
      {type === "router.diagnose" ? <Stethoscope /> : <FileText />} {pending ? "Running…" : label}
    </Button>
  );
}

const ACTIONS = {
  "router.clock": { label: "Sync router time", icon: Clock, title: "Sync router time", impact: (tz: string) => `Sets the router's time zone to ${tz} and turns on its NTP client (pool.ntp.org), so logs, plan schedules and expiries line up.` },
  "hotspot.walled_garden": {
    label: "Resync walled garden",
    icon: Globe,
    title: "Resync walled garden",
    impact: () => "Replaces Cloudlink's walled-garden entries so devices can open the captive portal and pay before logging in. Other entries are left alone.",
  },
  "hotspot.login_page": {
    label: "Reinstall login page",
    icon: FileCode2,
    title: "Reinstall hotspot login page",
    impact: () => "The router downloads Cloudlink's login page into each hotspot profile's folder (replacing login.html) and allows plain-password login, which the captive portal needs.",
  },
} as const;

/** Router maintenance actions (need routers.write). Each is confirmed and runs as a tracked network operation. */
export function RouterActionDialog({ routerId, type, timezone }: { routerId: string; type: keyof typeof ACTIONS; timezone: string }) {
  const later = useLaterRefresh();
  const a = ACTIONS[type];
  const Icon = a.icon;
  return (
    <ActionDialog
      label={
        <>
          <Icon /> {a.label}
        </>
      }
      triggerVariant="secondary"
      triggerSize="md"
      title={a.title}
      impact={a.impact(timezone)}
      path={`/routers/${routerId}/operations`}
      submitLabel="Queue"
      success="Queued. The result appears under Activity."
      extraBody={() => ({ type })}
      onDone={later}
    />
  );
}

export function RenameRouterDialog({ routerId, current }: { routerId: string; current: string | null }) {
  const later = useLaterRefresh();
  return (
    <ActionDialog
      label={
        <>
          <Tag /> Set identity
        </>
      }
      triggerVariant="secondary"
      triggerSize="md"
      title="Set router identity"
      description="The name the router shows in WinBox, logs and neighbour lists. Cloudlink's own router name does not change."
      path={`/routers/${routerId}/operations`}
      submitLabel="Queue"
      success="Identity change queued"
      extraBody={(v) => ({ type: "router.identity", name: v.name })}
      onDone={later}
    >
      {(errors) => (
        <Field id={`identity-${routerId}`} label="Identity" error={errors.name} hint="Letters, digits, spaces, dots, dashes and underscores (up to 64)." required>
          <Input name="name" defaultValue={current ?? ""} maxLength={64} autoComplete="off" spellCheck={false} />
        </Field>
      )}
    </ActionDialog>
  );
}

export function RebootRouterButton({ routerId, name, sessions }: { routerId: string; name: string; sessions: number }) {
  const later = useLaterRefresh();
  return (
    <ActionDialog
      label={
        <>
          <Power /> Reboot
        </>
      }
      triggerVariant="secondary"
      triggerSize="md"
      tone="danger"
      title={`Reboot ${name}`}
      impact={`Every customer on this router loses service while it restarts (usually one to two minutes)${sessions ? `, including ${sessions} open session${sessions === 1 ? "" : "s"}` : ""}. Cloudlink checks the router again two minutes after the command is sent.`}
      path={`/routers/${routerId}/operations`}
      submitLabel="Reboot now"
      success="Reboot queued"
      extraBody={() => ({ type: "router.reboot" })}
      onDone={later}
    />
  );
}

/** Pause offline alerts during planned work; the note is shown on the router page. */
export function MaintenanceDialog({ routerId, enabled, note }: { routerId: string; enabled: boolean; note: string | null }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const submit = async (on: boolean, form?: HTMLFormElement) => {
    const v = form ? formValues(form) : {};
    const ok = await mutate(`/routers/${routerId}`, { method: "PATCH", body: { maintenanceMode: on, maintenanceNote: on ? (v.maintenanceNote ?? null) : null } }, { success: on ? "Maintenance mode on" : "Maintenance mode off" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Wrench /> {enabled ? "End maintenance" : "Maintenance"}
        </Button>
      </DialogTrigger>
      <DialogContent title={enabled ? "End maintenance" : "Start maintenance"} description="While a router is in maintenance, failed health checks are still recorded but no offline alert is raised.">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit(!enabled, e.currentTarget);
          }}
        >
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          {enabled ? (
            <p className="text-sm text-muted-foreground">{note ? `Current note: ${note}. ` : ""}Offline alerts resume with the next health check.</p>
          ) : (
            <Field id={`maint-note-${routerId}`} label="Note" error={errors.maintenanceNote} hint="Shown on the router page, e.g. “Replacing the power supply”.">
              <Input name="maintenanceNote" maxLength={200} />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {enabled ? "End maintenance" : "Start maintenance"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────── Reachability heatmap ─────────

type Cell = number | null;

function cellState(v: Cell): { label: string; className: string } {
  if (v === null) return { label: "No checks", className: "bg-surface-muted" };
  if (v >= 100) return { label: "All checks reached the router", className: "bg-success" };
  if (v <= 0) return { label: "Unreachable", className: "bg-danger hatch" };
  return { label: `${v}% of checks reached the router`, className: "bg-warning" };
}

/**
 * Seven days × 24 local hours of reachability. Colour follows the status palette and is never alone: unreachable
 * cells are hatched, the legend names each state, and hovering (or focusing) a cell reads it out below the grid.
 */
export function ReachabilityHeatmap({ days }: { days: Array<{ date: string; hours: Cell[] }> }) {
  const [active, setActive] = React.useState<{ date: string; hour: number; value: Cell } | null>(null);
  const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const readout = active ? `${dayLabel(active.date)}, ${String(active.hour).padStart(2, "0")}:00–${String(active.hour).padStart(2, "0")}:59 · ${cellState(active.value).label}` : "Hover or focus an hour to read it.";
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-[2px]" aria-label="Reachability by day and hour">
          <thead>
            <tr>
              <th className="w-20" />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col" className="text-center text-[10px] font-normal text-muted-foreground">
                  {h % 3 === 0 ? String(h).padStart(2, "0") : <span className="sr-only">{h}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <th scope="row" className="pr-2 text-left text-xs font-normal whitespace-nowrap text-muted-foreground">
                  {dayLabel(d.date)}
                </th>
                {d.hours.map((v, h) => {
                  const s = cellState(v);
                  return (
                    <td key={h} className="p-0">
                      <button
                        type="button"
                        aria-label={`${dayLabel(d.date)} ${String(h).padStart(2, "0")}:00: ${s.label}`}
                        className={cn("block h-5 w-full min-w-3 rounded-[3px] outline-offset-1 focus-visible:outline-2 focus-visible:outline-accent", s.className, active?.date === d.date && active.hour === h && "ring-2 ring-foreground/60")}
                        onMouseEnter={() => setActive({ date: d.date, hour: h, value: v })}
                        onFocus={() => setActive({ date: d.date, hour: h, value: v })}
                        onMouseLeave={() => setActive(null)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="min-h-5 text-xs text-foreground" aria-live="polite">
        {readout}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[100, 50, 0, null].map((v) => {
          const s = cellState(v);
          return (
            <li key={String(v)} className="flex items-center gap-1.5">
              <span className={cn("size-3 rounded-[3px]", s.className)} aria-hidden />
              {v === 50 ? "Some checks failed" : s.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
