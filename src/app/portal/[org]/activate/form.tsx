"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError, fieldErrors } from "@/lib/api-client";

export function ActivateForm({ token, organization }: { token: string; organization: string }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) {
      setFields({ confirm: "The passwords do not match." });
      return;
    }
    setPending(true);
    setError(null);
    setFields({});
    try {
      await api("/customer/auth/activate", { method: "POST", body: { token, password: f.get("password") } });
      router.replace(`/portal/${organization}/login?activated=1`);
    } catch (err) {
      setFields(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setPending(false);
    }
  };
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field id="password" label="New password" hint="At least 10 characters" error={fields.password}>
        <Input name="password" type="password" autoComplete="new-password" />
      </Field>
      <Field id="confirm" label="Confirm password" error={fields.confirm}>
        <Input name="confirm" type="password" autoComplete="new-password" />
      </Field>
      {error && !fields.password ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        Save password
      </Button>
    </form>
  );
}
