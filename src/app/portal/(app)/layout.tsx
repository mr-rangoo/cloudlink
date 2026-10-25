import { getCustomerContext } from "@/server/portal/page";
import { PortalNav } from "./nav";

export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCustomerContext();
  return (
    <div className="min-h-dvh bg-background">
      <PortalNav organization={ctx.organization.name} customer={ctx.displayName} />
      <main id="main" className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-4xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">Powered by Cloudlink · Your data is visible only to you and {ctx.organization.name}.</footer>
    </div>
  );
}
