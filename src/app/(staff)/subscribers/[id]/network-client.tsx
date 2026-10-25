"use client";

import * as React from "react";
import Link from "next/link";
import { Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { formValues, useMutation } from "@/components/use-mutation";

interface Props {
  subscriptionId: string;
  packageName: string;
  provisioned: boolean;
  username: string | null;
  currentRouterId: string | null;
  routers: Array<{ id: string; label: string }>;
}

export function NetworkActions(props: Props) {
  const { subscriptionId, packageName, provisioned, currentRouterId } = props;
  return (
    <div className="flex flex-wrap gap-2">
      <ProvisionDialog {...props} />
      {provisioned ? <RevealCredentials subscriptionId={subscriptionId} /> : null}
      {provisioned && currentRouterId ? (
        <ActionDialog
          label="Re-sync"
          triggerVariant="ghost"
          title="Re-apply network access"
          description={packageName}
          path={`/routers/${currentRouterId}/operations`}
          success="Re-sync queued"
          impact="Queues an operation that sets the router (or RADIUS) to match the current billing status. The real result appears in the operation log."
          extraBody={() => ({ type: "pppoe.sync", subscriptionId })}
        />
      ) : null}
      {provisioned ? (
        <ActionDialog
          label="Remove access"
          triggerVariant="ghost"
          tone="danger"
          title="Remove network access"
          description={packageName}
          path={`/subscriptions/${subscriptionId}/network/deprovision`}
          reason="required"
          success="Removal queued"
          impact="The PPPoE account is removed from the router (or RADIUS) and the stored password is deleted. Billing is not changed."
        />
      ) : null}
    </div>
  );
}

function ProvisionDialog({ subscriptionId, packageName, provisioned, username, currentRouterId, routers }: Props) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  if (routers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No PPPoE router is registered.{" "}
        <Link href="/routers" className="text-accent hover:underline">
          Add a router
        </Link>{" "}
        to provision access.
      </p>
    );
  }
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(
      `/subscriptions/${subscriptionId}/network`,
      { method: "POST", body: { routerId: v.routerId, username: v.username, regeneratePassword: v.regeneratePassword === "on" } },
      { success: "Provisioning queued" },
    );
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={provisioned ? "secondary" : "primary"}>
          {provisioned ? "Change router or username" : "Provision PPPoE"}
        </Button>
      </DialogTrigger>
      <DialogContent title={provisioned ? "Change PPPoE access" : "Provision PPPoE access"} description={packageName}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id={`np-router-${subscriptionId}`} label="Router" error={errors.routerId} required>
            <Select name="routerId" defaultValue={currentRouterId ?? routers[0]?.id}>
              {routers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`np-user-${subscriptionId}`} label="PPPoE username" hint="Leave empty to use the account number." error={errors.username}>
            <Input name="username" defaultValue={username ?? ""} autoComplete="off" spellCheck={false} />
          </Field>
          {provisioned ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="regeneratePassword" /> Generate a new password
            </label>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A password is generated and stored encrypted. Access follows the billing status: enabled while the subscription is active, disabled otherwise. The change runs in the background and its real result is recorded.
            {provisioned ? " Moving to another router or username removes the old account." : ""}
          </p>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {provisioned ? "Apply change" : "Provision"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevealCredentials({ subscriptionId }: { subscriptionId: string }) {
  const [open, setOpen] = React.useState(false);
  const [creds, setCreds] = React.useState<{ username: string; password: string } | null>(null);
  const { mutate, pending, formError } = useMutation<{ username: string; password: string }>();
  const reveal = () => mutate(`/subscriptions/${subscriptionId}/network/credentials`, { method: "POST" }, { refresh: false, onSuccess: setCreds });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed. Select the text instead.");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setCreds(null); // never keep the password in memory after closing
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <KeyRound /> Show credentials
        </Button>
      </DialogTrigger>
      <DialogContent title="PPPoE credentials" description="Revealing the password is recorded in the audit log.">
        <div className="space-y-4">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          {creds ? (
            <dl className="space-y-2 text-sm">
              {(
                [
                  ["Username", creds.username],
                  ["Password", creds.password],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="font-mono">{value}</dd>
                  </div>
                  <Button size="icon" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copy(value)}>
                    <Copy />
                  </Button>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Use these to configure the customer&apos;s router or ONT. Do not send them over unencrypted channels.</p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            {!creds ? (
              <Button type="button" loading={pending} onClick={reveal}>
                Reveal
              </Button>
            ) : null}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
