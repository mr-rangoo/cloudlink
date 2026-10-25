"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMutation } from "@/components/use-mutation";

export function RequestActions({ id, status, canSimulate }: { id: string; status: string; canSimulate: boolean }) {
  const router = useRouter();
  const check = useMutation();
  const simulate = useMutation();
  if (status !== "SUBMITTED") return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        loading={check.pending}
        onClick={async () => {
          const ok = await check.mutate(`/payments/attempts/${id}/query`, { method: "POST" }, { success: "Status check queued" });
          if (ok) setTimeout(() => router.refresh(), 3000);
        }}
      >
        <RefreshCw /> Check with M-Pesa
      </Button>
      {canSimulate
        ? (
            [
              ["success", "Simulate: customer pays"],
              ["cancelled", "Simulate: customer cancels"],
            ] as const
          ).map(([outcome, label]) => (
            <Button key={outcome} variant={outcome === "success" ? "primary" : "secondary"} loading={simulate.pending} onClick={() => simulate.mutate(`/payments/attempts/${id}/simulate`, { method: "POST", body: { outcome } }, { success: "Simulated response processed" })}>
              {label}
            </Button>
          ))
        : null}
    </div>
  );
}
