"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { SubscriberPicker, type PickedSubscriber } from "@/components/subscriber-picker";
import { useMutation } from "@/components/use-mutation";
import { computeLine, computeTotals } from "@/server/domain/invoice-math";
import { formatMoney } from "@/lib/utils";

interface Line {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRate: string;
}

const blank = (key: number): Line => ({ key, description: "", quantity: "1", unitPrice: "", discount: "", taxRate: "0" });

/** Preview uses the same decimal math as the server; the server recomputes and is authoritative. */
function preview(lines: Line[]) {
  try {
    const computed = lines.map((l) => computeLine({ description: l.description || "-", quantity: l.quantity || "0", unitPrice: l.unitPrice || "0", discount: l.discount || "0", taxRate: l.taxRate || "0" }));
    return { lines: computed, totals: computeTotals(computed), error: null };
  } catch (err) {
    return { lines: null, totals: null, error: err instanceof Error ? err.message : "Invalid line" };
  }
}

export function InvoiceForm({ currency, canIssue, initialSubscriber }: { currency: string; canIssue: boolean; initialSubscriber: PickedSubscriber | null }) {
  const router = useRouter();
  const [subscriber, setSubscriber] = React.useState<PickedSubscriber | null>(initialSubscriber);
  const [lines, setLines] = React.useState<Line[]>([blank(1)]);
  const [notes, setNotes] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const { mutate, pending, errors, formError } = useMutation<{ id: string }>();
  const p = preview(lines);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (issue: boolean) => {
    const res = await mutate(
      "/invoices",
      {
        method: "POST",
        body: {
          subscriberId: subscriber?.id ?? "",
          issue,
          notes: notes || undefined,
          dueAt: dueAt || undefined,
          lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount || undefined, taxRate: l.taxRate || undefined })),
        },
      },
      { success: issue ? "Invoice issued" : "Draft saved", refresh: false },
    );
    if (res) router.push(`/invoices/${res.id}`);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(canIssue);
      }}
      className="space-y-5"
      noValidate
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <Field id="inv-sub" label="Subscriber" error={errors.subscriberId} required>
            <SubscriberPicker id="inv-sub" value={subscriber} onChange={setSubscriber} invalid={Boolean(errors.subscriberId)} />
          </Field>
          <Field id="inv-due" label="Due date" hint="Defaults to the organization payment terms" error={errors.dueAt}>
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((l, i) => (
            <fieldset key={l.key} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-12 sm:items-end">
              <legend className="sr-only">Line {i + 1}</legend>
              <Field id={`d-${l.key}`} label="Description" className="sm:col-span-5" error={errors[`lines.${i}.description`]}>
                <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} maxLength={300} />
              </Field>
              <Field id={`q-${l.key}`} label="Qty" className="sm:col-span-1" error={errors[`lines.${i}.quantity`]}>
                <Input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
              </Field>
              <Field id={`p-${l.key}`} label="Unit price" className="sm:col-span-2" error={errors[`lines.${i}.unitPrice`]}>
                <Input inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
              </Field>
              <Field id={`x-${l.key}`} label="Discount" className="sm:col-span-2" error={errors[`lines.${i}.discount`]}>
                <Input inputMode="decimal" value={l.discount} onChange={(e) => update(l.key, { discount: e.target.value })} />
              </Field>
              <Field id={`t-${l.key}`} label="Tax %" className="sm:col-span-1" error={errors[`lines.${i}.taxRate`]}>
                <Input inputMode="decimal" value={l.taxRate} onChange={(e) => update(l.key, { taxRate: e.target.value })} />
              </Field>
              <div className="flex justify-end sm:col-span-1">
                <Button type="button" variant="ghost" size="icon" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                  <Trash2 />
                </Button>
              </div>
              {p.lines?.[i] ? <p className="text-right text-xs text-muted-foreground sm:col-span-12">Line total {formatMoney(p.lines[i]!.lineTotal.toFixed(2), currency)}</p> : null}
            </fieldset>
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(Math.max(...ls.map((x) => x.key)) + 1)])} disabled={lines.length >= 50}>
            <Plus /> Add line
          </Button>
          <div className="ml-auto max-w-xs space-y-1 pt-2 text-sm">
            {p.totals ? (
              <>
                <Row label="Subtotal" value={formatMoney(p.totals.subtotal.toFixed(2), currency)} />
                <Row label="Discount" value={`-${formatMoney(p.totals.discountTotal.toFixed(2), currency)}`} />
                <Row label="Tax" value={formatMoney(p.totals.taxTotal.toFixed(2), currency)} />
                <Row label="Total" value={formatMoney(p.totals.total.toFixed(2), currency)} strong />
              </>
            ) : (
              <p className="text-danger" role="status">
                {p.error}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <Field id="inv-notes" label="Notes shown on the invoice">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => submit(false)} loading={pending}>
          Save as draft
        </Button>
        {canIssue ? (
          <Button type="submit" loading={pending}>
            Issue invoice
          </Button>
        ) : (
          <p className="self-center text-xs text-muted-foreground">Issuing requires the invoices.issue permission.</p>
        )}
      </div>
    </form>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "border-t border-border pt-1 font-semibold" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="tabular text-foreground">{value}</span>
    </div>
  );
}
