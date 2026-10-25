"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api-client";

export function PortalLoginForm({ organization }: { organization: string }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api("/customer/auth/login", { method: "POST", body: { organization, identifier: f.get("identifier"), password: f.get("password") } });
      router.replace("/portal/home");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed. Please try again.");
      setPending(false);
    }
  };
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field id="identifier" label="Phone or account number">
        <Input name="identifier" autoComplete="username" inputMode="text" placeholder="0712 345 678 or A000123" />
      </Field>
      <Field id="password" label="Password">
        <Input name="password" type="password" autoComplete="current-password" />
      </Field>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        Sign in
      </Button>
    </form>
  );
}
