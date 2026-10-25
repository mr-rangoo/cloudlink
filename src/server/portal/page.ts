import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { PORTAL_COOKIE, resolveCustomerContext } from "@/server/portal/auth";
import type { CustomerContext } from "@/server/auth/context";

export const PORTAL_ORG_COOKIE = "cloudlink_portal_org";

/** Customer context for portal server components; redirects to the portal entry page when signed out. */
export const getCustomerContext = cache(async (): Promise<CustomerContext> => {
  const [c, h] = await Promise.all([cookies(), headers()]);
  const ctx = await resolveCustomerContext(c.get(PORTAL_COOKIE)?.value, {
    correlationId: h.get("x-correlation-id") ?? crypto.randomUUID(),
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  });
  if (!ctx) redirect("/portal");
  return ctx;
});
