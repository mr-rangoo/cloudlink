"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionDialog } from "@/components/action-dialog";
import { SubscriberPicker, type PickedSubscriber } from "@/components/subscriber-picker";
import { formatMoney } from "@/lib/utils";

interface Props {
  payment: { id: string; currency: string; unallocated: string; matched: boolean; refunded: boolean; receipt: string };
  openInvoices: Array<{ id: string; label: string; balance: string }>;
  can: { allocate: boolean; refund: boolean; reconcile: boolean };
}

export function PaymentActions({ payment, openInvoices, can }: Props) {
  const [matchTo, setMatchTo] = React.useState<PickedSubscriber | null>(null);
  const m = (v: string) => formatMoney(v, payment.currency);
  const hasCredit = Number(payment.unallocated) > 0;
  const actions: React.ReactNode[] = [];

  if (!payment.matched && can.reconcile) {
    actions.push(
      <ActionDialog
        key="match"
        label="Match to subscriber"
        title="Match payment"
        path={`/payments/${payment.id}/reconcile`}
        success="Payment matched"
        impact="Links this receipt to the subscriber and applies it to their oldest open invoices. The match is recorded for the reconciliation report."
        extraBody={() => ({ subscriberId: matchTo?.id ?? "", autoAllocate: true })}
      >
        {(errors) => (
          <Field id="match-sub" label="Subscriber" error={errors.subscriberId} required>
            <SubscriberPicker id="match-sub" value={matchTo} onChange={setMatchTo} />
          </Field>
        )}
      </ActionDialog>,
    );
  }
  if (payment.matched && hasCredit && can.allocate && openInvoices.length) {
    actions.push(
      <ActionDialog
        key="allocate"
        label="Allocate to invoice"
        title="Allocate payment"
        path={`/payments/${payment.id}/allocate`}
        idempotent
        success="Payment allocated"
        impact={<>Unallocated on this payment: {m(payment.unallocated)}.</>}
        extraBody={(v) => ({ allocations: [{ invoiceId: v.invoiceId ?? "", amount: v.amount ?? "" }] })}
      >
        {(errors) => (
          <>
            <Field id="alloc-inv" label="Invoice" error={errors["allocations.0.invoiceId"]} required>
              <Select name="invoiceId" defaultValue={openInvoices[0]?.id}>
                {openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="alloc-amt" label={`Amount (${payment.currency})`} error={errors["allocations.0.amount"]} required>
              <Input name="amount" inputMode="decimal" defaultValue={Math.min(Number(payment.unallocated), Number(openInvoices[0]?.balance ?? 0)).toFixed(2)} />
            </Field>
          </>
        )}
      </ActionDialog>,
    );
  }
  if (payment.matched && hasCredit && can.refund) {
    actions.push(
      <ActionDialog
        key="refund"
        label="Refund"
        title="Refund payment"
        tone="danger"
        path={`/payments/${payment.id}/refunds`}
        reason="required"
        idempotent
        success="Refund recorded"
        impact={<>Up to {m(payment.unallocated)} (the unallocated part) can be refunded. Record the refund only after the money has actually been sent back.</>}
        extraBody={(v) => ({ amount: v.amount, method: v.method, reference: v.reference ?? null })}
      >
        {(errors) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="ref-amt" label={`Amount (${payment.currency})`} error={errors.amount} required>
              <Input name="amount" inputMode="decimal" defaultValue={payment.unallocated} />
            </Field>
            <Field id="ref-method" label="Paid back via" error={errors.method}>
              <Select name="method" defaultValue="MPESA">
                <option value="MPESA">M-Pesa</option>
                <option value="CASH">Cash</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CHEQUE">Cheque</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field id="ref-ref" label="Refund reference" error={errors.reference} className="sm:col-span-2">
              <Input name="reference" maxLength={100} />
            </Field>
          </div>
        )}
      </ActionDialog>,
    );
  }
  if (can.refund && !payment.refunded) {
    actions.push(
      <ActionDialog
        key="reverse"
        label="Reverse payment"
        title="Reverse payment"
        tone="danger"
        path={`/payments/${payment.id}/reverse`}
        reason="required"
        success="Payment reversed"
        impact={<>Use for bounced cheques or entries made in error. All allocations from receipt {payment.receipt} are reversed and the invoices reopen. The receipt stays on record as reversed.</>}
      />,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">{actions.length ? actions : <p className="text-sm text-muted-foreground">No further actions available for your role.</p>}</CardContent>
    </Card>
  );
}

export function ReverseAllocationButton({ paymentId, allocationId, label }: { paymentId: string; allocationId: string; label: string }) {
  return (
    <ActionDialog
      label="Reverse"
      triggerVariant="ghost"
      title="Reverse allocation"
      tone="danger"
      path={`/payments/${paymentId}/allocations/${allocationId}/reverse`}
      reason="required"
      success="Allocation reversed"
      impact={<>Removes {label} from the invoice. The money returns to the subscriber&apos;s account credit, where it can be re-allocated or refunded.</>}
    />
  );
}
