"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

interface Initial {
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  billing: {
    legalName: string;
    address: string;
    phone: string;
    email: string;
    taxPin: string;
    taxLabel: string;
    invoicePrefix: string;
    receiptPrefix: string;
    creditNotePrefix: string;
    invoiceLeadDays: number;
    expiryReminderDays: number;
    paymentTermsDays: number;
    invoiceOnActivation: boolean;
    invoiceFooter: string;
  };
}

export function SettingsForm({ initial, timezones }: { initial: Initial; timezones: string[] }) {
  const { mutate, pending, errors, formError } = useMutation();
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const n = (x: string | undefined) => x ?? null;
    const ok = await mutate(
      "/settings",
      {
        method: "PATCH",
        body: {
          name: v.name,
          timezone: v.timezone,
          billing: {
            legalName: n(v.legalName),
            address: n(v.address),
            phone: n(v.phone),
            email: n(v.email),
            taxPin: n(v.taxPin),
            taxLabel: v.taxLabel,
            invoicePrefix: v.invoicePrefix,
            receiptPrefix: v.receiptPrefix,
            creditNotePrefix: v.creditNotePrefix,
            invoiceLeadDays: v.invoiceLeadDays,
            expiryReminderDays: v.expiryReminderDays,
            paymentTermsDays: v.paymentTermsDays,
            invoiceOnActivation: v.invoiceOnActivation === "on",
            invoiceFooter: n(v.invoiceFooter),
          },
        },
      },
      { success: "Settings saved" },
    );
    if (ok) setDirty(false);
  };
  const b = initial.billing;
  const err = (k: string) => errors[k] ?? errors[`billing.${k}`];

  return (
    <form onSubmit={onSubmit} onChange={() => setDirty(true)} className="space-y-5" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            Portal provider code: <span className="font-mono">{initial.slug}</span> · Currency {initial.currency} (fixed once invoices exist)
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="o-name" label="Display name" error={err("name")} required>
            <Input name="name" defaultValue={initial.name} />
          </Field>
          <Field id="o-tz" label="Business timezone" hint="Used for billing periods, due dates and reports" error={err("timezone")}>
            <Select name="timezone" defaultValue={initial.timezone}>
              {timezones.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Invoice details</CardTitle>
          <CardDescription>Printed on invoices and receipts</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="b-legal" label="Legal name" error={err("legalName")}>
            <Input name="legalName" defaultValue={b.legalName} />
          </Field>
          <Field id="b-pin" label="Tax PIN (e.g. KRA PIN)" error={err("taxPin")}>
            <Input name="taxPin" defaultValue={b.taxPin} />
          </Field>
          <Field id="b-addr" label="Address" error={err("address")} className="sm:col-span-2">
            <Input name="address" defaultValue={b.address} />
          </Field>
          <Field id="b-phone" label="Phone" error={err("phone")}>
            <Input name="phone" defaultValue={b.phone} />
          </Field>
          <Field id="b-email" label="Billing email" error={err("email")}>
            <Input name="email" type="email" defaultValue={b.email} />
          </Field>
          <Field id="b-taxlabel" label="Tax label" error={err("taxLabel")}>
            <Input name="taxLabel" defaultValue={b.taxLabel} />
          </Field>
          <Field id="b-footer" label="Invoice footer" error={err("invoiceFooter")}>
            <Input name="invoiceFooter" defaultValue={b.invoiceFooter} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Billing rules</CardTitle>
          <CardDescription>Number prefixes apply to newly issued documents; existing numbers never change.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field id="b-ip" label="Invoice prefix" error={err("invoicePrefix")}>
            <Input name="invoicePrefix" defaultValue={b.invoicePrefix} className="uppercase" />
          </Field>
          <Field id="b-rp" label="Receipt prefix" error={err("receiptPrefix")}>
            <Input name="receiptPrefix" defaultValue={b.receiptPrefix} className="uppercase" />
          </Field>
          <Field id="b-cp" label="Credit note prefix" error={err("creditNotePrefix")}>
            <Input name="creditNotePrefix" defaultValue={b.creditNotePrefix} className="uppercase" />
          </Field>
          <Field id="b-lead" label="Invoice lead time (days)" hint="Next-period invoice is issued this many days before renewal" error={err("invoiceLeadDays")}>
            <Input name="invoiceLeadDays" type="number" min={0} max={60} defaultValue={b.invoiceLeadDays} />
          </Field>
          <Field id="b-remind" label="Expiry reminder (days before)" hint="SMS/email reminder for plans of a week or longer. 0 turns reminders off." error={err("expiryReminderDays")}>
            <Input name="expiryReminderDays" type="number" min={0} max={30} defaultValue={b.expiryReminderDays} />
          </Field>
          <Field id="b-terms" label="Payment terms (days)" error={err("paymentTermsDays")}>
            <Input name="paymentTermsDays" type="number" min={0} max={120} defaultValue={b.paymentTermsDays} />
          </Field>
          <label className="flex items-start gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="invoiceOnActivation" defaultChecked={b.invoiceOnActivation} className="mt-0.5" />
            Invoice the first period when a subscription is activated
          </label>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
