"use client";

import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { newIdempotencyKey, rotateOnServerError } from "@/lib/api-client";

type Action = "activate" | "renew" | "suspend" | "reactivate" | "cancel";

const ACTION_COPY: Record<Action, { label: string; title: string; body: string; tone: "primary" | "secondary" | "danger"; reason?: "required" | "optional" }> = {
  activate: { label: "Activate", title: "Activate subscription", body: "Starts the first billing period now.", tone: "primary" },
  renew: { label: "Renew", title: "Renew subscription", body: "Extends service by one billing cycle (continues from the current end date if still running, otherwise restarts from now). Normally renewal happens automatically when the period invoice is paid.", tone: "secondary", reason: "optional" },
  suspend: { label: "Suspend", title: "Suspend subscription", body: "Marks the subscription as suspended. No router change is made until network automation is connected.", tone: "secondary", reason: "required" },
  reactivate: { label: "Reactivate", title: "Reactivate subscription", body: "Restores a suspended subscription within its paid period.", tone: "primary" },
  cancel: { label: "Cancel", title: "Cancel subscription", body: "Cancellation is permanent. Billing stops; history is kept.", tone: "danger", reason: "optional" },
};

const DONE: Record<Action, string> = { activate: "Subscription activated", renew: "Subscription renewed", suspend: "Subscription suspended", reactivate: "Subscription reactivated", cancel: "Subscription cancelled" };

export function SubscriptionActions({ subscriptionId, packageName, actions, canInvoice }: { subscriptionId: string; packageName: string; actions: Action[]; canInvoice: boolean }) {
  if (!actions.length) return <p className="text-xs text-muted-foreground">No actions available</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => (
        <ActionDialog key={a} action={a} subscriptionId={subscriptionId} packageName={packageName} canInvoice={canInvoice} />
      ))}
    </div>
  );
}

