import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-semibold text-accent">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you are looking for does not exist or you do not have access.</p>
      <Link href="/dashboard" className="text-sm font-medium text-accent hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
