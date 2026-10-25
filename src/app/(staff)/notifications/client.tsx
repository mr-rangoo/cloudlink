"use client";

import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export function RetryButton({ id }: { id: string }) {
  const { mutate, pending } = useMutation();
  return (
    <Button size="sm" variant="ghost" loading={pending} onClick={() => mutate(`/notifications/${id}/retry`, { method: "POST", body: {} }, { success: "Queued for retry" })}>
      Retry
    </Button>
  );
}

export function TemplateDialog({ template }: { template: { key: string; channel: "SMS" | "EMAIL"; subject: string | null; body: string; active: boolean; variables: string[] } }) {
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState(template.body);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate("/notifications/templates", { method: "PUT", body: { key: template.key, channel: template.channel, subject: v.subject ?? null, body, active: v.active === "on" } }, { success: "Template saved" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Edit ${template.key} ${template.channel}`}>
          <Pencil /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent title={`${template.key} · ${template.channel}`} description={`Variables: ${template.variables.map((v) => `{{${v}}}`).join(" ")}`} wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          {template.channel === "EMAIL" ? (
            <Field id="tpl-subject" label="Subject" error={errors.subject}>
              <Input name="subject" defaultValue={template.subject ?? ""} maxLength={200} />
            </Field>
          ) : null}
          <Field id="tpl-body" label="Message" error={errors.body} hint={template.channel === "SMS" ? `${body.length}/480 characters (about ${Math.ceil(body.length / 160)} SMS before variables)` : undefined}>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={template.channel === "SMS" ? 4 : 8} maxLength={1600} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="active" defaultChecked={template.active} /> Active (untick to stop sending this message)
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
