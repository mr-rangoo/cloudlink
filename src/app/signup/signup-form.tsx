"use client";

import * as React from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { api, ApiError, fieldErrors } from "@/lib/api-client";

interface Started {
  email: string;
  preview: { to: string; subject: string; body: string; link: string | null } | null;
}

export function SignupForm() {
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [started, setStarted] = React.useState<Started | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setErrors({ confirm: "The passwords do not match." });
      return;
    }
    setPending(true);
    setError(null);
    setErrors({});
    try {
      const res = await api<{ data: Started }>("/auth/signup", {
        body: {
          organizationName: form.get("organizationName"),
          name: form.get("name"),
          email: form.get("email"),
          phone: form.get("phone") || null,
          password,
          acceptTerms: form.get("acceptTerms") === "on",
        },
      });
      setStarted(res.data);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      setError(Object.keys(fe).length ? "Please correct the highlighted fields." : err instanceof ApiError ? err.message : "Sign-up failed. Please try again.");
    } finally {
      setPending(false);
    }
  };

  if (started) {
    return (
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-md border border-success/20 bg-success-soft px-4 py-3 text-sm text-success" role="status">
          <MailCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            Check your email. We sent a link to <strong>{started.email}</strong> to confirm your address and finish setting up. It works for 24 hours.
          </p>
        </div>
        {started.preview ? (
          <div className="space-y-2 rounded-md border border-warning/30 bg-warning-soft p-4 text-sm">
            <p className="font-medium text-warning">Test mode: no email was sent</p>
            <p className="text-muted-foreground">This server uses the mock mailer, so here is the message it would have sent.</p>
            <p className="font-medium">{started.preview.subject}</p>
            <pre className="whitespace-pre-wrap break-words rounded bg-surface p-3 text-xs">{started.preview.body}</pre>
            {started.preview.link ? (
              <a href={started.preview.link} className="inline-block font-medium text-accent hover:underline">
                Open the confirmation link
              </a>
            ) : null}
          </div>
        ) : null}
        <p className="text-center text-sm text-muted-foreground">
          Wrong address?{" "}
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => setStarted(null)}>
            Start again
          </button>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field id="organizationName" label="Company or ISP name" error={errors.organizationName} required>
        <Input name="organizationName" autoComplete="organization" placeholder="Skyline Fibre Ltd" />
      </Field>
      <Field id="name" label="Your name" error={errors.name} required>
        <Input name="name" autoComplete="name" />
      </Field>
      <Field id="email" label="Work email" error={errors.email} required>
        <Input name="email" type="email" autoComplete="email" placeholder="you@example.co.ke" />
      </Field>
      <Field id="phone" label="Phone (optional)" error={errors.phone}>
        <Input name="phone" type="tel" autoComplete="tel" placeholder="0712 345 678" />
      </Field>
      <Field id="password" label="Password" hint="At least 10 characters" error={errors.password} required>
        <Input name="password" type="password" autoComplete="new-password" />
      </Field>
      <Field id="confirm" label="Confirm password" error={errors.confirm} required>
        <Input name="confirm" type="password" autoComplete="new-password" />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="acceptTerms" className="mt-0.5" />
        <span>I am authorised to open this account for my company, and I agree that Cloudlink stores the account and customer data I add.</span>
      </label>
      {errors.acceptTerms ? <p className="text-sm text-danger">{errors.acceptTerms}</p> : null}
      {error ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        Create account
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
