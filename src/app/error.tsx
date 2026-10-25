"use client";

import { Button } from "@/components/ui/button";

/** Generic error boundary. Never renders stack traces; shows the digest for support correlation. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">An unexpected error occurred while loading this page. Your data has not been changed by this error.</p>
      {error.digest ? <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
