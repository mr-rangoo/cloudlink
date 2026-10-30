"use client";

import { MessageSquare } from "lucide-react";
import { Field, Input } from "@/components/ui/form";
import { ActionDialog } from "@/components/action-dialog";

/** Text one unused voucher's code to a customer's phone (audited; the code is not kept in the message log). */
export function SendVoucherDialog({ voucherId, hint }: { voucherId: string; hint: string }) {
  return (
    <ActionDialog
      label={
        <>
          <MessageSquare /> Send by SMS
        </>
      }
      triggerVariant="ghost"
      title="Send voucher by SMS"
      description={`Code ending …${hint}`}
      impact="The full code is sent to this number. The message log keeps only a note that a code was sent, and the action is audited."
      path={`/vouchers/${voucherId}/send`}
      submitLabel="Send"
      success="Voucher SMS queued"
      extraBody={(v) => ({ phone: v.phone ?? "" })}
    >
      {(errors) => (
        <Field id={`voucher-phone-${voucherId}`} label="Customer phone" error={errors.phone} required>
          <Input name="phone" type="tel" placeholder="0712 345 678" />
        </Field>
      )}
    </ActionDialog>
  );
}
