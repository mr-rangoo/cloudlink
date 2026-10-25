"use client";

import * as React from "react";
import { KeyRound, Link2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

interface Current {
  environment: string;
  type: string;
  shortcode: string;
  tillNumber: string;
  rejectUnknownAccounts: boolean;
}

export function MpesaActions({ mode, configured, source, current }: { mode: string; configured: boolean; source: string | null; current: Current }) {
  const test = useMutation<{ ok: boolean; error: string | null }>();
  const register = useMutation();
  const live = mode === "daraja";
  return (
    <div className="flex flex-wrap gap-2">
      <ConfigureDialog configured={configured && source === "integration"} current={current} />
      {live && configured ? (
        <Button
          variant="secondary"
          loading={test.pending}
          onClick={() =>
            test.mutate("/integrations/mpesa/test", { method: "POST" }, { onSuccess: (r) => (r.ok ? toast.success("Credentials accepted by M-Pesa") : toast.error(r.error ?? "Credentials were rejected")) })
          }
        >
          <ShieldCheck /> Test credentials
        </Button>
      ) : null}
      {live && configured ? (
        <Button variant="secondary" loading={register.pending} onClick={() => register.mutate("/integrations/mpesa/register-c2b", { method: "POST" }, { success: "C2B URLs registered with M-Pesa" })}>
          <Link2 /> Register C2B URLs
        </Button>
      ) : null}
    </div>
  );
}

function ConfigureDialog({ configured, current }: { configured: boolean; current: Current }) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState(current.type);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      environment: v.environment,
      type: v.type,
      shortcode: v.shortcode ?? "",
      tillNumber: v.type === "TILL" ? (v.tillNumber ?? "") : null,
      rejectUnknownAccounts: v.rejectUnknownAccounts === "on",
      ...(v.consumerKey || v.consumerSecret || v.passkey ? { consumerKey: v.consumerKey, consumerSecret: v.consumerSecret, passkey: v.passkey } : {}),
    };
    const ok = await mutate("/integrations/mpesa", { method: "PUT", body }, { success: "M-Pesa settings saved" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <KeyRound /> {configured ? "Edit settings" : "Configure M-Pesa"}
        </Button>
      </DialogTrigger>
      <DialogContent title="M-Pesa settings" description="From your Safaricom Daraja app. Changing the environment, shortcode or credentials resets the verification status." wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate autoComplete="off">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="mp-env" label="Environment" error={errors.environment}>
              <Select name="environment" defaultValue={current.environment}>
                <option value="sandbox">Sandbox (testing)</option>
                <option value="production">Production (real money)</option>
              </Select>
            </Field>
            <Field id="mp-type" label="Account type" error={errors.type}>
              <Select name="type" defaultValue={current.type} onChange={(e) => setType(e.target.value)}>
                <option value="PAYBILL">Paybill</option>
                <option value="TILL">Till (Buy Goods)</option>
              </Select>
            </Field>
            <Field id="mp-short" label={type === "TILL" ? "Store number (BusinessShortCode)" : "Paybill number"} error={errors.shortcode} required>
              <Input name="shortcode" defaultValue={current.shortcode} inputMode="numeric" />
            </Field>
            {type === "TILL" ? (
              <Field id="mp-till" label="Till number" error={errors.tillNumber} required>
                <Input name="tillNumber" defaultValue={current.tillNumber} inputMode="numeric" />
              </Field>
            ) : null}
          </div>
          <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {configured ? "Leave these empty to keep the saved credentials." : "Required."} They are encrypted and cannot be viewed again.
            </p>
            <Field id="mp-key" label="Consumer key" error={errors.consumerKey} required={!configured}>
              <Input name="consumerKey" autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="mp-secret" label="Consumer secret" error={errors.consumerSecret} required={!configured}>
              <Input name="consumerSecret" type="password" autoComplete="new-password" />
            </Field>
            <Field id="mp-passkey" label="Lipa Na M-Pesa passkey" error={errors.passkey} required={!configured} className="sm:col-span-2">
              <Input name="passkey" type="password" autoComplete="new-password" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="rejectUnknownAccounts" defaultChecked={current.rejectUnknownAccounts} /> Reject direct payments whose account reference is not a known account or invoice (needs external validation enabled by Safaricom)
          </label>
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
