"use client";

import { ArrowUpRight } from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";

function today(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export function WithdrawalDialog({ currency, branches }: { currency: string; branches: Array<{ id: string; name: string; code: string }> }) {
  return (
    <ActionDialog
      label={
        <>
          <ArrowUpRight /> Record withdrawal
        </>
      }
      triggerSize="md"
      triggerVariant="secondary"
      title="Record withdrawal or deposit"
      path="/withdrawals"
      idempotent
      success="Recorded"
      submitLabel="Record"
      impact="Owner drawings take money out of the business. Bank deposits move cash or M-Pesa float into the bank. The amount cannot exceed the ledger balance of the source account."
      extraBody={(v) => ({
        kind: v.kind,
        fromMethod: v.fromMethod,
        amount: v.amount,
        occurredAt: v.occurredAt ? new Date(`${v.occurredAt}T12:00:00`).toISOString() : "",
        reference: v.reference ?? null,
        description: v.description ?? "",
        branchId: v.branchId ?? null,
      })}
    >
      {(errors) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="w-kind" label="Type" error={errors.kind}>
            <Select name="kind" defaultValue="BANK_DEPOSIT">
              <option value="BANK_DEPOSIT">Bank deposit</option>
              <option value="OWNER_DRAWING">Owner drawing</option>
            </Select>
          </Field>
          <Field id="w-from" label="From" error={errors.fromMethod}>
            <Select name="fromMethod" defaultValue="CASH">
              <option value="CASH">Cash on hand</option>
              <option value="MPESA">M-Pesa</option>
              <option value="BANK_TRANSFER">Bank</option>
            </Select>
          </Field>
          <Field id="w-amt" label={`Amount (${currency})`} error={errors.amount} required>
            <Input name="amount" inputMode="decimal" />
          </Field>
          <Field id="w-date" label="Date" error={errors.occurredAt} required>
            <Input name="occurredAt" type="date" defaultValue={today()} max={today()} />
          </Field>
          <Field id="w-desc" label="Description" error={errors.description} required className="sm:col-span-2">
            <Input name="description" maxLength={500} />
          </Field>
          <Field id="w-ref" label="Reference" error={errors.reference}>
            <Input name="reference" maxLength={100} />
          </Field>
          {branches.length > 1 ? (
            <Field id="w-branch" label="Branch" error={errors.branchId}>
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
