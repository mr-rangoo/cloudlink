"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { ActionDialog } from "@/components/action-dialog";
import { useMutation } from "@/components/use-mutation";

/** Queue a session sync; the worker reads the routers, so re-read the page shortly after. */
export function RefreshSessionsButton() {
  const router = useRouter();
  const { mutate, pending } = useMutation();
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={async () => {
        const ok = await mutate("/network/sessions", { method: "POST" }, { success: "Session sync queued" });
        if (ok) setTimeout(() => router.refresh(), 3000);
      }}
    >
      <RefreshCw /> Refresh from routers
    </Button>
  );
}

export function ResolveAlertButton({ alertId, message }: { alertId: string; message: string }) {
  return (
    <ActionDialog
      label="Resolve"
      triggerVariant="ghost"
      title="Resolve alert"
      description={message}
      path={`/network/alerts/${alertId}/resolve`}
      success="Alert resolved"
      impact="Resolving records that the problem was handled. A new alert is raised if it happens again."
      extraBody={(v) => ({ note: v.note })}
    >
      {(errors) => (
        <Field id={`ra-note-${alertId}`} label="Note (optional)" error={errors.note}>
          <Input name="note" />
        </Field>
      )}
    </ActionDialog>
  );
}

export function OperationActions({ id, status, label }: { id: string; status: string; label: string }) {
  return (
    <span className="flex flex-wrap gap-2">
      {status === "FAILED" ? <RetryButton id={id} /> : null}
      {status === "QUEUED" || status === "RETRYING" ? (
        <ActionDialog
          label="Cancel"
          triggerVariant="ghost"
          triggerSize="md"
          tone="danger"
          title="Cancel operation"
          description={label}
          path={`/network/operations/${id}/cancel`}
          reason="required"
          success="Operation cancelled"
          impact="The operation will not run. The subscription's network status is marked as needing attention until a new operation succeeds."
        />
      ) : null}
    </span>
  );
}

function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const { mutate, pending } = useMutation();
  return (
    <Button
      loading={pending}
      onClick={async () => {
        const ok = await mutate(`/network/operations/${id}/retry`, { method: "POST" }, { success: "Retry queued" });
        if (ok) setTimeout(() => router.refresh(), 3000);
      }}
    >
      <RotateCcw /> Retry
    </Button>
  );
}
