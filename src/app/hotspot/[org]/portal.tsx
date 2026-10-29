"use client";

import * as React from "react";
import { CheckCircle2, Clock, Gift, Loader2, Phone, Smartphone, Tv, Wifi, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { durationLabel, formatRate, quotaLabel, type DurationUnit } from "@/lib/plans";
import { HotspotForm } from "./form";

export interface PortalPlan {
  id: string;
  name: string;
  description: string | null;
  kind: "TIME" | "DATA" | "TRIAL" | "DEVICE";
  price: string;
  free: boolean;
  payable: boolean;
  billingUnit: DurationUnit;
  billingCount: number;
  downloadKbps: number | null;
  uploadKbps: number | null;
  dataQuotaMb: number | null;
  deviceLimit: number | null;
  highlight: string | null;
  availableNow: boolean;
  schedule: string | null;
}

export interface PortalProps {
  org: string;
  currency: string;
  plans: PortalPlan[];
  routerId: string | null;
  mac: string | null;
  ip: string | null;
  loginUrl: string | null;
  dst: string | null;
  mpesa: boolean;
  testMode: boolean;
}

interface Grant {
  subscriptionId: string;
  username: string;
  password: string;
  packageName: string;
  accessEndsAt: string | null;
  ready: boolean;
  simulated: boolean;
  failed: boolean;
}

interface PurchaseStatus {
  status: string;
  detail: string | null;
  receipt: string | null;
  testMode: boolean;
  grant: Grant | null;
}

type Step = { name: "browse" } | { name: "pay"; plan: PortalPlan } | { name: "waiting"; plan: string; attemptId: string; token: string; testMode: boolean } | { name: "connecting"; grant: Grant; receipt: string | null } | { name: "failed"; message: string };

const PHONE_KEY = "cloudlink.hotspot.phone";
const pendingKey = (org: string) => `cloudlink.hotspot.pending.${org}`;
const FINAL_FAILURES = new Set(["FAILED", "CANCELLED", "EXPIRED"]);

function readStorage(store: "local" | "session", key: string): string | null {
  try {
    return (store === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(store: "local" | "session", key: string, value: string | null) {
  try {
    const s = store === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage unavailable (private browsing): the page still works, it just does not remember.
  }
}

export function priceLabel(currency: string, price: string): string {
  const n = Number(price);
  return Number.isInteger(n) ? `${currency} ${n.toLocaleString("en-KE")}` : `${currency} ${n.toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;
}

export function planFacts(p: PortalPlan): string {
  const parts = [durationLabel(p.billingUnit, p.billingCount)];
  if (p.dataQuotaMb) parts.push(quotaLabel(p.dataQuotaMb));
  if (p.downloadKbps) parts.push(`up to ${formatRate(p.downloadKbps)}bps`);
  if (p.deviceLimit && p.deviceLimit > 1) parts.push(`${p.deviceLimit} devices`);
  return parts.join(" · ");
}

/** Captive-portal purchase flow. Nothing is shown as paid or connected until the server says so. */
export function HotspotPortal(props: PortalProps) {
  const { org, currency, plans } = props;
  const [tab, setTab] = React.useState<"buy" | "voucher" | "paid">(props.mpesa && plans.length ? "buy" : "voucher");
  const [step, setStep] = React.useState<Step>({ name: "browse" });
  const loginForm = React.useRef<HTMLFormElement>(null);

  // Resume a purchase after a reload (the token lives only in this tab).
  React.useEffect(() => {
    const raw = readStorage("session", pendingKey(org));
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as { attemptId: string; token: string; plan: string; testMode: boolean };
      queueMicrotask(() => setStep({ name: "waiting", ...p }));
    } catch {
      writeStorage("session", pendingKey(org), null);
    }
  }, [org]);

  // Follow the payment until it is confirmed (or fails).
  React.useEffect(() => {
    if (step.name !== "waiting") return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      if (stop) return;
      try {
        const r = await api<{ data: PurchaseStatus }>(`/hotspot/${org}/purchase/status`, { method: "POST", body: { attemptId: step.attemptId, token: step.token } });
        if (stop) return;
        const s = r.data;
        if (s.grant) {
          writeStorage("session", pendingKey(org), null);
          setStep({ name: "connecting", grant: s.grant, receipt: s.receipt });
          return;
        }
        if (FINAL_FAILURES.has(s.status)) {
          writeStorage("session", pendingKey(org), null);
          setStep({ name: "failed", message: s.detail ?? "The payment did not go through." });
          return;
        }
        if (s.status === "CONFIRMED") {
          writeStorage("session", pendingKey(org), null);
          setStep({ name: "failed", message: s.detail ?? "Your payment was received but could not be applied automatically. Please contact support." });
          return;
        }
        if (s.status === "UNKNOWN" && tries > 20) {
          setStep({ name: "failed", message: "We could not confirm the payment yet. If money left your M-Pesa, use “Already paid?” with the confirmation code." });
          return;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          writeStorage("session", pendingKey(org), null);
          setStep({ name: "browse" });
          return;
        }
      }
      if (tries++ < 120) setTimeout(poll, 2000);
      else setStep({ name: "failed", message: "This is taking longer than expected. If you paid, use “Already paid?” with your M-Pesa code." });
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [step, org]);

  // Wait for the router to accept the login, then hand the details to the router's own login form.
  React.useEffect(() => {
    if (step.name !== "connecting" || step.grant.ready || step.grant.failed) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      if (stop) return;
      try {
        const r = await api<{ data: { ready: boolean; simulated: boolean; failed: boolean } }>(`/hotspot/${org}/access`, {
          method: "POST",
          body: { subscriptionId: step.grant.subscriptionId, username: step.grant.username, password: step.grant.password },
        });
        if (stop) return;
        if (r.data.ready || r.data.failed) {
          setStep({ ...step, grant: { ...step.grant, ...r.data } });
          return;
        }
      } catch {
        // keep trying
      }
      if (tries++ < 60) setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [step, org]);

  React.useEffect(() => {
    if (step.name === "connecting" && step.grant.ready && !step.grant.simulated && props.loginUrl) loginForm.current?.submit();
  }, [step, props.loginUrl]);

  const groups = {
    time: plans.filter((p) => p.kind === "TIME" || p.kind === "TRIAL"),
    data: plans.filter((p) => p.kind === "DATA"),
    device: plans.filter((p) => p.kind === "DEVICE"),
  };

  return (
    <div className="space-y-5">
      <nav aria-label="Ways to connect" className="grid grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1 text-sm font-medium">
        {(
          [
            ["buy", "Buy a plan", props.mpesa && plans.length > 0],
            ["voucher", "Voucher", true],
            ["paid", "Already paid?", props.mpesa],
          ] as const
        )
          .filter(([, , shown]) => shown)
          .map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
                if (step.name === "pay" || step.name === "failed") setStep({ name: "browse" });
              }}
              className={cn("rounded-md px-2 py-2 transition-colors", tab === value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
      </nav>

      {step.name === "waiting" ? (
        <Waiting org={org} step={step} onCancel={() => setStep({ name: "browse" })} />
      ) : step.name === "connecting" ? (
        <Connecting grant={step.grant} receipt={step.receipt} loginUrl={props.loginUrl} />
      ) : step.name === "failed" ? (
        <div className="space-y-3 text-center" role="alert">
          <XCircle className="mx-auto size-10 text-danger" aria-hidden />
          <p className="font-medium">{step.message}</p>
          <Button variant="secondary" onClick={() => setStep({ name: "browse" })}>
            Try again
          </Button>
        </div>
      ) : tab === "voucher" ? (
        <HotspotForm org={org} mac={props.mac} ip={props.ip} loginUrl={props.loginUrl} />
      ) : tab === "paid" ? (
        <Reconnect org={org} routerId={props.routerId} mac={props.mac} onGrant={(grant) => setStep({ name: "connecting", grant, receipt: null })} />
      ) : step.name === "pay" ? (
        <Pay {...props} plan={step.plan} onBack={() => setStep({ name: "browse" })} onWaiting={(w) => setStep(w)} onGrant={(grant) => setStep({ name: "connecting", grant, receipt: null })} />
      ) : (
        <div className="space-y-5">
          {groups.time.length ? <PlanList title={groups.data.length || groups.device.length ? "Time plans" : null} plans={groups.time} currency={currency} onPick={(plan) => setStep({ name: "pay", plan })} /> : null}
          {groups.data.length ? <PlanList title="Data bundles" plans={groups.data} currency={currency} onPick={(plan) => setStep({ name: "pay", plan })} /> : null}
          {groups.device.length ? <PlanList title="TV & streaming devices" plans={groups.device} currency={currency} onPick={(plan) => setStep({ name: "pay", plan })} /> : null}
        </div>
      )}

      {step.name === "connecting" && props.loginUrl ? (
        <form ref={loginForm} method="post" action={props.loginUrl} className="hidden">
          <input type="hidden" name="username" value={step.grant.username} />
          <input type="hidden" name="password" value={step.grant.password} />
          {props.dst ? <input type="hidden" name="dst" value={props.dst} /> : null}
          <input type="hidden" name="popup" value="true" />
        </form>
      ) : null}
    </div>
  );
}

function PlanList({ title, plans, currency, onPick }: { title: string | null; plans: PortalPlan[]; currency: string; onPick: (p: PortalPlan) => void }) {
  return (
    <section className="space-y-2" aria-label={title ?? "Plans"}>
      {title ? <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2> : null}
      <ul className="space-y-2">
        {plans.map((p) => {
          const disabled = !p.availableNow || !p.payable;
          return (
            <li key={p.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(p)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  p.highlight === "POPULAR" ? "border-accent bg-accent-soft/40" : "border-border bg-surface hover:border-border-strong",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  {p.kind === "DEVICE" ? <Tv className="size-4" aria-hidden /> : p.kind === "TRIAL" ? <Gift className="size-4" aria-hidden /> : p.kind === "DATA" ? <Zap className="size-4" aria-hidden /> : <Wifi className="size-4" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{p.name}</span>
                    {p.highlight ? <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-foreground">{p.highlight === "POPULAR" ? "Most popular" : "On offer"}</span> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">{planFacts(p)}</span>
                  {!p.availableNow && p.schedule ? <span className="block text-xs text-warning">Available {p.schedule}</span> : null}
                </span>
                <span className="shrink-0 text-right font-semibold tabular">{p.free ? "Free" : priceLabel(currency, p.price)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Pay(props: PortalProps & { plan: PortalPlan; onBack: () => void; onWaiting: (s: Extract<Step, { name: "waiting" }>) => void; onGrant: (g: Grant) => void }) {
  const { plan } = props;
  const [phone, setPhone] = React.useState("");
  const [deviceMac, setDeviceMac] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const requestId = React.useRef<string>("");
  React.useEffect(() => {
    const saved = readStorage("local", PHONE_KEY);
    if (saved) queueMicrotask(() => setPhone(saved));
    requestId.current = crypto.randomUUID();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const r = await api<{ data: { attemptId?: string; token?: string; status?: string; detail?: string | null; testMode?: boolean; trial?: true; grant?: Grant } }>(`/hotspot/${props.org}/purchase`, {
        method: "POST",
        body: { packageId: plan.id, phone, mac: props.mac, ip: props.ip, routerId: props.routerId, deviceMac: plan.kind === "DEVICE" ? deviceMac : null, requestId: requestId.current },
      });
      writeStorage("local", PHONE_KEY, phone);
      if (r.data.grant) {
        props.onGrant(r.data.grant);
        return;
      }
      if (r.data.status === "FAILED") {
        setError(r.data.detail ?? "M-Pesa did not accept the request. Try again.");
        requestId.current = crypto.randomUUID();
        return;
      }
      const waiting = { name: "waiting" as const, plan: plan.name, attemptId: r.data.attemptId!, token: r.data.token!, testMode: Boolean(r.data.testMode) };
      writeStorage("session", pendingKey(props.org), JSON.stringify({ attemptId: waiting.attemptId, token: waiting.token, plan: waiting.plan, testMode: waiting.testMode }));
      props.onWaiting(waiting);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(Object.fromEntries((err.fields ?? []).map((f) => [f.path, f.message])));
      } else setError("Could not reach the server. Check the WiFi signal and try again.");
      // After a network failure the request may have gone through: retry with the same id (same purchase, no second prompt).
      if (err instanceof ApiError && err.status !== 0) requestId.current = crypto.randomUUID();
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="rounded-xl border border-border bg-surface-muted/50 px-4 py-3">
        <p className="font-medium">{plan.name}</p>
        <p className="text-sm text-muted-foreground">{planFacts(plan)}</p>
        <p className="mt-1 text-lg font-semibold tabular">{plan.free ? "Free trial" : priceLabel(props.currency, plan.price)}</p>
      </div>
      {plan.kind === "DEVICE" ? (
        <Field id="hs-device-mac" label="TV or device MAC address" error={fieldErrors.deviceMac} hint="Find it in the device's network settings, e.g. AA:BB:CC:DD:EE:FF." required>
          <Input value={deviceMac} onChange={(e) => setDeviceMac(e.target.value)} autoCapitalize="characters" spellCheck={false} placeholder="AA:BB:CC:DD:EE:FF" className="h-11 font-mono uppercase" />
        </Field>
      ) : null}
      <Field id="hs-phone" label={plan.free ? "Your phone number" : "M-Pesa phone number"} error={fieldErrors.phone} required hint={plan.free ? undefined : "You will get a prompt on this phone to enter your M-Pesa PIN."}>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" className="h-11 text-base" />
      </Field>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="h-12 w-full text-base" loading={pending}>
        {plan.free ? "Start free trial" : `Pay ${priceLabel(props.currency, plan.price)} with M-Pesa`}
      </Button>
      <button type="button" onClick={props.onBack} className="w-full text-center text-sm text-muted-foreground hover:text-foreground">
        Choose another plan
      </button>
    </form>
  );
}

function Waiting({ org, step, onCancel }: { org: string; step: Extract<Step, { name: "waiting" }>; onCancel: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const simulate = async (outcome: "success" | "cancelled") => {
    setBusy(true);
    try {
      await api(`/hotspot/${org}/purchase/simulate`, { method: "POST", body: { attemptId: step.attemptId, token: step.token, outcome } });
    } catch {
      // the status poll shows the outcome
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 text-center" role="status" aria-live="polite">
      <Smartphone className="mx-auto size-10 text-accent" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">Check your phone</p>
        <p className="text-sm text-muted-foreground">Enter your M-Pesa PIN to pay for {step.plan}. This page continues by itself.</p>
      </div>
      <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden />
      {step.testMode ? (
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-left text-sm">
          <p className="font-medium text-warning">Test mode: no prompt was sent and no money moves.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy} onClick={() => void simulate("success")}>
              Simulate payment
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void simulate("cancelled")}>
              Simulate cancel
            </Button>
          </div>
        </div>
      ) : null}
      <button type="button" onClick={onCancel} className="text-sm text-muted-foreground hover:text-foreground">
        Start again
      </button>
    </div>
  );
}

function Connecting({ grant, receipt, loginUrl }: { grant: Grant; receipt: string | null; loginUrl: string | null }) {
  const until = grant.accessEndsAt ? new Date(grant.accessEndsAt).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : null;
  if (grant.failed) {
    return (
      <div className="space-y-2 text-center" role="alert">
        <XCircle className="mx-auto size-10 text-danger" aria-hidden />
        <p className="font-medium">Paid, but we could not switch your access on</p>
        <p className="text-sm text-muted-foreground">Your payment is safe{receipt ? ` (M-Pesa ${receipt})` : ""}. Please contact support; we will connect you without charging again.</p>
      </div>
    );
  }
  if (!grant.ready) {
    return (
      <div className="space-y-2 text-center" role="status" aria-live="polite">
        <Clock className="mx-auto size-10 text-info" aria-hidden />
        <p className="font-medium">{receipt ? "Payment received" : "Plan found"} — connecting you…</p>
        {receipt ? <p className="text-sm text-muted-foreground">M-Pesa confirmation {receipt}</p> : null}
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  return (
    <div className="space-y-3 text-center" role="status" aria-live="polite">
      <CheckCircle2 className={cn("mx-auto size-10", grant.simulated ? "text-warning" : "text-success")} aria-hidden />
      <p className="font-medium">{grant.simulated ? "Plan active (test mode)" : loginUrl ? "Logging you in…" : "Your plan is active"}</p>
      {grant.simulated ? <p className="text-sm text-muted-foreground">This hotspot runs in simulation mode. No real internet session was started.</p> : null}
      <p className="text-sm text-muted-foreground">
        {grant.packageName}
        {until ? ` · until ${until}` : ""}
      </p>
      {!loginUrl || grant.simulated ? (
        <dl className="mx-auto grid max-w-xs grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-muted/50 p-3 text-left text-sm">
          <dt className="text-muted-foreground">Username</dt>
          <dd className="font-mono">{grant.username}</dd>
          <dt className="text-muted-foreground">Password</dt>
          <dd className="font-mono">{grant.password}</dd>
        </dl>
      ) : null}
    </div>
  );
}

function Reconnect({ org, routerId, mac, onGrant }: { org: string; routerId: string | null; mac: string | null; onGrant: (g: Grant) => void }) {
  const [phone, setPhone] = React.useState("");
  const [receipt, setReceipt] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    const saved = readStorage("local", PHONE_KEY);
    if (saved) queueMicrotask(() => setPhone(saved));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const r = await api<{ data: { grant: Grant } }>(`/hotspot/${org}/reconnect`, { method: "POST", body: { phone, receipt, mac, routerId } });
      onGrant(r.data.grant);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">Bought a plan already? Enter the phone you paid with and the code from the M-Pesa message to connect this device.</p>
      <Field id="rc-phone" label="M-Pesa phone number" required>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" className="h-11 text-base" />
      </Field>
      <Field id="rc-receipt" label="M-Pesa confirmation code" required>
        <Input value={receipt} onChange={(e) => setReceipt(e.target.value)} autoCapitalize="characters" spellCheck={false} placeholder="UJT17BQ5BX" className="h-11 font-mono uppercase" />
      </Field>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="h-12 w-full text-base" loading={pending}>
        <Phone /> Reconnect
      </Button>
    </form>
  );
}
