"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { api, ApiError, fieldErrors } from "@/lib/api-client";

function useSubmit() {
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const submit = async (path: string, body: Record<string, unknown>) => {
    setPending(true);
    setErrors({});
    setError(null);
    try {
      await api(path, { body });
      setDone(true);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      setError(Object.keys(fe).length ? "Please correct the highlighted fields." : err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };
  return { errors, error, pending, done, submit };
}

function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </p>
  ) : null;
}

export function ServiceRequestForm({ organization, provider, plans }: { organization: string; provider: string; plans: Array<{ id: string; label: string }> }) {
  const { errors, error, pending, done, submit } = useSubmit();
  if (done) {
    return (
      <p role="status" className="rounded-md border border-success/20 bg-success-soft px-3 py-2 text-sm text-success">
        Thank you! {provider} will call you to arrange your connection. Once it is installed, you will get a link to set your portal password.
      </p>
    );
  }
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit("/customer/signup", {
          organization,
          name: f.get("name"),
          phone: f.get("phone"),
          email: f.get("email") || null,
          location: f.get("location"),
          packageId: f.get("packageId") || null,
          notes: f.get("notes") || null,
          website: f.get("website") || null,
        });
      }}
    >
      <Field id="sr-name" label="Full name" error={errors.name} required>
        <Input name="name" autoComplete="name" />
      </Field>
      <Field id="sr-phone" label="Phone" error={errors.phone} required>
        <Input name="phone" type="tel" autoComplete="tel" placeholder="0712 345 678" />
      </Field>
      <Field id="sr-email" label="Email (optional)" error={errors.email}>
        <Input name="email" type="email" autoComplete="email" />
      </Field>
      <Field id="sr-location" label="Where do you need internet?" hint="Estate, building and house number" error={errors.location} required>
        <Input name="location" autoComplete="street-address" />
      </Field>
      {plans.length ? (
        <Field id="sr-plan" label="Plan you are interested in (optional)" error={errors.packageId}>
          <Select name="packageId" defaultValue="">
            <option value="">Not sure yet</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field id="sr-notes" label="Anything else? (optional)" error={errors.notes}>
        <Textarea name="notes" rows={3} maxLength={1000} />
      </Field>
      {/* Honeypot for bots; hidden from people and assistive technology. */}
      <div aria-hidden className="hidden">
        <label htmlFor="sr-website">Website</label>
        <input id="sr-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <FormError message={error} />
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        Request a connection
      </Button>
    </form>
  );
}

export function SetupLinkForm({ organization }: { organization: string }) {
  const { errors, error, pending, done, submit } = useSubmit();
  if (done) {
    return (
      <p role="status" className="rounded-md border border-success/20 bg-success-soft px-3 py-2 text-sm text-success">
        If that number belongs to a customer account, we have sent a link to set your password by SMS or email. It works for 72 hours.
      </p>
    );
  }
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit("/customer/auth/setup-link", { organization, identifier: f.get("identifier") });
      }}
    >
      <Field id="sl-identifier" label="Phone or account number" error={errors.identifier} required>
        <Input name="identifier" autoComplete="username" placeholder="0712 345 678 or A000123" />
      </Field>
      <FormError message={error} />
      <Button type="submit" variant="secondary" className="w-full" loading={pending}>
        Send me a link
      </Button>
    </form>
  );
}
