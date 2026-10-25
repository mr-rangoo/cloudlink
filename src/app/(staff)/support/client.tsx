"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { SubscriberPicker, type PickedSubscriber } from "@/components/subscriber-picker";
import { formValues, useMutation } from "@/components/use-mutation";

export const CATEGORIES = [
  ["CONNECTIVITY", "Connectivity"],
  ["BILLING", "Billing"],
  ["INSTALLATION", "Installation"],
  ["EQUIPMENT", "Equipment"],
  ["ACCOUNT", "Account"],
  ["OTHER", "Other"],
] as const;

export function NewTicketDialog({ staff, currentUserId, presetSubscriber }: { staff: Array<{ id: string; name: string }>; currentUserId: string; presetSubscriber?: PickedSubscriber }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [subscriber, setSubscriber] = React.useState<PickedSubscriber | null>(presetSubscriber ?? null);
  const { mutate, pending, errors, formError } = useMutation<{ id: string }>();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate(
      "/support/tickets",
      { method: "POST", body: { subscriberId: subscriber?.id ?? null, subject: v.subject, description: v.description, category: v.category, priority: v.priority, assigneeId: v.assigneeId ?? null, channel: v.channel } },
      { success: "Ticket created", refresh: false },
    );
    if (res) router.push(`/support/${res.id}`);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New ticket
        </Button>
      </DialogTrigger>
      <DialogContent title="New support ticket" wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id="t-sub" label="Subscriber (optional)" error={errors.subscriberId}>
            <SubscriberPicker id="t-sub" value={subscriber} onChange={setSubscriber} />
          </Field>
          <Field id="t-subject" label="Subject" error={errors.subject} required>
            <Input name="subject" maxLength={160} />
          </Field>
          <Field id="t-desc" label="Description" error={errors.description} required>
            <Textarea name="description" rows={4} maxLength={5000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="t-cat" label="Category">
              <Select name="category" defaultValue="CONNECTIVITY">
                {CATEGORIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="t-pri" label="Priority">
              <Select name="priority" defaultValue="NORMAL">
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </Select>
            </Field>
            <Field id="t-chan" label="Received via">
              <Select name="channel" defaultValue="phone">
                <option value="phone">Phone call</option>
                <option value="walk_in">Walk-in</option>
                <option value="email">Email</option>
                <option value="staff">Internal</option>
              </Select>
            </Field>
            <Field id="t-assign" label="Assignee">
              <Select name="assigneeId" defaultValue={currentUserId}>
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Multipart upload to the given API path (validated server-side by content). */
export function AttachmentUpload({ path, label = "Attach file" }: { path: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return void toast.error("Files must be 5 MB or smaller.");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/v1${path}`, { method: "POST", body: form, credentials: "same-origin" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed.");
      toast.success("File attached");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs font-medium hover:bg-surface-muted ${busy ? "pointer-events-none opacity-60" : ""}`}>
      <Paperclip className="size-3.5" aria-hidden />
      {busy ? "Uploading…" : label}
      <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain" onChange={onChange} disabled={busy} />
    </label>
  );
}
