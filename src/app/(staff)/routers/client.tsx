"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, Copy, KeyRound, Pencil, Plus, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { formValues, useMutation } from "@/components/use-mutation";

export interface RouterFormValues {
  id: string;
  name: string;
  host: string;
  apiPort: number;
  useTls: boolean;
  pppoeAuth: string;
  pppoeEnabled: boolean;
  hotspotEnabled: boolean;
  branchId: string | null;
  notes: string | null;
}

/** Register or edit a router. Credentials are only collected on creation (rotation has its own dialog). */
export function RouterFormDialog({ router, branches }: { router?: RouterFormValues; branches: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      name: v.name,
      host: v.host,
      apiPort: v.apiPort ?? "8728",
      useTls: v.useTls === "on",
      pppoeAuth: v.pppoeAuth,
      pppoeEnabled: v.pppoeEnabled === "on",
      hotspotEnabled: v.hotspotEnabled === "on",
      branchId: v.branchId ?? null,
      notes: v.notes ?? null,
      ...(router ? {} : { username: v.username, password: v.password }),
    };
    const ok = await mutate(router ? `/routers/${router.id}` : "/routers", { method: router ? "PATCH" : "POST", body }, { success: router ? "Router updated" : "Router registered" });
    if (ok) setOpen(false);
  };
  const p = router?.id ?? "new";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {router ? (
          <Button variant="secondary">
            <Pencil /> Edit
          </Button>
        ) : (
          <Button>
            <Plus /> Add router
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={router ? "Edit router" : "Register a router"} description="Use the router's private LAN or VPN address. Public addresses and hostnames are refused." wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`r-name-${p}`} label="Name" error={errors.name} required>
              <Input name="name" defaultValue={router?.name} placeholder="Core-Westlands" />
            </Field>
            <Field id={`r-branch-${p}`} label="Branch" error={errors.branchId}>
              <Select name="branchId" defaultValue={router?.branchId ?? ""}>
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={`r-host-${p}`} label="Management IP (private or VPN)" error={errors.host} required>
              <Input name="host" defaultValue={router?.host} placeholder="10.8.0.2" inputMode="decimal" autoComplete="off" spellCheck={false} />
            </Field>
            <Field id={`r-port-${p}`} label="API port" hint="8728 (API) or 8729 (API-SSL)" error={errors.apiPort}>
              <Input name="apiPort" defaultValue={router?.apiPort ?? 8728} inputMode="numeric" />
            </Field>
            <Field id={`r-auth-${p}`} label="PPPoE authentication" error={errors.pppoeAuth}>
              <Select name="pppoeAuth" defaultValue={router?.pppoeAuth ?? "LOCAL"}>
                <option value="LOCAL">Local PPP secrets (RouterOS API)</option>
                <option value="RADIUS">RADIUS (FreeRADIUS SQL)</option>
              </Select>
            </Field>
            <Field id={`r-notes-${p}`} label="Notes" error={errors.notes}>
              <Input name="notes" defaultValue={router?.notes ?? ""} />
            </Field>
          </div>
          <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <legend className="sr-only">Connection and services</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="useTls" defaultChecked={router?.useTls ?? false} /> Use TLS (API-SSL)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="pppoeEnabled" defaultChecked={router?.pppoeEnabled ?? true} /> PPPoE
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="hotspotEnabled" defaultChecked={router?.hotspotEnabled ?? false} /> Hotspot
            </label>
          </fieldset>
          {!router ? (
            <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Create a dedicated RouterOS user with only the policies Cloudlink needs (api, read, write). The password is encrypted and cannot be viewed again.
              </p>
              <Field id={`r-user-${p}`} label="API username" error={errors.username} required>
                <Input name="username" autoComplete="off" spellCheck={false} />
              </Field>
              <Field id={`r-pass-${p}`} label="API password" error={errors.password} required>
                <Input name="password" type="password" autoComplete="new-password" />
              </Field>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {router ? "Save changes" : "Register router"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RotateCredentialsDialog({ routerId }: { routerId: string }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/routers/${routerId}`, { method: "PATCH", body: { username: v.username, password: v.password } }, { success: "Credentials replaced" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <KeyRound /> Replace credentials
        </Button>
      </DialogTrigger>
      <DialogContent title="Replace API credentials" description="The old credentials are overwritten. Run a health check afterwards to confirm the router accepts them.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id={`rc-user-${routerId}`} label="API username" error={errors.username} required>
            <Input name="username" autoComplete="off" spellCheck={false} />
          </Field>
          <Field id={`rc-pass-${routerId}`} label="API password" error={errors.password} required>
            <Input name="password" type="password" autoComplete="new-password" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Replace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Queue a health check; the worker records the result, so re-read the page a few seconds later. */
export function HealthCheckButton({ routerId }: { routerId: string }) {
  const router = useRouter();
  const { mutate, pending } = useMutation();
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={async () => {
        const ok = await mutate(`/routers/${routerId}/health-check`, { method: "POST" }, { success: "Health check queued. Results appear in a few seconds." });
        if (ok) setTimeout(() => router.refresh(), 3000);
      }}
    >
      <Activity /> Check now
    </Button>
  );
}

export function ArchiveRouterButton({ routerId, name }: { routerId: string; name: string }) {
  return (
    <ActionDialog
      label="Archive"
      triggerVariant="ghost"
      triggerSize="md"
      tone="danger"
      title="Archive router"
      description={name}
      path={`/routers/${routerId}/archive`}
      success="Router archived"
      impact="Archived routers are no longer checked or used. Subscriptions must be moved or have their access removed first."
    />
  );
}

export function DisconnectSessionDialog({ routerId }: { routerId: string }) {
  return (
    <ActionDialog
      label="Disconnect a session"
      triggerVariant="secondary"
      triggerSize="md"
      title="Disconnect a session"
      description="The user can reconnect immediately unless their access is disabled."
      path={`/routers/${routerId}/operations`}
      success="Disconnect queued"
      extraBody={(v) => ({ type: "session.disconnect", kind: v.kind, username: v.username, reason: v.reason })}
    >
      {(errors) => (
        <>
          <Field id={`ds-kind-${routerId}`} label="Session type">
            <Select name="kind" defaultValue="PPPOE">
              <option value="PPPOE">PPPoE</option>
              <option value="HOTSPOT">Hotspot</option>
            </Select>
          </Field>
          <Field id={`ds-user-${routerId}`} label="Username" error={errors.username} required>
            <Input name="username" autoComplete="off" spellCheck={false} />
          </Field>
          <Field id={`ds-reason-${routerId}`} label="Reason" error={errors.reason}>
            <Input name="reason" />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}

/** One-time setup command: paste into the router terminal. Shown once; a new one replaces the old. */
export function SetupCommandDialog({ routerId, name }: { routerId: string; name: string }) {
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{ command: string; expiresAt: string; warnings: string[]; managementSources: string[] } | null>(null);
  const { mutate, pending, formError } = useMutation<{ command: string; expiresAt: string; warnings: string[]; managementSources: string[] }>();
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.command);
      toast.success("Command copied");
    } catch {
      toast.error("Copy failed. Select the text instead.");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setResult(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Terminal /> Setup command
        </Button>
      </DialogTrigger>
      <DialogContent title="Router setup command" description={name} wide>
        <div className="space-y-4 text-sm">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          {result ? (
            <>
              <p>Paste this into the router&apos;s terminal (WinBox → New Terminal, or SSH). It works once and expires at {new Date(result.expiresAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}.</p>
              <pre className="whitespace-pre-wrap break-all rounded-md border border-border bg-surface-muted p-3 font-mono text-xs">{result.command}</pre>
              <Button size="sm" variant="secondary" onClick={copy}>
                <Copy /> Copy command
              </Button>
              {result.warnings.map((w) => (
                <Alert key={w} tone="warning">
                  {w}
                </Alert>
              ))}
              <p className="text-xs text-muted-foreground">API access will be limited to: {result.managementSources.join(", ")}. Treat this command like a password until it has been used.</p>
            </>
          ) : (
            <>
              <p>The router downloads a Cloudlink script that:</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>creates a limited API user with a new password (Cloudlink stores it encrypted),</li>
                <li>allows the API only from Cloudlink&apos;s management addresses and blocks it from everywhere else,</li>
                <li>configures RADIUS for routers that use it, and the captive-portal walled garden for hotspot routers,</li>
                <li>deletes itself afterwards.</li>
              </ul>
              <p className="text-muted-foreground">Cloudlink must still reach the router over its private or VPN address. Generating a new command replaces any earlier one.</p>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            {!result ? (
              <Button loading={pending} onClick={() => mutate(`/routers/${routerId}/setup-command`, { method: "POST" }, { refresh: false, onSuccess: setResult })}>
                Generate command
              </Button>
            ) : null}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
