"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";

export function ConfirmSignup({ token, organizationName }: { token: string; organizationName: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await api("/auth/signup/complete", { body: { token } });
      router.replace("/dashboard?welcome=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setPending(false);
    }
  };
  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button className="w-full" size="lg" loading={pending} onClick={confirm}>
        Create {organizationName}
      </Button>
    </div>
  );
}
