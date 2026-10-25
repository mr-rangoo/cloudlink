"use client";

import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMutation } from "@/components/use-mutation";

/** Trigger recurring billing now. Safe to repeat: each subscription period is invoiced at most once. */
export function RunBillingButton() {
  const { mutate, pending } = useMutation<{ created: number; skipped: number }>();
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={async () => {
        const r = await mutate("/billing/run", { method: "POST", body: {} });
        if (r) toast.success(r.created ? `${r.created} invoice(s) generated` : "No invoices were due", { description: "Recurring billing also runs hourly in the background worker." });
      }}
    >
      <RefreshCw /> Run billing
    </Button>
  );
}
