"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api-client";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: { email: form.get("email"), password: form.get("password") } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed. Please try again.");
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field id="email" label="Email">
        <Input name="email" type="email" autoComplete="username" placeholder="you@example.co.ke" />
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
      <p className="text-center text-xs text-muted-foreground">Password resets are handled by your organization administrator.</p>
    </form>
  );
}
