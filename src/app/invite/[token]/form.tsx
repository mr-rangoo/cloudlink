"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError, fieldErrors } from "@/lib/api-client";

export function InviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) return setFields({ confirm: "The passwords do not match." });
    setPending(true);
    setError(null);
    setFields({});
    try {
      await api("/auth/invite", { method: "POST", body: { token, password: f.get("password") } });
      router.replace("/login?reason=password-set");
    } catch (err) {
      setFields(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setPending(false);
    }
  };
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <input type="email" name="username" autoComplete="username" defaultValue={email} className="sr-only" tabIndex={-1} aria-hidden />
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
        Set password
      </Button>
    </form>
  );
}
