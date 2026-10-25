"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ActionDialog } from "@/components/action-dialog";
import { formatMoney } from "@/lib/utils";

interface Props {
  invoice: { id: string; status: string; number: string | null; currency: string; balanceDue: string; amountPaid: string; amountCredited: string; creditable: string };
  can: { issue: boolean; write: boolean; credit: boolean };
}

export function InvoiceActions({ invoice, can }: Props) {
  const router = useRouter();
  const m = (v: string) => formatMoney(v, invoice.currency);
  const settled = Number(invoice.amountPaid) > 0 || Number(invoice.amountCredited) > 0;
  const actions: React.ReactNode[] = [];

  if (invoice.status === "DRAFT") {
    if (can.issue)
      actions.push(
        <ActionDialog key="issue" label="Issue invoice" title="Issue invoice" path={`/invoices/${invoice.id}/issue`} success="Invoice issued" impact="Assigns the next invoice number, posts the amount to accounts receivable and locks the lines. Issued invoices can only be voided or credited, not edited." />,
      );
    if (can.write)
      actions.push(
        <ActionDialog key="delete" label="Delete draft" title="Delete draft" method="DELETE" tone="danger" path={`/invoices/${invoice.id}`} success="Draft deleted" impact="Drafts have no number and no ledger effect, so they can be deleted." onDone={() => router.push("/invoices")} />,
      );
  }
  if ((invoice.status === "OPEN" || invoice.status === "PARTIALLY_PAID" || invoice.status === "PAID") && can.credit && Number(invoice.creditable) > 0) {
    actions.push(
      <ActionDialog
        key="credit"
        label="Credit note"
        title="Issue credit note"
        path={`/invoices/${invoice.id}/credit-notes`}
        reason="required"
        idempotent
        success="Credit note issued"
        impact={
          <>
            Up to <strong>{m(invoice.creditable)}</strong> can still be credited (amount including tax). The part up to the open balance ({m(invoice.balanceDue)}) reduces this invoice; any remainder becomes account credit for the subscriber.
          </>
        }
        extraBody={(v) => ({ amount: v.amount })}
      >
        {(errors) => (
          <Field id="cn-amount" label={`Amount (${invoice.currency}, incl. tax)`} error={errors.amount} required>
            <Input name="amount" inputMode="decimal" />
          </Field>
        )}
      </ActionDialog>,
    );
  }
  if ((invoice.status === "OPEN" || invoice.status === "PARTIALLY_PAID") && can.issue) {
    actions.push(
      settled ? (
        <p key="void-note" className="text-xs text-muted-foreground">
          To void, first reverse the payments applied to this invoice.
        </p>
      ) : (
        <ActionDialog key="void" label="Void invoice" title="Void invoice" tone="danger" path={`/invoices/${invoice.id}/void`} reason="required" success="Invoice voided" impact="Voiding reverses the ledger posting. The invoice and its number are kept for the audit trail." />
      ),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">{actions.length ? actions : <p className="text-sm text-muted-foreground">No actions available for this invoice.</p>}</CardContent>
    </Card>
  );
}
