import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { systemContext, type RequestMeta } from "@/server/auth/context";
import { auditAnonymous } from "@/server/audit/audit";
import { AppError } from "@/server/errors";
import { normalizePhone } from "@/server/domain/contact";
import { logger } from "@/server/observability/logger";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { createLead } from "@/server/services/leads";
import { queueSubscriberNotificationTx } from "@/server/services/notifications";
import { notifyOperators } from "@/server/services/operator-alerts";

/**
 * Customer-portal sign-up for people without a portal password:
 * - new customers ask for a connection, which becomes a lead in the ISP's CRM (staff then install and activate);
 * - existing customers (never set a password, or forgot it) ask for a setup link sent to the phone/email on file.
 * Replies never reveal whether a phone number or account exists.
 */

export const PORTAL_SIGNUP_RATE = {
  requestByIp: { name: "portal:request:ip", limit: 5, windowSeconds: 60 * 60 },
  requestByPhone: { name: "portal:request:phone", limit: 2, windowSeconds: 24 * 3600 },
  linkByIp: { name: "portal:link:ip", limit: 10, windowSeconds: 60 * 60 },
  linkByIdentifier: { name: "portal:link:id", limit: 3, windowSeconds: 24 * 3600 },
};

const slug = z.string().trim().toLowerCase().min(1).max(60);

export const serviceRequestInput = z.object({
  organization: slug,
  name: z.string().trim().min(2, "Enter your name").max(120),
  phone: z
    .string()
    .trim()
    .max(30)
    .transform((v, ctx) => {
      const n = normalizePhone(v);
      if (!n) ctx.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 0712 345 678" });
      return n ?? "";
    }),
  email: z.email("Enter a valid email address").max(200).optional().nullable().or(z.literal("").transform(() => null)),
  location: z.string().trim().min(2, "Tell us where you need the connection").max(200),
  packageId: z.uuid().optional().nullable().or(z.literal("").transform(() => null)),
  notes: z.string().trim().max(1000).optional().nullable(),
  /** Honeypot: hidden from people, filled by bots. */
  website: z.string().max(200).optional().nullable(),
});

export const setupLinkInput = z.object({ organization: slug, identifier: z.string().trim().min(3, "Enter your phone or account number").max(60) });

async function activeOrganization(slugValue: string) {
  const org = await db.organization.findUnique({ where: { slug: slugValue }, select: { id: true, name: true, status: true } });
  if (!org || org.status !== "ACTIVE") throw new AppError("NOT_FOUND", "This provider was not found.");
  return org;
}

/** Plans a prospective customer can choose from: active, listed, home/business (PPPoE or static) service. */
export async function signupPlans(organizationId: string) {
  return db.package.findMany({
    where: { organizationId, status: "ACTIVE", listed: true, serviceType: { not: "HOTSPOT" } },
    orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
    select: { id: true, name: true, price: true, currency: true, billingUnit: true, billingCount: true, downloadKbps: true, highlight: true },
  });
}

export async function requestService(raw: z.input<typeof serviceRequestInput>, meta: RequestMeta) {
  const input = serviceRequestInput.parse(raw);
  const org = await activeOrganization(input.organization);
  await consumeRateLimit(PORTAL_SIGNUP_RATE.requestByIp, `${org.id}:${meta.ipAddress ?? "unknown"}`);
  if (input.website) return { received: true }; // bot: same reply, nothing stored
  await consumeRateLimit(PORTAL_SIGNUP_RATE.requestByPhone, `${org.id}:${input.phone}`);

  const open = await db.lead.findFirst({ where: { organizationId: org.id, phone: input.phone, stage: { notIn: ["WON", "LOST"] } }, select: { id: true } });
  if (!open) {
    const plan = input.packageId ? (await signupPlans(org.id)).find((p) => p.id === input.packageId) : null;
    const ctx = systemContext(org.id, "portal:signup", meta.correlationId);
    const { lead } = await createLead(ctx, {
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      source: "WEBSITE",
      location: input.location,
      notes: ["Requested a connection from the customer portal sign-up page.", input.notes ? `Message: ${input.notes}` : null].filter(Boolean).join("\n"),
      interestedPackageId: plan?.id ?? null,
      ownerId: null,
      branchId: null,
    });
    try {
      await notifyOperators(org.id, "service_request", `New connection request from ${input.name} (${input.phone}), ${input.location}${plan ? `, plan ${plan.name}` : ""}.`, `lead:${lead.id}`);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "operator alert for a service request could not be queued");
    }
  }
  await auditAnonymous({ action: "portal.service_requested", organizationId: org.id, metadata: { duplicate: Boolean(open) }, ...meta });
  return { received: true };
}

/**
 * Send a portal setup link (also works as "forgot password") to the contacts on file. The worker mints the token
 * at send time. The same reply is returned whether or not the identifier matched an account.
 */
export async function requestPortalSetupLink(raw: z.input<typeof setupLinkInput>, meta: RequestMeta) {
  const input = setupLinkInput.parse(raw);
  const org = await activeOrganization(input.organization);
  await consumeRateLimit(PORTAL_SIGNUP_RATE.linkByIp, `${org.id}:${meta.ipAddress ?? "unknown"}`);
  await consumeRateLimit(PORTAL_SIGNUP_RATE.linkByIdentifier, `${org.id}:${input.identifier.toLowerCase()}`);

  const phone = normalizePhone(input.identifier);
  const sub = await db.subscriber.findFirst({
    where: { organizationId: org.id, status: { not: "ARCHIVED" }, OR: [{ accountNumber: input.identifier.toUpperCase() }, ...(phone ? [{ phone }] : [])] },
    select: { id: true, phone: true },
  });
  let sent = false;
  if (sub) {
    const account = await db.customerAccount.findUnique({ where: { subscriberId: sub.id } });
    const clash = await db.customerAccount.findFirst({ where: { organizationId: org.id, loginPhone: sub.phone, subscriberId: { not: sub.id } }, select: { id: true } });
    if (account?.status !== "DISABLED" && !clash) {
      const acc = account ?? (await db.customerAccount.create({ data: { organizationId: org.id, subscriberId: sub.id, loginPhone: sub.phone, status: "INVITED" } }));
      const queued = await db.$transaction((tx) =>
        queueSubscriberNotificationTx(tx, org.id, { subscriberId: sub.id, key: "portal.invite", vars: { link: "{{link}}" }, dedupeBase: `portal.invite:${acc.id}:${Date.now()}` }),
      );
      sent = queued > 0;
    }
  }
  await auditAnonymous({ action: "portal.setup_link_requested", organizationId: org.id, metadata: { matched: Boolean(sub), sent }, ...meta });
  return { requested: true };
}
