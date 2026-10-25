"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { SubscriberPicker, type PickedSubscriber } from "@/components/subscriber-picker";
import { useMutation } from "@/components/use-mutation";
import { api, newIdempotencyKey, rotateOnServerError } from "@/lib/api-client";
import { formatMoney } from "@/lib/utils";

interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  balanceDue: string;
  dueAt: string | null;
}

function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function PaymentForm({ currency, initialSubscriber, focusInvoiceId, canAllocate }: { currency: string; initialSubscriber: PickedSubscriber | null; focusInvoiceId: string | null; canAllocate: boolean }) {
  const router = useRouter();
  const [subscriber, setSubscriber] = React.useState<PickedSubscriber | null>(initialSubscriber);
  const [unidentified, setUnidentified] = React.useState(false);
  const [method, setMethod] = React.useState("CASH");
  const [amount, setAmount] = React.useState("");
  const [invoices, setInvoices] = React.useState<OpenInvoice[]>([]);
  const [mode, setMode] = React.useState<"auto" | "invoice">(focusInvoiceId ? "invoice" : "auto");
  const [invoiceId, setInvoiceId] = React.useState<string>(focusInvoiceId ?? "");
  const [key, setKey] = React.useState(() => newIdempotencyKey("pay"));
  const { mutate, pending, errors, formError } = useMutation<{ payment: { id: string } }>();

  React.useEffect(() => {
    if (!subscriber) return;
    let cancelled = false;
    api<{ data: Array<{ id: string; invoiceNumber: string; balanceDue: string; dueAt: string | null }> }>(`/invoices?subscriberId=${subscriber.id}&status=UNPAID&pageSize=50`)
      .then((r) => {
        if (!cancelled) setInvoices(r.data.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, balanceDue: String(i.balanceDue), dueAt: i.dueAt })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [subscriber]);

  const outstanding = invoices.reduce((a, i) => a + Number(i.balanceDue), 0);
  const visibleInvoices = subscriber ? invoices : [];

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const chosen = visibleInvoices.find((i) => i.id === invoiceId);
    const allocations =
      !unidentified && canAllocate && mode === "invoice" && chosen ? [{ invoiceId: chosen.id, amount: Math.min(Number(amount || 0), Number(chosen.balanceDue)).toFixed(2) }] : undefined;
    const receivedLocal = String(f.get("receivedAt") ?? "");
    const res = await mutate(
      "/payments/manual",
      {
        method: "POST",
        idempotencyKey: key,
        body: {
          subscriberId: unidentified ? null : (subscriber?.id ?? ""),
          amount,
          method,
          receivedAt: receivedLocal ? new Date(receivedLocal).toISOString() : "",
          reference: f.get("reference") || null,
          payerName: f.get("payerName") || null,
          notes: f.get("notes") || null,
          allocations,
          autoAllocate: !unidentified && mode === "auto",
        },
      },
      { success: "Payment recorded", refresh: false, onError: (err) => rotateOnServerError(err, () => setKey(newIdempotencyKey("pay"))) },
    );
    if (res) router.push(`/payments/${res.payment.id}?recorded=1`);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>Payer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!unidentified ? (
            <Field id="pay-sub" label="Subscriber" error={errors.subscriberId} required>
              <SubscriberPicker
                id="pay-sub"
                value={subscriber}
                onChange={(s) => {
                  setSubscriber(s);
                  setInvoices([]);
                  setInvoiceId("");
                }}
                invalid={Boolean(errors.subscriberId)}
              />
            </Field>
          ) : (
            <Field id="pay-payer" label="Payer name (as on the bank statement)" error={errors.payerName}>
              <Input name="payerName" maxLength={120} />
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unidentified} onChange={(e) => setUnidentified(e.target.checked)} />
            Payer not identified yet — hold as an unmatched receipt for reconciliation
          </label>
          {subscriber && !unidentified ? (
            <p className="text-sm text-muted-foreground">
              Outstanding: <span className="tabular font-medium text-foreground">{formatMoney(outstanding.toFixed(2), currency)}</span> across {visibleInvoices.length} open invoice{visibleInvoices.length === 1 ? "" : "s"}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>Check the amount and reference carefully. Corrections are made by reversal, not by editing.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="pay-amount" label={`Amount (${currency})`} error={errors.amount} required>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field id="pay-method" label="Method" error={errors.method} required>
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="MPESA">M-Pesa (manually verified)</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CARD">Card</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field id="pay-ref" label="Reference" error={errors.reference} required={method !== "CASH"} hint={method === "MPESA" ? "M-Pesa transaction code, e.g. SJK3ABC123" : "Bank/cheque reference"}>
            <Input name="reference" maxLength={100} autoCapitalize="characters" />
          </Field>
          <Field id="pay-date" label="Received at" error={errors.receivedAt} required>
            <Input name="receivedAt" type="datetime-local" defaultValue={localNow()} max={localNow()} />
          </Field>
          <Field id="pay-notes" label="Notes" className="sm:col-span-2">
            <Textarea name="notes" rows={2} maxLength={1000} />
          </Field>
        </CardContent>
      </Card>

      {!unidentified && canAllocate ? (
        <Card>
          <CardHeader>
            <CardTitle>Apply to invoices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")} className="mt-0.5" />
              <span>
                Oldest invoices first <span className="block text-xs text-muted-foreground">Any amount left over is kept as account credit and applied to future invoices.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "invoice"} onChange={() => setMode("invoice")} className="mt-0.5" disabled={!visibleInvoices.length} />
              <span>A specific invoice</span>
            </label>
            {mode === "invoice" ? (
              <Field id="pay-inv" label="Invoice" error={errors["allocations.0.invoiceId"]}>
                <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                  <option value="">Select an invoice</option>
                  {visibleInvoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.invoiceNumber} — balance {formatMoney(i.balanceDue, currency)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Record {amount ? formatMoney(amount, currency) : "payment"}
        </Button>
      </div>
    </form>
  );
}
