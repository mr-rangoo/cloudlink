import type { PaymentInstructions } from "@/server/services/payment-methods";

/** The organization's payment methods, personalised for this customer. */
export function PaymentMethodsList({ methods, accountNumber }: { methods: PaymentInstructions[]; accountNumber: string }) {
  if (!methods.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Pay by M-Pesa or bank transfer using your account number <span className="font-mono font-semibold text-foreground">{accountNumber}</span> as the reference. Payments appear here once your provider confirms them.
      </p>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {methods.map((m) => (
        <li key={m.id} className="rounded-md border border-border p-3 text-sm">
          <p className="font-medium">{m.label}</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {m.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {m.note ? <p className="mt-1.5 text-xs text-muted-foreground">{m.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}
