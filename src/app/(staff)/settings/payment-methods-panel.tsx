"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { formValues, useMutation } from "@/components/use-mutation";

export interface MethodRow {
  id: string;
  kind: string;
  label: string;
  details: Record<string, string | null>;
  instructions: string | null;
  active: boolean;
  preview: string[];
}

const KINDS: Array<[string, string]> = [
  ["MPESA_PAYBILL", "M-Pesa Paybill"],
  ["MPESA_TILL", "M-Pesa Till (Buy Goods)"],
  ["BANK", "Bank transfer"],
  ["CASH", "Cash at an office"],
  ["OTHER", "Other"],
];

function MethodDialog({ method, trigger }: { method?: MethodRow; trigger: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState(method?.kind ?? "MPESA_PAYBILL");
  const { mutate, pending, errors, formError } = useMutation();
  const d = method?.details ?? {};
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = { ...v, kind, active: method?.active ?? true };
    const ok = await mutate(method ? `/settings/payment-methods/${method.id}` : "/settings/payment-methods", { method: method ? "PUT" : "POST", body }, { success: method ? "Payment method updated" : "Payment method added" });
    if (ok) setOpen(false);
  };
  const p = method?.id ?? "new";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={method ? "Edit payment method" : "Add a payment method"} description="Customers see this in the portal and on invoices, with their own account number filled in.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id={`pm-kind-${p}`} label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={Boolean(method)}>
              {KINDS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "MPESA_PAYBILL" ? (
            <Field id={`pm-paybill-${p}`} label="Paybill (business) number" error={errors.paybill} required>
              <Input name="paybill" defaultValue={d.paybill ?? ""} inputMode="numeric" />
            </Field>
          ) : null}
          {kind === "MPESA_TILL" ? (
            <Field id={`pm-till-${p}`} label="Till number" error={errors.till} required>
              <Input name="till" defaultValue={d.till ?? ""} inputMode="numeric" />
            </Field>
          ) : null}
          {kind === "BANK" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`pm-bank-${p}`} label="Bank" error={errors.bankName} required>
                <Input name="bankName" defaultValue={d.bankName ?? ""} />
              </Field>
              <Field id={`pm-branch-${p}`} label="Branch" error={errors.branch}>
                <Input name="branch" defaultValue={d.branch ?? ""} />
              </Field>
              <Field id={`pm-aname-${p}`} label="Account name" error={errors.accountName} required>
                <Input name="accountName" defaultValue={d.accountName ?? ""} />
              </Field>
              <Field id={`pm-anum-${p}`} label="Account number" error={errors.accountNumber} required>
                <Input name="accountNumber" defaultValue={d.accountNumber ?? ""} />
              </Field>
              <Field id={`pm-swift-${p}`} label="SWIFT code" error={errors.swiftCode}>
                <Input name="swiftCode" defaultValue={d.swiftCode ?? ""} className="uppercase" />
              </Field>
            </div>
          ) : null}
          {kind === "CASH" ? (
            <Field id={`pm-loc-${p}`} label="Where to pay" hint="Office address and opening hours" error={errors.location} required>
              <Input name="location" defaultValue={d.location ?? ""} />
            </Field>
          ) : null}
          <Field id={`pm-label-${p}`} label={kind === "OTHER" ? "Name" : "Name shown to customers"} hint={kind === "OTHER" ? undefined : "Leave empty for the standard name"} error={errors.label} required={kind === "OTHER"}>
            <Input name="label" defaultValue={method?.label ?? ""} maxLength={60} />
          </Field>
          <Field id={`pm-ins-${p}`} label={kind === "OTHER" ? "How to pay" : "Extra instructions"} error={errors.instructions} required={kind === "OTHER"}>
            <Textarea name="instructions" defaultValue={method?.instructions ?? ""} maxLength={500} rows={3} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {method ? "Save" : "Add method"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PaymentMethodsPanel({ methods, stkMode }: { methods: MethodRow[]; stkMode: "mock" | "daraja" | "disabled" }) {
  const { mutate, pending } = useMutation();
  const move = (index: number, dir: -1 | 1) => {
    const a = methods[index]!;
    const b = methods[index + dir]!;
    void (async () => {
      await mutate(`/settings/payment-methods/${a.id}`, { method: "PATCH", body: { sortOrder: index + dir } }, { refresh: false });
      await mutate(`/settings/payment-methods/${b.id}`, { method: "PATCH", body: { sortOrder: index } });
    })();
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Payment methods</CardTitle>
            <CardDescription>How customers can pay you. Shown in the customer portal and on invoices, with each customer&apos;s account number filled in.</CardDescription>
          </div>
          <MethodDialog
            trigger={
              <Button>
                <Plus /> Add method
              </Button>
            }
          />
        </CardHeader>
        {methods.length === 0 ? (
          <EmptyState title="No payment methods yet" description="Add your M-Pesa paybill or till, bank account or office cash desk." />
        ) : (
          <ul className="divide-y divide-border">
            {methods.map((m, i) => (
              <li key={m.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {m.label} {m.active ? <Badge tone="success">Shown</Badge> : <Badge tone="neutral">Hidden</Badge>}
                  </p>
                  <ul className="text-muted-foreground">
                    {m.preview.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  {m.instructions ? <p className="text-xs text-muted-foreground">{m.instructions}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button size="icon" variant="ghost" aria-label={`Move ${m.label} up`} disabled={i === 0 || pending} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Move ${m.label} down`} disabled={i === methods.length - 1 || pending} onClick={() => move(i, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => mutate(`/settings/payment-methods/${m.id}`, { method: "PATCH", body: { active: !m.active } }, { success: m.active ? "Hidden from customers" : "Shown to customers" })}>
                    {m.active ? "Hide" : "Show"}
                  </Button>
                  <MethodDialog
                    method={m}
                    trigger={
                      <Button size="sm" variant="ghost">
                        <Pencil /> Edit
                      </Button>
                    }
                  />
                  <ActionDialog label={<><Trash2 /> Remove</>} triggerVariant="ghost" tone="danger" title="Remove payment method" description={m.label} path={`/settings/payment-methods/${m.id}`} method="DELETE" success="Payment method removed" impact="Customers will no longer see it. Past payments are not affected." />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          Online payment from the portal (M-Pesa prompt to the customer&apos;s phone) is {stkMode === "daraja" ? "enabled" : stkMode === "mock" ? "in test mode (simulated, no money moves)" : "not enabled"}. Configure it under{" "}
          <Link href="/integrations" className="text-accent hover:underline">
            Integrations → M-Pesa
          </Link>
          .
        </CardContent>
      </Card>
    </div>
  );
}
