"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, FlaskConical, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Switch } from "@/components/ui/controls";
import { relativeAge, useNow } from "@/components/live";
import { formValues, useMutation } from "@/components/use-mutation";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

// ───────── Stepper ─────────

const STEPS = [
  { key: "identity", label: "Identity", hint: "Name the router" },
  { key: "provision", label: "Provision", hint: "Run one command" },
  { key: "services", label: "Services", hint: "Hotspot, PPPoE, ports" },
  { key: "done", label: "Done", hint: "Ready for customers" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];

export function LinkStepper({ active }: { active: StepKey }) {
  const index = STEPS.findIndex((s) => s.key === active);
  return (
    <ol aria-label="Link a MikroTik" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STEPS.map((s, i) => {
        const done = i < index;
        const current = i === index;
        return (
          <li
            key={s.key}
            aria-current={current ? "step" : undefined}
            className={cn("flex items-center gap-3 rounded-2xl border px-3 py-2.5", current ? "border-accent bg-accent/10" : "border-border bg-surface")}
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                done ? "bg-accent text-accent-foreground" : current ? "border-2 border-accent text-accent" : "border border-border-strong text-muted-foreground",
              )}
            >
              {done ? <Check className="size-4" aria-hidden /> : i + 1}
              <span className="sr-only">{done ? " (done)" : ""}</span>
            </span>
            <span className="min-w-0">
              <span className={cn("block text-sm font-semibold", !current && !done && "text-muted-foreground")}>{s.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{s.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ───────── Step 1: Identity ─────────

export function IdentityForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const { mutate, pending, errors, formError } = useMutation<{ id: string }>();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    await mutate("/routers/link", { method: "POST", body: { name: v.name, branchId: v.branchId ?? null } }, { refresh: false, onSuccess: (r) => router.push(`/routers/${r.id}/setup`) });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="p-5">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <h2 className="text-base font-semibold">Name this router</h2>
            <p className="text-sm text-muted-foreground">Shown in Cloudlink, and set as the router&apos;s identity when the setup command runs.</p>
          </div>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="link-name" label="Router name" error={errors.name} required hint="For example the site or tower, such as Westlands Tower.">
              <Input name="name" placeholder="Westlands Tower" autoComplete="off" autoFocus />
            </Field>
            {branches.length ? (
              <Field id="link-branch" label="Branch" error={errors.branchId}>
                <Select name="branchId" defaultValue="">
                  <option value="">All branches</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Link href="/routers" className={buttonVariants({ variant: "secondary" })}>
              Cancel
            </Link>
            <Button type="submit" loading={pending}>
              Continue <ArrowRight />
            </Button>
          </div>
        </form>
      </Card>
      <Card className="space-y-2 p-5 text-sm">
        <h2 className="font-semibold">Before you start</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>A MikroTik router with RouterOS 7 and internet on its WAN port.</li>
          <li>Admin access to its terminal (WinBox → New Terminal, or SSH).</li>
          <li>Know which ports your access points or customers plug into.</li>
        </ul>
        <p className="text-muted-foreground">The router connects out to Cloudlink. You do not need to open any port on it.</p>
      </Card>
    </div>
  );
}

// ───────── Steps 2–4 ─────────

type PortUse = "off" | "hotspot" | "pppoe" | "both";
interface ServicesView {
  hotspot: boolean;
  pppoe: boolean;
  wanInterface: string;
  ports: Array<{ name: string; use: Exclude<PortUse, "off"> }>;
  hotspotNetwork: string;
  hotspotDnsName: string;
  devicesPerLogin: number;
  blockSharing: boolean;
  pppoeNetwork: string;
}
export interface LinkView {
  id: string;
  name: string;
  archived: boolean;
  host: string | null;
  identity: string | null;
  routerOsVersion: string | null;
  boardName: string | null;
  setupPending: boolean;
  setupUsedAt: string | null;
  linkedAt: string | null;
  agentLastSeenAt: string | null;
  agentOnline: boolean;
  simulated: boolean;
  ports: Array<{ name: string; type: string; running: boolean; bridge: string | null; addresses: string[] }>;
  wanChoices: string[];
  wanGuess: string | null;
  services: ServicesView | null;
  hotspotDnsName: string | null;
  change: { id: string; status: string; error: string | null; createdAt: string; deliveredAt: string | null; appliedAt: string | null; deliveries: number } | null;
  canSimulate: boolean;
  adapter: string;
}
interface SetupCommand {
  command: string;
  expiresAt: string;
  warnings: string[];
  managementSources: string[];
}

function usePoll(fn: () => void, enabled: boolean, ms = 3000) {
  React.useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") fn();
    }, ms);
    return () => window.clearInterval(id);
  }, [fn, enabled, ms]);
}

export function SetupWizard({ initial, initialStep, canWrite }: { initial: LinkView; initialStep: StepKey; canWrite: boolean }) {
  const [state, setState] = React.useState(initial);
  const [step, setStepState] = React.useState<StepKey>(initialStep);
  const setStep = React.useCallback((s: StepKey) => {
    setStepState(s);
    window.history.replaceState(null, "", `?step=${s}`);
    window.scrollTo({ top: 0 });
  }, []);
  const reload = React.useCallback(async () => {
    try {
      const res = await api<{ data: LinkView }>(`/routers/${initial.id}/link`);
      setState(res.data);
    } catch {
      // keep the last state; the next poll retries
    }
  }, [initial.id]);

  return (
    <div className="space-y-5">
      <LinkStepper active={step} />
      {state.archived ? <Alert tone="warning">This router is archived. It cannot be set up.</Alert> : null}
      {step === "provision" ? <ProvisionStep state={state} reload={reload} canWrite={canWrite && !state.archived} onNext={() => setStep("services")} /> : null}
      {step === "services" ? <ServicesStep state={state} reload={reload} canWrite={canWrite && !state.archived} onBack={() => setStep("provision")} onNext={() => setStep("done")} /> : null}
      {step === "done" ? <DoneStep state={state} onBack={() => setStep("services")} /> : null}
    </div>
  );
}

function SimulateButton({ id, reload, label }: { id: string; reload: () => Promise<void>; label: string }) {
  const { mutate, pending } = useMutation();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={async () => {
        const ok = await mutate(`/routers/${id}/simulate`, { method: "POST" }, { refresh: false, success: "Simulated router checked in" });
        if (ok) await reload();
      }}
    >
      <FlaskConical /> {label}
    </Button>
  );
}

function CopyBox({ text, label }: { text: string; label: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Copy failed. Select the text instead.");
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border bg-surface-muted p-3">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed" aria-label={label}>
        {text}
      </code>
      <Button size="sm" variant="secondary" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        <Copy /> Copy
      </Button>
    </div>
  );
}

function ProvisionStep({ state, reload, canWrite, onNext }: { state: LinkView; reload: () => Promise<void>; canWrite: boolean; onNext: () => void }) {
  const now = useNow(1000);
  const [cmd, setCmd] = React.useState<SetupCommand | null>(null);
  const { mutate, pending, formError } = useMutation<SetupCommand>();
  const requested = React.useRef(false);
  const generate = React.useCallback(() => mutate(`/routers/${state.id}/setup-command`, { method: "POST" }, { refresh: false, onSuccess: setCmd }), [mutate, state.id]);
  React.useEffect(() => {
    if (requested.current || !canWrite || state.linkedAt) return;
    requested.current = true;
    void generate();
  }, [canWrite, state.linkedAt, generate]);
  const linked = Boolean(state.linkedAt);
  // Poll until the router checks in (and after a new command, to show the fresh check-in).
  usePoll(reload, !linked || Boolean(cmd));
  const expired = cmd && now !== null && new Date(cmd.expiresAt).getTime() < now;
  const model = [state.boardName, state.routerOsVersion ? `RouterOS ${state.routerOsVersion}` : null].filter(Boolean).join(" · ");

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Run this command on {state.name}</h2>
          <p className="text-sm text-muted-foreground">
            Open the router&apos;s terminal (WinBox → New Terminal, or SSH), paste the command and press Enter. It downloads Cloudlink&apos;s setup script and runs it. The command works once and
            expires after 30 minutes.
          </p>
        </div>
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {cmd ? (
          <>
            <CopyBox text={cmd.command} label="Setup command" />
            <p className="text-xs text-muted-foreground">
              {expired ? "This command has expired. " : `Expires at ${new Date(cmd.expiresAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}. `}
              Treat it like a password until it has been used.
            </p>
            {cmd.warnings.map((w) => (
              <Alert key={w} tone="warning">
                {w}
              </Alert>
            ))}
          </>
        ) : linked ? (
          <p className="text-sm text-muted-foreground">The router is already linked. Generate a new command only to reinstall the agent, for example after resetting the router.</p>
        ) : !canWrite ? (
          <Alert tone="info">Only staff who can manage routers can generate the command.</Alert>
        ) : null}
        {canWrite && (linked || expired || formError) ? (
          <Button variant="secondary" size="sm" loading={pending} onClick={() => void generate()}>
            <RefreshCw /> {cmd || !linked ? "New command" : "Generate a new command"}
          </Button>
        ) : null}

        <div className={cn("rounded-2xl border p-4", linked ? "border-success/40 bg-success/10" : "border-border bg-surface-muted")} role="status" aria-live="polite">
          {linked ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
                <div className="min-w-0">
                  <p className="font-semibold">Router linked{state.simulated ? " (simulated)" : ""}</p>
                  <p className="text-sm text-muted-foreground">
                    {[state.identity ?? state.name, model].filter(Boolean).join(" · ")}
                    {state.agentLastSeenAt && now !== null ? ` · last check-in ${relativeAge(now - new Date(state.agentLastSeenAt).getTime())}` : ""}
                  </p>
                </div>
              </div>
              <Button onClick={onNext}>
                Continue <ArrowRight />
              </Button>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-accent" aria-hidden />
              <div>
                <p className="font-semibold">Waiting for the router to run the command…</p>
                <p className="text-sm text-muted-foreground">This page updates by itself when the router checks in. Nothing after two minutes? Check the router&apos;s log (System → Logs) for lines starting with &quot;Cloudlink&quot;.</p>
              </div>
            </div>
          )}
        </div>
        {state.canSimulate && canWrite && (cmd || linked) ? (
          <Alert tone="info" title="Test mode">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>No real router will call in on this deployment. Simulate one to try the next steps; everything it reports is marked as simulated.</span>
              <SimulateButton id={state.id} reload={reload} label="Simulate the router" />
            </span>
          </Alert>
        ) : null}
      </Card>
      <Card className="space-y-2 p-5 text-sm">
        <h2 className="font-semibold">What the script does</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>Sets the router&apos;s name to &quot;{state.name}&quot;.</li>
          <li>Creates a limited API user with a new password, usable only from Cloudlink&apos;s private addresses.</li>
          <li>Installs the Cloudlink agent: every minute the router reports its ports and picks up changes you make here.</li>
          <li>Deletes itself, because it contains the password.</li>
        </ul>
        <p className="text-muted-foreground">It does not change routing, firewall rules for your own traffic, or anything you set up yourself.</p>
      </Card>
    </div>
  );
}

