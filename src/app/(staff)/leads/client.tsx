"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export const SOURCES = [
  ["WALK_IN", "Walk-in"],
  ["REFERRAL", "Referral"],
  ["WEBSITE", "Website"],
  ["SOCIAL_MEDIA", "Social media"],
  ["PHONE_CALL", "Phone call"],
  ["FIELD_AGENT", "Field agent"],
  ["OTHER", "Other"],
] as const;

export function NewLeadDialog({ staff, packages, currentUserId }: { staff: Array<{ id: string; name: string }>; packages: Array<{ id: string; name: string }>; currentUserId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation<{ lead: { id: string }; existingSubscribers: Array<{ accountNumber: string; displayName: string }> }>();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate(
      "/leads",
      {
        method: "POST",
        body: { name: v.name, phone: v.phone ?? "", email: v.email ?? null, source: v.source, location: v.location ?? null, notes: v.notes ?? null, interestedPackageId: v.interestedPackageId ?? null, ownerId: v.ownerId ?? null },
      },
      { success: "Lead created", refresh: false },
    );
    if (res) {
      setOpen(false);
      router.push(`/leads/${res.lead.id}${res.existingSubscribers.length ? "?match=1" : ""}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New lead
        </Button>
      </DialogTrigger>
      <DialogContent title="New lead" wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="l-name" label="Name" error={errors.name} required>
              <Input name="name" />
            </Field>
            <Field id="l-phone" label="Phone" error={errors.phone} required>
              <Input name="phone" type="tel" inputMode="tel" />
            </Field>
            <Field id="l-email" label="Email" error={errors.email}>
              <Input name="email" type="email" />
            </Field>
            <Field id="l-source" label="Source" error={errors.source}>
              <Select name="source" defaultValue="WALK_IN">
                {SOURCES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="l-location" label="Location" error={errors.location}>
              <Input name="location" placeholder="Estate, building or landmark" />
            </Field>
            <Field id="l-pkg" label="Interested in" error={errors.interestedPackageId}>
              <Select name="interestedPackageId" defaultValue="">
                <option value="">Not sure yet</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="l-owner" label="Owner" error={errors.ownerId}>
              <Select name="ownerId" defaultValue={currentUserId}>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="l-notes" label="Notes" error={errors.notes} className="sm:col-span-2">
              <Textarea name="notes" rows={2} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create lead
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
