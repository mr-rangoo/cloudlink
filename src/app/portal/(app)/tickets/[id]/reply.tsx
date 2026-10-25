"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";
import { formValues, useMutation } from "@/components/use-mutation";

export function CustomerReply({ ticketId, reopens }: { ticketId: string; reopens: boolean }) {
  const ref = React.useRef<HTMLFormElement>(null);
  const { mutate, pending, errors } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/customer/tickets/${ticketId}/comments`, { method: "POST", body: { body: v.body ?? "" } }, { success: "Reply sent" });
    if (ok) ref.current?.reset();
  };
  return (
    <form ref={ref} onSubmit={onSubmit} className="space-y-2 border-t border-border pt-3" noValidate>
      <Field id="reply" label="Your reply" error={errors.body} hint={reopens ? "Replying reopens this request." : undefined}>
        <Textarea name="body" rows={3} maxLength={5000} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Send reply
        </Button>
      </div>
    </form>
  );
}
