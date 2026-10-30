"use client";

import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMutation } from "@/components/use-mutation";

const LABEL: Record<string, string> = { revenue: "Export revenue", receivables_aging: "Export aging", subscribers: "Export subscribers", invoices: "Export invoices", payments: "Export payments", expenses: "Export expenses", audit_logs: "Export audit log" };

/** Queue a CSV export, then go to the Exports tab where it can be downloaded once ready. */
export function ExportButton({ type, params }: { type: string; params?: Record<string, string | undefined> }) {
  const router = useRouter();
  const { mutate, pending } = useMutation();
  const clean = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v));
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={async () => {
        const ok = await mutate("/exports", { method: "POST", body: { type, params: clean } }, { success: "Export queued — it will appear in the Exports tab", refresh: false });
        if (ok) router.push("/reports?tab=exports");
      }}
    >
      <Download /> {LABEL[type] ?? "Export"}
    </Button>
  );
}
