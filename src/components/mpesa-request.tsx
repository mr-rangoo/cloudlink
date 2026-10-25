"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Smartphone, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert, Badge, type Tone } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { api, newIdempotencyKey, rotateOnServerError } from "@/lib/api-client";

export interface AttemptView {
  id: string;
  status: string;
  simulated: boolean;
  amount: string;
  currency: string;
  phone: string;
  detail: string | null;
  providerReceipt: string | null;
  paymentId: string | null;
  receiptNumber?: string | null;
}

export const ATTEMPT_LABEL: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Sending", tone: "info" },
  SUBMITTED: { label: "Waiting for the customer", tone: "info" },
  CONFIRMED: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  EXPIRED: { label: "No response", tone: "warning" },
  UNKNOWN: { label: "Needs review", tone: "warning" },
};
const OPEN = new Set(["PENDING", "SUBMITTED"]);

export function AttemptBadge({ status, simulated }: { status: string; simulated?: boolean }) {
  const s = ATTEMPT_LABEL[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={s.tone}>
      {s.label}
      {simulated ? " (simulated)" : ""}
    </Badge>
  );
}

const rank = (a: AttemptView | null) => (!a ? -1 : a.status === "PENDING" ? 0 : a.status === "SUBMITTED" ? 1 : 2);

/**
 * Polls the server for the request's state. The server's record is the only source of truth; between polls the
 * most final state seen (from the last response or the latest action result) is shown.
 */
export function useAttemptStatus(path: string | null, initial: AttemptView | null) {
  const [polled, setPolled] = React.useState<{ path: string; data: AttemptView } | null>(null);
  const current = polled && polled.path === path ? polled.data : null;
  const attempt = rank(initial) > rank(current) ? initial : (current ?? initial);
  React.useEffect(() => {
    if (!path) return;
    let stopped = false;
    let delay = 2500;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await api<{ data: AttemptView }>(path);
        if (stopped) return;
        setPolled({ path, data: res.data });
        if (!OPEN.has(res.data.status)) return;
      } catch {
        // keep polling; transient network errors are expected on mobile
      }
      if (Date.now() - started > 4 * 60_000) return; // the provider's window has passed; the server keeps checking
      delay = Math.min(delay * 1.3, 8000);
      setTimeout(tick, delay);
    };
    const t = setTimeout(tick, delay);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [path]);
  return attempt;
}

export function AttemptProgress({ attempt, receiptHref }: { attempt: AttemptView; receiptHref?: string | null }) {
  const open = OPEN.has(attempt.status);
  const Icon = open ? Loader2 : attempt.status === "CONFIRMED" ? CheckCircle2 : attempt.status === "UNKNOWN" || attempt.status === "EXPIRED" ? Smartphone : XCircle;
  return (
    <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
      <Icon className={`mt-0.5 size-5 shrink-0 ${open ? "animate-spin text-accent motion-reduce:animate-none" : attempt.status === "CONFIRMED" ? "text-success" : "text-muted-foreground"}`} aria-hidden />
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          KES {Number(attempt.amount).toLocaleString("en-KE")} to {attempt.phone} <AttemptBadge status={attempt.status} simulated={attempt.simulated} />
        </p>
        <p className="text-muted-foreground">
          {attempt.status === "SUBMITTED" && !attempt.simulated ? "A prompt was sent to the phone. The customer enters their M-Pesa PIN to complete the payment." : attempt.detail}
        </p>
        {attempt.status === "CONFIRMED" ? (
          <p>
            M-Pesa receipt <span className="font-mono">{attempt.providerReceipt}</span>
            {receiptHref ? (
              <>
                {" · "}
                <Link href={receiptHref} className="text-accent hover:underline">
                  View payment
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Staff: request an M-Pesa payment from a subscriber's phone. */
export function MpesaRequestDialog({
  subscriberId,
  phone,
  suggestedAmount,
  invoices,
  mockMode,
}: {
  subscriberId: string;
  phone: string;
  suggestedAmount: number;
  invoices: Array<{ id: string; label: string; balance: number }>;
  mockMode: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(() => newIdempotencyKey("stk"));
  const [created, setCreated] = React.useState<AttemptView | null>(null);
  const [amount, setAmount] = React.useState(String(suggestedAmount || ""));
  const { mutate, pending, errors, formError } = useMutation<AttemptView>();
  const simulate = useMutation<AttemptView>();
  const attempt = useAttemptStatus(created ? `/payments/attempts/${created.id}` : null, created);
  React.useEffect(() => {
    if (attempt && !OPEN.has(attempt.status)) router.refresh();
  }, [attempt, router]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate(
      "/payments/mpesa/stk-push",
      { method: "POST", idempotencyKey: key, body: { subscriberId, phone: v.phone ?? "", amount: v.amount ?? "", invoiceId: v.invoiceId ?? null } },
      { refresh: false, onError: (err) => rotateOnServerError(err, () => setKey(newIdempotencyKey("stk"))) },
    );
    if (res) setCreated(res);
  };
  const reset = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setCreated(null);
      setKey(newIdempotencyKey("stk"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          <Smartphone /> Request M-Pesa
        </Button>
      </DialogTrigger>
      <DialogContent title="Request an M-Pesa payment" description="The customer gets a prompt on their phone and confirms with their M-Pesa PIN.">
        {attempt ? (
          <div className="space-y-4">
            <AttemptProgress attempt={attempt} receiptHref={attempt.paymentId ? `/payments/${attempt.paymentId}` : null} />
            {mockMode && attempt.simulated && attempt.status === "SUBMITTED" ? (
              <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">Development only: simulate what the customer does. It runs through the same checks as a real M-Pesa callback.</p>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["success", "Customer pays"],
                      ["cancelled", "Customer cancels"],
                      ["insufficient_funds", "Not enough balance"],
                    ] as const
                  ).map(([outcome, label]) => (
                    <Button key={outcome} size="sm" variant={outcome === "success" ? "primary" : "secondary"} loading={simulate.pending} onClick={() => simulate.mutate(`/payments/attempts/${attempt.id}/simulate`, { method: "POST", body: { outcome } }, { refresh: false, onSuccess: (a) => setCreated({ ...a }) })}>
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Link href={`/payments/requests/${attempt.id}`} className="text-sm text-accent hover:underline">
                Open request
              </Link>
              <Button type="button" variant="secondary" onClick={() => reset(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            {mockMode ? <Alert tone="warning">Mock payment adapter: no prompt is sent and no money moves.</Alert> : null}
            <Field id="stk-phone" label="M-Pesa phone number" error={errors.phone} required>
              <Input name="phone" defaultValue={phone} inputMode="tel" autoComplete="off" />
            </Field>
            {invoices.length ? (
              <Field id="stk-invoice" label="Pay towards" error={errors.invoiceId}>
                <Select
                  name="invoiceId"
                  defaultValue=""
                  onChange={(e) => {
                    const inv = invoices.find((i) => i.id === e.target.value);
                    if (inv) setAmount(String(inv.balance));
                  }}
                >
                  <option value="">Account balance (oldest invoices first)</option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field id="stk-amount" label="Amount (KES, whole shillings)" error={errors.amount} required>
              <Input name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => reset(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                Send prompt
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
