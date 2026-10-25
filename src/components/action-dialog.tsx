"use client";

import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { newIdempotencyKey, rotateOnServerError } from "@/lib/api-client";

/**
 * Confirmation dialog for a server action with an optional/required reason and extra fields.
 * Shows the impact text before submission; the server response is the only source of truth.
 */
export function ActionDialog({
  label,
  title,
  description,
  impact,
  path,
  method = "POST",
  reason,
  submitLabel,
  tone = "primary",
  triggerVariant,
  triggerSize = "sm",
  idempotent,
  success,
  extraBody,
  children,
  onDone,
}: {
  label: React.ReactNode;
  title: string;
  description?: string;
  impact?: React.ReactNode;
  path: string;
  method?: string;
  reason?: "required" | "optional";
  submitLabel?: string;
  tone?: "primary" | "danger";
  triggerVariant?: ButtonProps["variant"];
  triggerSize?: ButtonProps["size"];
  idempotent?: boolean;
  success: string;
  extraBody?: (values: Record<string, string | undefined>) => Record<string, unknown>;
  children?: (errors: Record<string, string>) => React.ReactNode;
  onDone?: (data: unknown) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(() => newIdempotencyKey("act"));
  const { mutate, pending, errors, formError } = useMutation();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = { ...(reason ? { reason: v.reason } : {}), ...(extraBody?.(v) ?? {}) };
    const data = await mutate(path, { method, body, idempotencyKey: idempotent ? key : undefined }, { success, onError: (err) => rotateOnServerError(err, () => setKey(newIdempotencyKey("act"))) });
    if (data !== undefined) {
      setOpen(false);
      onDone?.(data);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setKey(newIdempotencyKey("act"));
      }}
    >
      <DialogTrigger asChild>
        <Button size={triggerSize} variant={triggerVariant ?? (tone === "danger" ? "secondary" : "primary")}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={description}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {impact ? <div className="rounded-md border border-border bg-surface-muted/60 p-3 text-sm">{impact}</div> : null}
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          {children?.(errors)}
          {reason ? (
            <Field id={`reason-${path}`} label={reason === "required" ? "Reason" : "Reason (optional)"} error={errors.reason} required={reason === "required"}>
              <Textarea name="reason" rows={2} maxLength={500} />
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={pending}>
              {submitLabel ?? title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
