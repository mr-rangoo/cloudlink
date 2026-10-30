"use client";

import * as React from "react";
import { CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export function UseGatewayButton({ provider, name, disabled }: { provider: string; name: string; disabled: boolean }) {
  const { mutate, pending } = useMutation();
  return (
    <Button size="sm" variant="secondary" disabled={disabled} loading={pending} onClick={() => mutate("/integrations/payment-gateways/active", { method: "PUT", body: { provider } }, { success: `${name} now collects online payments` })}>
      <CheckCircle2 /> Use for online payments
    </Button>
  );
}

export function KopoKopoActions({ configured, live, current }: { configured: boolean; live: boolean; current: { environment: string; tillNumber: string } }) {
  const test = useMutation<{ ok: boolean; error: string | null }>();
  return (
    <div className="flex flex-wrap gap-2">
      <KopoKopoDialog configured={configured} current={current} />
      {live && configured ? (
        <Button
          size="sm"
          variant="secondary"
          loading={test.pending}
          onClick={() => test.mutate("/integrations/kopokopo/test", { method: "POST" }, { onSuccess: (r) => (r.ok ? toast.success("Credentials accepted by Kopo Kopo") : toast.error(r.error ?? "Credentials were rejected")) })}
        >
          <ShieldCheck /> Test credentials
        </Button>
      ) : null}
    </div>
  );
}

function KopoKopoDialog({ configured, current }: { configured: boolean; current: { environment: string; tillNumber: string } }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      environment: v.environment,
      tillNumber: v.tillNumber ?? "",
      ...(v.clientId || v.clientSecret || v.apiKey ? { clientId: v.clientId, clientSecret: v.clientSecret, apiKey: v.apiKey } : {}),
    };
    const ok = await mutate("/integrations/kopokopo", { method: "PUT", body }, { success: "Kopo Kopo settings saved" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <KeyRound /> {configured ? "Edit Kopo Kopo" : "Set up Kopo Kopo"}
        </Button>
      </DialogTrigger>
      <DialogContent title="Kopo Kopo settings" description="From your Kopo Kopo account (Applications). Changing the environment, till or credentials resets the verification status." wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate autoComplete="off">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="k2-env" label="Environment" error={errors.environment}>
              <Select name="environment" defaultValue={current.environment}>
                <option value="sandbox">Sandbox (testing)</option>
                <option value="production">Production (real money)</option>
              </Select>
            </Field>
            <Field id="k2-till" label="Till number" hint="Your till, or online payments account (starts with K)" error={errors.tillNumber} required>
              <Input name="tillNumber" defaultValue={current.tillNumber} className="uppercase" />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{configured ? "Leave the three fields below empty to keep the saved credentials." : "All three are required."} They are stored encrypted and never shown again.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="k2-client-id" label="Client ID" error={errors.clientId}>
              <Input name="clientId" autoComplete="off" />
            </Field>
            <Field id="k2-client-secret" label="Client secret" error={errors.clientSecret}>
              <Input name="clientSecret" type="password" autoComplete="new-password" />
            </Field>
            <Field id="k2-api-key" label="API key" hint="Used to check that results really come from Kopo Kopo" error={errors.apiKey}>
              <Input name="apiKey" type="password" autoComplete="new-password" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
