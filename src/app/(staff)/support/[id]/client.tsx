"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export function ReplyForm({ ticketId, hasSubscriber }: { ticketId: string; hasSubscriber: boolean }) {
  const ref = React.useRef<HTMLFormElement>(null);
  const [internal, setInternal] = React.useState(!hasSubscriber);
  const { mutate, pending, errors } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/support/tickets/${ticketId}/comments`, { method: "POST", body: { body: v.body ?? "", internal } }, { success: internal ? "Internal note added" : "Reply sent" });
    if (ok) ref.current?.reset();
  };
  return (
    <form ref={ref} onSubmit={onSubmit} className="space-y-2 border-t border-border pt-4" noValidate>
      <Field id="reply-body" label={internal ? "Internal note (staff only)" : "Reply to customer"} error={errors.body}>
        <Textarea name="body" rows={3} maxLength={5000} className={internal ? "border-warning/50" : undefined} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} disabled={!hasSubscriber} />
          Internal note {hasSubscriber ? "" : "(no subscriber linked)"}
        </label>
        <Button type="submit" loading={pending} variant={internal ? "secondary" : "primary"}>
          {internal ? "Add note" : "Send reply"}
        </Button>
      </div>
      {!internal && hasSubscriber ? <p className="text-xs text-muted-foreground">The customer sees this reply in the portal and is notified by SMS/email according to their preferences.</p> : null}
    </form>
  );
}

export function TicketUpdateForm({ ticketId, status, priority, assigneeId, staff }: { ticketId: string; status: string; priority: string; assigneeId: string | null; staff: Array<{ id: string; name: string }> }) {
  const [next, setNext] = React.useState(status);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    await mutate(`/support/tickets/${ticketId}`, { method: "PATCH", body: { status: v.status, priority: v.priority, assigneeId: v.assigneeId ?? null, ...(v.status === "RESOLVED" ? { resolution: v.resolution } : {}) } }, { success: "Ticket updated" });
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3 border-t border-border pt-3" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Field id="u-status" label="Status">
        <Select name="status" value={next} onChange={(e) => setNext(e.target.value)}>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="WAITING_ON_CUSTOMER">Waiting on customer</option>
          <option value="RESOLVED">Resolved</option>
          <option value="CLOSED">Closed</option>
        </Select>
      </Field>
      {next === "RESOLVED" && status !== "RESOLVED" ? (
        <Field id="u-res" label="Resolution" error={errors.resolution} required>
          <Input name="resolution" maxLength={2000} />
        </Field>
      ) : null}
      <Field id="u-pri" label="Priority">
        <Select name="priority" defaultValue={priority}>
          <option value="LOW">Low</option>
          <option value="NORMAL">Normal</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </Select>
      </Field>
      <Field id="u-assign" label="Assignee">
        <Select name="assigneeId" defaultValue={assigneeId ?? ""}>
          <option value="">Unassigned</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" loading={pending} className="w-full">
        Update ticket
      </Button>
    </form>
  );
}
