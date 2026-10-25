"use client";

import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMutation } from "@/components/use-mutation";

export function RunChecksButton() {
  const { mutate, pending } = useMutation<{ ok: boolean }>();
  return (
    <Button
      loading={pending}
      onClick={async () => {
        const r = await mutate("/reconciliation/checks", { method: "POST", body: {} });
        if (r) (r.ok ? toast.success : toast.error)(r.ok ? "Books reconcile" : "Mismatches found — see details");
      }}
    >
      <ShieldCheck /> Run balance checks
    </Button>
  );
}
