"use client";

import { Plus } from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";

const METHODS = [
  ["CASH", "Cash"],
  ["BANK_TRANSFER", "Bank transfer"],
  ["MPESA", "M-Pesa"],
  ["CHEQUE", "Cheque"],
  ["CARD", "Card"],
  ["OTHER", "Other"],
] as const;

function today(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export function ExpenseDialog({ currency, categories, branches }: { currency: string; categories: Array<{ id: string; name: string }>; branches: Array<{ id: string; name: string; code: string }> }) {
  return (
    <ActionDialog
      label={
        <>
          <Plus /> Record expense
        </>
      }
      triggerSize="md"
      title="Record expense"
      path="/expenses"
      idempotent
      success="Expense recorded"
      submitLabel="Record expense"
      extraBody={(v) => ({
        categoryId: v.categoryId,
        amount: v.amount,
        method: v.method,
        paidAt: v.paidAt ? new Date(`${v.paidAt}T12:00:00`).toISOString() : "",
        payee: v.payee ?? null,
        reference: v.reference ?? null,
        description: v.description ?? "",
        branchId: v.branchId ?? null,
      })}
    >
      {(errors) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ex-cat" label="Category" error={errors.categoryId} required>
            <Select name="categoryId" defaultValue={categories[0]?.id}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ex-amt" label={`Amount (${currency})`} error={errors.amount} required>
            <Input name="amount" inputMode="decimal" />
          </Field>
          <Field id="ex-method" label="Paid from" error={errors.method}>
            <Select name="method" defaultValue="CASH">
              {METHODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ex-date" label="Date paid" error={errors.paidAt} required>
            <Input name="paidAt" type="date" defaultValue={today()} max={today()} />
          </Field>
          <Field id="ex-desc" label="Description" error={errors.description} required className="sm:col-span-2">
            <Input name="description" maxLength={500} />
          </Field>
          <Field id="ex-payee" label="Payee" error={errors.payee}>
            <Input name="payee" maxLength={120} />
          </Field>
          <Field id="ex-ref" label="Reference" error={errors.reference}>
            <Input name="reference" maxLength={100} />
          </Field>
          {branches.length > 1 ? (
            <Field id="ex-branch" label="Branch" error={errors.branchId}>
              <Select name="branchId" defaultValue="">
                <option value="">Organization-wide</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      )}
    </ActionDialog>
  );
}

export function ReverseExpenseButton({ id }: { id: string }) {
  return <ActionDialog label="Reverse" triggerVariant="ghost" title="Reverse expense" tone="danger" path={`/expenses/${id}/reverse`} reason="required" success="Expense reversed" impact="Posts a reversing ledger entry. The original expense stays on record." />;
}
