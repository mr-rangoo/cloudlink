"use client";

import * as React from "react";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api-client";

type Status = { activationStatus: string; activationDetail: string | null; accessEndsAt: string };

/** Redeem, then poll the server for the real activation result. Nothing is shown as connected until the server says so. */
export function HotspotForm({ org, mac, ip, loginUrl }: { org: string; mac: string | null; ip: string | null; loginUrl: string | null }) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [redeemed, setRedeemed] = React.useState<{ id: string; code: string; packageName: string } | null>(null);
  const [status, setStatus] = React.useState<Status | null>(null);
  const loginForm = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    if (!redeemed) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      if (stop) return;
      try {
        const r = await api<{ data: Status }>(`/hotspot/${org}/status`, { method: "POST", body: { redemptionId: redeemed.id, code: redeemed.code } });
        setStatus(r.data);
        if (r.data.activationStatus === "PENDING" && tries++ < 40) setTimeout(poll, 1500);
      } catch {
        if (tries++ < 40) setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [redeemed, org]);

  React.useEffect(() => {
    // Real activation on a router: hand the credentials to the router's own login form.
    if (status?.activationStatus === "ACTIVE" && loginUrl) loginForm.current?.submit();
  }, [status, loginUrl]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    setPending(true);
    setError(null);
    try {
      const r = await api<{ data: { redemptionId: string; packageName: string } }>(`/hotspot/${org}/redeem`, { method: "POST", body: { code, mac, ip } });
      setRedeemed({ id: r.data.redemptionId, code, packageName: r.data.packageName });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  if (redeemed) {
    const s = status?.activationStatus ?? "PENDING";
    return (
      <div className="space-y-3 text-center" role="status" aria-live="polite">
        {s === "PENDING" ? (
          <>
            <Clock className="mx-auto size-10 text-info" aria-hidden />
            <p className="font-medium">Voucher accepted — connecting you…</p>
          </>
        ) : s === "ACTIVE" ? (
          <>
            <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
            <p className="font-medium">You are connected</p>
          </>
        ) : s === "SIMULATED" ? (
          <>
            <Clock className="mx-auto size-10 text-warning" aria-hidden />
            <p className="font-medium">Voucher accepted (test mode)</p>
            <p className="text-sm text-muted-foreground">This hotspot runs in simulation mode. No real internet session was started.</p>
          </>
        ) : (
          <>
            <XCircle className="mx-auto size-10 text-danger" aria-hidden />
            <p className="font-medium">Voucher accepted, but we could not start your session</p>
            <p className="text-sm text-muted-foreground">Please contact support and quote your voucher. It has not been charged twice.</p>
          </>
        )}
        <p className="text-sm text-muted-foreground">
          {redeemed.packageName}
          {status ? ` · valid until ${new Date(status.accessEndsAt).toLocaleString("en-KE")}` : ""}
        </p>
        {loginUrl ? (
          <form ref={loginForm} method="post" action={loginUrl} className="hidden">
            <input type="hidden" name="username" value={redeemed.code} />
            <input type="hidden" name="password" value={redeemed.code} />
          </form>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field id="code" label="Voucher code">
        <Input name="code" autoCapitalize="characters" autoComplete="one-time-code" inputMode="text" placeholder="XXXX-XXXX-XX" className="h-12 text-center font-mono text-lg uppercase tracking-widest" />
      </Field>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" loading={pending}>
        Connect
      </Button>
    </form>
  );
}
