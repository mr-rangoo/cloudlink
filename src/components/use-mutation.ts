"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, ApiError, fieldErrors } from "@/lib/api-client";

/**
 * Submit a mutation to the API, surface field errors and server messages, and refresh server data.
 * Financial/network state is never updated optimistically: the UI re-reads from the server after success.
 */
export function useMutation<T = unknown>() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const mutate = React.useCallback(
    async (
      path: string,
      init: { method?: string; body?: unknown; idempotencyKey?: string },
      opts: { success?: string; onSuccess?: (data: T) => void; onError?: (err: unknown) => boolean | void; refresh?: boolean } = {},
    ): Promise<T | undefined> => {
      setPending(true);
      setErrors({});
      setFormError(null);
      try {
        const res = await api<{ data: T }>(path, init);
        if (opts.success) toast.success(opts.success);
        opts.onSuccess?.(res.data);
        if (opts.refresh !== false) router.refresh();
        return res.data;
      } catch (err) {
        if (opts.onError?.(err) === true) return undefined; // handled by caller
        const fe = fieldErrors(err);
        setErrors(fe);
        const message = err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
        setFormError(Object.keys(fe).length ? "Please correct the highlighted fields." : message);
        if (!Object.keys(fe).length) toast.error(message, err instanceof ApiError && err.correlationId ? { description: `Reference: ${err.correlationId}` } : undefined);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { mutate, pending, errors, formError, setErrors, setFormError };
}

/** Collect a form into a plain object; empty strings become undefined. */
export function formValues(form: HTMLFormElement): Record<string, string | undefined> {
  const data = new FormData(form);
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of data.entries()) {
    const s = typeof v === "string" ? v.trim() : "";
    out[k] = s === "" ? undefined : s;
  }
  return out;
}