function ActionDialog({ action, subscriptionId, packageName, canInvoice }: { action: Action; subscriptionId: string; packageName: string; canInvoice: boolean }) {
  const copy = ACTION_COPY[action];
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(() => newIdempotencyKey(action));
  const { mutate, pending, errors, formError } = useMutation();

  const offerInvoice = canInvoice && (action === "activate" || action === "renew");

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (v) setKey(newIdempotencyKey(action)); // one key per confirmation; retries of the same submit reuse it
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/subscriptions/${subscriptionId}/${action}`, { method: "POST", body: { reason: v.reason, ...(offerInvoice ? { invoice: v.invoice === "on" } : {}) }, idempotencyKey: key }, { success: DONE[action], onError: (err) => rotateOnServerError(err, () => setKey(newIdempotencyKey(action))) });
    if (ok) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant={copy.tone === "danger" ? "secondary" : copy.tone}>
          {copy.label}
        </Button>
      </DialogTrigger>
      <DialogContent title={copy.title} description={packageName}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          {offerInvoice ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="invoice" defaultChecked className="mt-0.5" />
              <span>
                Create the invoice for the new period
                <span className="block text-xs text-muted-foreground">Untick only for authorised complimentary service. Existing credit is applied automatically.</span>
              </span>
            </label>
          ) : null}
          {copy.reason ? (
            <Field id={`reason-${action}`} label={copy.reason === "required" ? "Reason" : "Reason (optional)"} error={errors.reason} required={copy.reason === "required"}>
              <Textarea name="reason" rows={2} maxLength={500} />
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Back
            </Button>
            <Button type="submit" variant={copy.tone === "danger" ? "danger" : "primary"} loading={pending}>
              {copy.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AddSubscriptionDialog({ subscriberId, packages }: { subscriberId: string; packages: Array<{ id: string; label: string }> }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate("/subscriptions", { method: "POST", body: { subscriberId, packageId: v.packageId, activate: v.activate === "on", graceDays: v.graceDays ?? "0", autoRenew: true } }, { success: "Subscription added" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add subscription
        </Button>
      </DialogTrigger>
      <DialogContent title="Add subscription" description="The package price and terms are copied onto the subscription.">
        {packages.length === 0 ? (
          <Alert tone="info">No active packages are available. Create a package first.</Alert>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <Field id="add-pkg" label="Package" error={errors.packageId} required>
              <Select name="packageId" defaultValue={packages[0]?.id}>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="add-grace" label="Grace days after period end" error={errors.graceDays} hint="Days before an unpaid subscription expires">
              <Input name="graceDays" type="number" min={0} max={60} defaultValue={0} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="activate" defaultChecked /> Activate immediately
            </label>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                Add subscription
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface EditableSubscriber {
  id: string;
  type: string;
  firstName: string;
  lastName: string;
  companyName: string;
  phone: string;
  altPhone: string;
  email: string;
  idNumber: string;
  notes: string;
  status: string;
  branchId: string | null;
}

export function EditSubscriberDialog({ subscriber, branches }: { subscriber: EditableSubscriber; branches: Array<{ id: string; name: string; code: string }> }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(
      `/subscribers/${subscriber.id}`,
      {
        method: "PATCH",
        body: {
          firstName: v.firstName ?? null,
          lastName: v.lastName ?? null,
          companyName: v.companyName ?? null,
          phone: v.phone,
          altPhone: v.altPhone ?? null,
          email: v.email ?? null,
          idNumber: v.idNumber ?? null,
          notes: v.notes ?? null,
          status: v.status,
          ...(branches.length ? { branchId: v.branchId ?? null } : {}),
        },
      },
      { success: "Subscriber updated" },
    );
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Pencil /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent title="Edit subscriber" wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            {subscriber.type === "BUSINESS" ? (
              <Field id="e-company" label="Company name" error={errors.companyName} className="sm:col-span-2">
                <Input name="companyName" defaultValue={subscriber.companyName} />
              </Field>
            ) : null}
            <Field id="e-first" label="First name" error={errors.firstName}>
              <Input name="firstName" defaultValue={subscriber.firstName} />
            </Field>
            <Field id="e-last" label="Last name" error={errors.lastName}>
              <Input name="lastName" defaultValue={subscriber.lastName} />
            </Field>
            <Field id="e-phone" label="Phone" error={errors.phone} required>
              <Input name="phone" type="tel" defaultValue={subscriber.phone} />
            </Field>
            <Field id="e-alt" label="Alternative phone" error={errors.altPhone}>
              <Input name="altPhone" type="tel" defaultValue={subscriber.altPhone} />
            </Field>
            <Field id="e-email" label="Email" error={errors.email}>
              <Input name="email" type="email" defaultValue={subscriber.email} />
            </Field>
            <Field id="e-id" label="National ID / KRA PIN" error={errors.idNumber}>
              <Input name="idNumber" defaultValue={subscriber.idNumber} />
            </Field>
            {branches.length ? (
              <Field id="e-branch" label="Branch" error={errors.branchId}>
                <Select name="branchId" defaultValue={subscriber.branchId ?? ""}>
                  <option value="">No branch</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field id="e-status" label="Account status" error={errors.status}>
              <Select name="status" defaultValue={subscriber.status}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
            <Field id="e-notes" label="Internal notes" error={errors.notes} className="sm:col-span-2">
              <Textarea name="notes" rows={3} defaultValue={subscriber.notes} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NoteForm({ subscriberId }: { subscriberId: string }) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const { mutate, pending, errors } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/subscribers/${subscriberId}/activity`, { method: "POST", body: { message: v.message ?? "" } }, { success: "Note added" });
    if (ok) formRef.current?.reset();
  };
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
      <div className="flex-1">
        <label htmlFor="note" className="sr-only">
          Add a note
        </label>
        <Input id="note" name="message" placeholder="Add a note to the timeline…" maxLength={2000} aria-invalid={errors.message ? true : undefined} />
        {errors.message ? <p className="mt-1 text-xs text-danger">{errors.message}</p> : null}
      </div>
      <Button type="submit" variant="secondary" loading={pending}>
        Add note
      </Button>
    </form>
  );
}
