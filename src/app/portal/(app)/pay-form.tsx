"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { AttemptProgress, useAttemptStatus, type AttemptView } from "@/components/mpesa-request";

const newRequestId = () => crypto.randomUUID();

/**
 * Customer portal: pay with M-Pesa. The page shows only what the server reports for the request; the balance
 * changes only after M-Pesa confirms the payment to Cloudlink.
 */
export function PortalPayForm({ phone, amount, invoiceId, simulated, closed }: { phone: string; amount: number; invoiceId?: string; simulated: boolean; closed?: boolean }) {
  const router = useRouter();
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [created, setCreated] = React.useState<AttemptView | null>(null);
  const { mutate, pending, errors, formError } = useMutation<AttemptView>();
  const attempt = useAttemptStatus(created ? `/customer/payments/attempts/${created.id}` : null, created);
  const done = attempt && !["PENDING", "SUBMITTED"].includes(attempt.status);
  React.useEffect(() => {
    if (attempt?.status === "CONFIRMED") router.refresh();
  }, [attempt?.status, router]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate("/customer/payments", { method: "POST", body: { phone: v.phone ?? "", amount: v.amount ?? "", invoiceId: invoiceId ?? null, requestId } }, { refresh: false });
    if (res) setCreated(res);
  };

  if (attempt) {
    return (
      <div className="space-y-3">
        <AttemptProgress attempt={attempt} />
        {attempt.status === "SUBMITTED" && attempt.simulated ? <p className="text-xs text-muted-foreground">Test mode: no prompt is sent. Your provider can complete this test request.</p> : null}
        {done ? (
          <Button
            variant="secondary"
            onClick={() => {
              setCreated(null);
              setRequestId(newRequestId());
            }}
          >
            {attempt.status === "CONFIRMED" ? "Make another payment" : "Try again"}
          </Button>
        ) : null}
      </div>
    );
  }

  if (closed) return <p className="text-sm text-muted-foreground">Nothing left to pay on this invoice.</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      {simulated ? <Alert tone="warning">Test mode: payments here are simulated and no money moves.</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`pay-phone-${invoiceId ?? "acct"}`} label="M-Pesa number" error={errors.phone} required>
          <Input name="phone" defaultValue={phone} inputMode="tel" autoComplete="tel" />
        </Field>
        <Field id={`pay-amount-${invoiceId ?? "acct"}`} label="Amount (KES)" error={errors.amount} required>
          <Input name="amount" defaultValue={amount > 0 ? String(amount) : ""} inputMode="numeric" />
        </Field>
      </div>
      <Button type="submit" loading={pending}>
        <Smartphone /> Pay with M-Pesa
      </Button>
      <p className="text-xs text-muted-foreground">You will get a prompt on your phone. Enter your M-Pesa PIN to complete the payment.</p>
    </form>
  );
}
