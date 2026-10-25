"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { newIdempotencyKey, rotateOnServerError } from "@/lib/api-client";

const STAGES = [
  ["NEW", "New"],
  ["CONTACTED", "Contacted"],
  ["QUALIFIED", "Qualified"],
  ["SITE_SURVEY", "Site survey"],
  ["PROPOSAL", "Proposal"],
  ["LOST", "Lost"],
] as const;

export function LeadStageForm({
  leadId,
  stage,
  ownerId,
  staff,
  interestedPackageId,
  packages,
}: {
  leadId: string;
  stage: string;
  ownerId: string | null;
  staff: Array<{ id: string; name: string }>;
  interestedPackageId: string | null;
  packages: Array<{ id: string; name: string }>;
}) {
  const [selected, setSelected] = React.useState(stage);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    await mutate(
      `/leads/${leadId}`,
      { method: "PATCH", body: { stage: v.stage, ownerId: v.ownerId ?? null, interestedPackageId: v.interestedPackageId ?? null, ...(v.stage === "LOST" ? { lostReason: v.lostReason ?? null } : {}) } },
      { success: "Lead updated" },
    );
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Field id="stage" label="Stage" error={errors.stage}>
        <Select name="stage" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {STAGES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      {selected === "LOST" ? (
        <Field id="lostReason" label="Why was it lost?" error={errors.lostReason} required>
          <Input name="lostReason" maxLength={500} />
        </Field>
      ) : null}
      <Field id="owner" label="Owner" error={errors.ownerId}>
        <Select name="ownerId" defaultValue={ownerId ?? ""}>
          <option value="">Unassigned</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="interest" label="Interested in" error={errors.interestedPackageId}>
        <Select name="interestedPackageId" defaultValue={interestedPackageId ?? ""}>
          <option value="">Not sure yet</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" loading={pending} className="w-full">
        Save
      </Button>
    </form>
  );
}

export function LeadActivityForm({ leadId }: { leadId: string }) {
  const ref = React.useRef<HTMLFormElement>(null);
  const { mutate, pending, errors } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/leads/${leadId}/activities`, { method: "POST", body: { type: v.type, message: v.message ?? "" } }, { success: "Added to timeline" });
    if (ok) ref.current?.reset();
  };
  return (
    <form ref={ref} onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
      <label htmlFor="act-type" className="sr-only">
        Interaction type
      </label>
      <Select id="act-type" name="type" defaultValue="note" className="sm:w-36">
        <option value="note">Note</option>
        <option value="call">Call</option>
        <option value="meeting">Meeting</option>
        <option value="site_survey">Site survey</option>
      </Select>
      <div className="flex-1">
        <label htmlFor="act-msg" className="sr-only">
          Details
        </label>
        <Input id="act-msg" name="message" placeholder="What happened?" maxLength={2000} aria-invalid={errors.message ? true : undefined} />
        {errors.message ? <p className="mt-1 text-xs text-danger">{errors.message}</p> : null}
      </div>
      <Button type="submit" variant="secondary" loading={pending}>
        Add
      </Button>
    </form>
  );
}

export function ConvertLeadDialog({
  leadId,
  name,
  packages,
  defaultPackageId,
  hasDuplicate,
  canSubscribe,
}: {
  leadId: string;
  name: string;
  packages: Array<{ id: string; name: string }>;
  defaultPackageId: string | null;
  hasDuplicate: boolean;
  canSubscribe: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<"INDIVIDUAL" | "BUSINESS">("INDIVIDUAL");
  const [key, setKey] = React.useState(() => newIdempotencyKey("convert"));
  const { mutate, pending, errors, formError } = useMutation<{ subscriber: { id: string } }>();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate(
      `/leads/${leadId}/convert`,
      {
        method: "POST",
        idempotencyKey: key,
        body: {
          type,
          companyName: type === "BUSINESS" ? (v.companyName ?? name) : null,
          idNumber: v.idNumber ?? null,
          packageId: canSubscribe ? (v.packageId ?? null) : null,
          activateSubscription: v.activate === "on",
          allowDuplicateContact: v.allowDuplicate === "on",
        },
      },
      { success: "Lead converted", refresh: false, onError: (err) => rotateOnServerError(err, () => setKey(newIdempotencyKey("convert"))) },
    );
    if (res) router.push(`/subscribers/${res.subscriber.id}?created=1`);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setKey(newIdempotencyKey("convert"));
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserCheck /> Convert to subscriber
        </Button>
      </DialogTrigger>
      <DialogContent title={`Convert ${name}`} description="Creates the subscriber account (and optional subscription) in one step. The lead history is kept.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id="c-type" label="Account type">
            <Select value={type} onChange={(e) => setType(e.target.value as "INDIVIDUAL" | "BUSINESS")}>
              <option value="INDIVIDUAL">Individual</option>
              <option value="BUSINESS">Business</option>
            </Select>
          </Field>
          {type === "BUSINESS" ? (
            <Field id="c-company" label="Company name" error={errors.companyName}>
              <Input name="companyName" defaultValue={name} />
            </Field>
          ) : null}
          <Field id="c-id" label={type === "BUSINESS" ? "KRA PIN" : "National ID"} error={errors.idNumber}>
            <Input name="idNumber" />
          </Field>
          {canSubscribe ? (
            <>
              <Field id="c-pkg" label="Package" error={errors.packageId}>
                <Select name="packageId" defaultValue={defaultPackageId ?? ""}>
                  <option value="">No subscription yet</option>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="activate" defaultChecked /> Activate the subscription immediately
              </label>
            </>
          ) : null}
          {hasDuplicate ? (
            <label className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft p-3 text-sm">
              <input type="checkbox" name="allowDuplicate" className="mt-0.5" />
              <span>I confirmed this is a different customer from the existing subscriber with the same contact (recorded in the audit log).</span>
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Convert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