const USE_LABEL: Record<PortUse, string> = { off: "Not used", hotspot: "Hotspot", pppoe: "PPPoE", both: "Hotspot and PPPoE" };

function ServicesStep({ state, reload, canWrite, onBack, onNext }: { state: LinkView; reload: () => Promise<void>; canWrite: boolean; onBack: () => void; onNext: () => void }) {
  const saved = state.services;
  const [hotspot, setHotspot] = React.useState(saved?.hotspot ?? true);
  const [pppoe, setPppoe] = React.useState(saved?.pppoe ?? false);
  const [wan, setWan] = React.useState(saved?.wanInterface ?? state.wanGuess ?? "");
  const [uses, setUses] = React.useState<Record<string, PortUse>>(() => Object.fromEntries((saved?.ports ?? []).map((p) => [p.name, p.use])));
  const [blockSharing, setBlockSharing] = React.useState(saved?.blockSharing ?? true);
  const { mutate, pending, errors, formError } = useMutation<{ changeId: string; status: string }>();
  const change = state.change;
  const inFlight = change?.status === "PENDING" || change?.status === "DELIVERED";
  usePoll(reload, inFlight);

  if (!state.linkedAt) {
    return (
      <Card className="space-y-3 p-5">
        <Alert tone="warning">The router has not checked in yet. Run the setup command first.</Alert>
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft /> Back to the command
        </Button>
      </Card>
    );
  }

  const options: PortUse[] = ["off", ...(hotspot ? (["hotspot"] as const) : []), ...(pppoe ? (["pppoe"] as const) : []), ...(hotspot && pppoe ? (["both"] as const) : [])];
  const portUse = (name: string): PortUse => {
    const u = uses[name] ?? "off";
    return options.includes(u) ? u : "off";
  };
  const chosen = state.ports.filter((p) => p.name !== wan && portUse(p.name) !== "off");
  const movesBridge = chosen.filter((p) => p.bridge);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    await mutate(
      `/routers/${state.id}/services`,
      {
        method: "PUT",
        body: {
          hotspot,
          pppoe,
          wanInterface: wan,
          ports: chosen.map((p) => ({ name: p.name, use: portUse(p.name) })),
          hotspotNetwork: v.hotspotNetwork ?? "10.5.50.0/24",
          hotspotDnsName: v.hotspotDnsName ?? "wifi.login",
          devicesPerLogin: v.devicesPerLogin ?? "1",
          blockSharing,
          pppoeNetwork: v.pppoeNetwork ?? "10.10.0.0/16",
        },
      },
      { refresh: false, success: "Saved. The router applies it on its next check-in.", onSuccess: () => void reload() },
    );
  };
  const portError = Object.entries(errors).find(([k]) => k === "ports" || k.startsWith("ports."))?.[1];

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-base font-semibold">Services to offer</h2>
          <p className="text-sm text-muted-foreground">Choose one or both. Plans, vouchers and subscriber accounts then use this router.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ServiceCard checked={hotspot} onChange={setHotspot} title="Hotspot" body="Wi-Fi customers buy time with M-Pesa or a voucher on the login page." />
          <ServiceCard checked={pppoe} onChange={setPppoe} title="PPPoE" body="Home and business lines with a username and password on their router." />
        </div>
        {errors.hotspot ? <p className="text-sm text-danger">{errors.hotspot}</p> : null}
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Ports</h2>
            <p className="text-sm text-muted-foreground">Pick the internet port, then what each port serves. Reported by the router{state.simulated ? " (simulated)" : ""}.</p>
          </div>
          <Field id="svc-wan" label="Internet (WAN) port" error={errors.wanInterface} className="w-full sm:w-56">
            <Select value={wan} onChange={(e) => setWan(e.target.value)}>
              {state.wanChoices.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ul className="divide-y divide-border rounded-xl border border-border" aria-label="Router ports">
          {state.ports.map((p) => {
            const isWan = p.name === wan;
            return (
              <li key={p.name} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cn("size-2 shrink-0 rounded-full", p.running ? "bg-success" : "bg-border-strong")} aria-hidden />
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.running ? "Cable connected" : "Nothing connected"}
                      {p.bridge ? ` · in bridge "${p.bridge}"` : ""}
                      {p.addresses.length ? ` · ${p.addresses.join(", ")}` : ""}
                    </p>
                  </div>
                </div>
                {isWan ? (
                  <Badge tone="info">Internet</Badge>
                ) : (
                  <Select aria-label={`Use of ${p.name}`} className="w-48" value={portUse(p.name)} onChange={(e) => setUses((u) => ({ ...u, [p.name]: e.target.value as PortUse }))} disabled={!canWrite}>
                    {options.map((o) => (
                      <option key={o} value={o}>
                        {USE_LABEL[o]}
                      </option>
                    ))}
                  </Select>
                )}
              </li>
            );
          })}
        </ul>
        {portError ? <p className="text-sm text-danger">{portError}</p> : null}
        {movesBridge.length ? (
          <Alert tone="warning" title="Ports leave their current bridge">
            {movesBridge.map((p) => p.name).join(", ")} will move out of their bridge. Do not choose the port your computer is connected through, or you may lose access to the router.
          </Alert>
        ) : null}
        {hotspot && pppoe && chosen.some((p) => portUse(p.name) === "both") ? <p className="text-xs text-muted-foreground">PPPoE on a hotspot port answers on every hotspot port.</p> : null}
      </Card>

      {hotspot ? (
        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">Hotspot settings</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="svc-hs-net" label="Hotspot network" error={errors.hotspotNetwork} hint="The router takes the first address.">
              <Input name="hotspotNetwork" defaultValue={saved?.hotspotNetwork ?? "10.5.50.0/24"} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="svc-hs-dns" label="Login page address" error={errors.hotspotDnsName} hint="Shown in the browser, e.g. wifi.login.">
              <Input name="hotspotDnsName" defaultValue={saved?.hotspotDnsName ?? state.hotspotDnsName ?? "wifi.login"} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="svc-hs-devices" label="Devices per login" error={errors.devicesPerLogin} hint="Plans with their own device limit override this.">
              <Input name="devicesPerLogin" type="number" min={1} max={10} defaultValue={saved?.devicesPerLogin ?? 1} />
            </Field>
          </div>
          <Switch
            id="svc-block-sharing"
            checked={blockSharing}
            onChange={setBlockSharing}
            label="Block connection sharing"
            description="Stops customers re-sharing the hotspot from a phone or their own router. Their devices still work normally."
          />
        </Card>
      ) : null}

      {pppoe ? (
        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">PPPoE settings</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="svc-pp-net" label="Customer address pool" error={errors.pppoeNetwork} hint="The router takes the first address; customers get the rest.">
              <Input name="pppoeNetwork" defaultValue={saved?.pppoeNetwork ?? "10.10.0.0/16"} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          <p className="text-sm text-muted-foreground">PPPoE accounts are created from each subscription. Speeds come from your plans.</p>
        </Card>
      ) : null}

      {change ? <ChangeStatus change={change} state={state} reload={reload} onNext={onNext} /> : null}

      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="secondary" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <div className="flex flex-wrap gap-2">
          {change?.status === "APPLIED" ? (
            <Button type="button" variant="secondary" onClick={onNext}>
              Skip to summary
            </Button>
          ) : null}
          {canWrite ? (
            <Button type="submit" loading={pending}>
              Save and apply
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function ServiceCard({ checked, onChange, title, body }: { checked: boolean; onChange: (v: boolean) => void; title: string; body: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors", checked ? "border-accent bg-accent/10" : "border-border hover:bg-surface-muted")}>
      <input type="checkbox" className="mt-1 size-4 accent-(--accent)" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-muted-foreground">{body}</span>
      </span>
    </label>
  );
}

function ChangeStatus({ change, state, reload, onNext }: { change: NonNullable<LinkView["change"]>; state: LinkView; reload: () => Promise<void>; onNext: () => void }) {
  const now = useNow(1000);
  const tone = change.status === "APPLIED" ? "border-success/40 bg-success/10" : change.status === "FAILED" ? "border-danger/40 bg-danger/10" : "border-border bg-surface-muted";
  return (
    <div className={cn("rounded-2xl border p-4", tone)} role="status" aria-live="polite">
      {change.status === "APPLIED" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
            <div>
              <p className="font-semibold">Applied on the router{state.simulated ? " (simulated)" : ""}</p>
              <p className="text-sm text-muted-foreground">Confirmed by the router {change.appliedAt && now !== null ? relativeAge(now - new Date(change.appliedAt).getTime()) : ""}.</p>
            </div>
          </div>
          <Button type="button" onClick={onNext}>
            Continue <ArrowRight />
          </Button>
        </div>
      ) : change.status === "FAILED" ? (
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <div>
            <p className="font-semibold">The router could not apply the change</p>
            <p className="text-sm text-muted-foreground">{change.error}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-accent" aria-hidden />
            <div>
              <p className="font-semibold">{change.status === "PENDING" ? "Saved. Waiting for the router's next check-in…" : "The router is applying the change…"}</p>
              <p className="text-sm text-muted-foreground">Routers check in every minute. This page updates by itself.</p>
            </div>
          </div>
          {state.canSimulate ? <SimulateButton id={state.id} reload={reload} label="Simulate the check-in" /> : null}
        </div>
      )}
    </div>
  );
}

function DoneStep({ state, onBack }: { state: LinkView; onBack: () => void }) {
  const s = state.services;
  const applied = state.change?.status === "APPLIED";
  const portsFor = (pred: (u: string) => boolean) =>
    s?.ports
      .filter((p) => pred(p.use))
      .map((p) => p.name)
      .join(", ") || "—";
  const rows: Array<[string, React.ReactNode]> = [
    ["Router", `${state.name}${state.identity && state.identity !== state.name ? ` (${state.identity})` : ""}`],
    ["Model", [state.boardName, state.routerOsVersion ? `RouterOS ${state.routerOsVersion}` : null].filter(Boolean).join(" · ") || "Not reported"],
    ["Connection", state.host ? `API at ${state.host} and the Cloudlink agent` : "Cloudlink agent (checks in every minute)"],
    ["Internet port", s?.wanInterface ?? "—"],
    ["Hotspot", s?.hotspot ? `${portsFor((u) => u !== "pppoe")} · ${s.hotspotNetwork} · ${s.devicesPerLogin} device(s) per login${s.blockSharing ? " · sharing blocked" : ""}` : "Off"],
    ["PPPoE", s?.pppoe ? `${portsFor((u) => u !== "hotspot")} · pool ${s.pppoeNetwork}` : "Off"],
  ];
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className={cn("mt-0.5 size-6 shrink-0", applied ? "text-success" : "text-muted-foreground")} aria-hidden />
          <div>
            <h2 className="text-lg font-semibold">{applied ? `${state.name} is ready` : `${state.name} is linked`}</h2>
            <p className="text-sm text-muted-foreground">
              {applied ? "The router confirmed the services below." : "Services are not applied yet. Go back to choose them."}
              {state.simulated ? " This router is simulated (test mode)." : ""}
            </p>
          </div>
        </div>
        <dl className="divide-y divide-border rounded-xl border border-border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[160px_1fr]">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {!state.host ? (
          <Alert tone="info">
            Cloudlink creates PPPoE accounts and hotspot logins on routers through their API. For that, give this router a VPN or private address on its page, or use RADIUS. Until then, the
            agent keeps its services, ports and status up to date.
          </Alert>
        ) : null}
      </Card>
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="secondary" onClick={onBack}>
          <ArrowLeft /> Services
        </Button>
        <div className="flex flex-wrap gap-2">
          <Link href="/packages" className={buttonVariants({ variant: "secondary" })}>
            Set up plans
          </Link>
          {s?.hotspot ? (
            <Link href="/vouchers" className={buttonVariants({ variant: "secondary" })}>
              Vouchers
            </Link>
          ) : null}
          <Link href={`/routers/${state.id}`} className={buttonVariants()}>
            Open router <ArrowRight />
          </Link>
        </div>
      </div>
    </div>
  );
}
