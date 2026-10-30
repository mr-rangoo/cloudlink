import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import type { RequestMeta } from "@/server/auth/context";
import { normalizeEmail } from "@/server/auth/service";
import { createSession } from "@/server/auth/session";
import { auditAnonymous } from "@/server/audit/audit";
import { AppError } from "@/server/errors";
import { normalizePhone } from "@/server/domain/contact";
import { emailAdapter } from "@/server/integrations/messaging";
import { logger } from "@/server/observability/logger";
import { hashPassword, PASSWORD_MIN_LENGTH, randomToken, sha256 } from "@/server/security/crypto";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { bootstrapOrganizationTx, RESERVED_SLUGS, syncPermissionCatalogue } from "@/server/services/organizations";

/**
 * Self-service sign-up for a new ISP workspace.
 *
 * 1. The form creates a pending SignupRequest (hashed password, hashed link token) and emails a confirmation link.
 *    The reply is the same whether or not the email already has an account (no account discovery); an existing
 *    owner gets a "you already have an account" email instead of a link.
 * 2. Opening the link shows a confirmation button (link scanners only GET). Confirming creates the organization,
 *    first branch, default roles and owner in one transaction, consumes the link, and signs the owner in.
 *
 * In test mode (mock mailer, never in production) the would-be email is returned so the flow can be completed locally.
 */

export const SIGNUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const SIGNUP_RATE = {
  perIp: { name: "signup:ip", limit: 5, windowSeconds: 60 * 60 },
  perEmail: { name: "signup:email", limit: 3, windowSeconds: 60 * 60 },
  completeByIp: { name: "signup:complete", limit: 20, windowSeconds: 60 * 60 },
};

export function signupOpen(): boolean {
  return (process.env.SIGNUP_MODE ?? "open") !== "closed";
}

export const signupInput = z.object({
  organizationName: z.string().trim().min(2, "Enter your company or ISP name").max(120),
  name: z.string().trim().min(2, "Enter your name").max(120),
  email: z.email("Enter a valid email address").max(200),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (!v) return null;
      const n = normalizePhone(v);
      if (!n) ctx.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 0712 345 678" });
      return n;
    }),
  password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`).max(256),
  acceptTerms: z.literal(true, "Accept the terms to continue"),
});

export const signupTokenInput = z.object({ token: z.string().min(20).max(128) });

function appUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}

/** Shown on screen only in test mode (mock mailer outside production). */
function testPreview(mail: { to: string; subject: string; body: string }, link: string | null, mock: boolean) {
  return mock && process.env.APP_ENV !== "production" ? { ...mail, link } : null;
}

export async function startSignup(raw: z.input<typeof signupInput>, meta: RequestMeta) {
  if (!signupOpen()) throw new AppError("FORBIDDEN", "Sign-up is closed. Contact us to get an account.");
  const input = signupInput.parse(raw);
  const email = normalizeEmail(input.email);
  const mailer = emailAdapter();
  if (!mailer.available) throw new AppError("INTEGRATION_UNAVAILABLE", "Sign-up is temporarily unavailable. Please try again later.");
  await consumeRateLimit(SIGNUP_RATE.perIp, meta.ipAddress ?? "unknown");
  await consumeRateLimit(SIGNUP_RATE.perEmail, email);

  // Housekeeping: requests older than a week are never needed again.
  await db.signupRequest.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } } });

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  let mail: { to: string; subject: string; body: string };
  let requestId: string | null = null;
  let link: string | null = null;
  if (existing) {
    mail = {
      to: email,
      subject: "You already have a Cloudlink account",
      body: `Hello,\n\nSomeone (hopefully you) tried to create a Cloudlink account with this email address, but you already have one.\n\nSign in at ${appUrl()}/login. If you have forgotten your password, ask your organization administrator to send you a reset link.\n\nIf this wasn't you, you can ignore this email.`,
    };
  } else {
    const token = randomToken(32);
    const request = await db.signupRequest.create({
      data: {
        email,
        name: input.name,
        organizationName: input.organizationName,
        phone: input.phone,
        passwordHash: await hashPassword(input.password),
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + SIGNUP_LINK_TTL_MS),
        ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
      },
    });
    requestId = request.id;
    link = `${appUrl()}/signup/verify?token=${encodeURIComponent(token)}`;
    mail = {
      to: email,
      subject: "Confirm your email to create your Cloudlink account",
      body: `Hello ${input.name.split(" ")[0]},\n\nConfirm your email address to finish creating ${input.organizationName} on Cloudlink:\n\n${link}\n\nThe link works for 24 hours. If you didn't sign up, you can ignore this email.`,
    };
  }

  try {
    await mailer.send(mail);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "signup email could not be sent");
    if (requestId) await db.signupRequest.delete({ where: { id: requestId } }).catch(() => undefined);
    throw new AppError("INTEGRATION_ERROR", "We couldn't send the confirmation email. Please try again shortly.");
  }
  await auditAnonymous({ action: "auth.signup_requested", metadata: { existingAccount: Boolean(existing) }, ...meta });
  return { email, preview: testPreview(mail, link, mailer.provider.startsWith("mock")) };
}

async function liveRequest(token: string) {
  const req = await db.signupRequest.findUnique({ where: { tokenHash: sha256(token) } });
  if (!req || req.completedAt || req.expiresAt <= new Date()) return null;
  return req;
}

/** For the confirmation page: who is signing up, or null when the link is invalid, used or expired. */
export async function describeSignup(token: string) {
  const req = await liveRequest(token);
  return req ? { email: req.email, name: req.name, organizationName: req.organizationName } : null;
}

/** Portal-safe address from a company name: lowercase words joined by hyphens, never a reserved path. */
export function slugFor(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 2 && !RESERVED_SLUGS.has(base) ? base : "isp";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugFor(name);
  const taken = new Set((await db.organization.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((o) => o.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

/** Confirm the email: create the workspace and owner, consume the link, and start a session. */
export async function completeSignup(raw: z.input<typeof signupTokenInput>, meta: RequestMeta) {
  const { token } = signupTokenInput.parse(raw);
  await consumeRateLimit(SIGNUP_RATE.completeByIp, meta.ipAddress ?? "unknown");
  const pending = await liveRequest(token);
  if (!pending) throw new AppError("INVALID_STATE", "This link is invalid, has already been used, or has expired. Sign up again to get a new one.");
  await syncPermissionCatalogue();
  const slug = await uniqueSlug(pending.organizationName);

  const result = await db.$transaction(async (tx) => {
    // Consume the link first: a second confirmation of the same link finds nothing to claim.
    const claimed = await tx.signupRequest.updateMany({ where: { id: pending.id, completedAt: null, expiresAt: { gt: new Date() } }, data: { completedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError("INVALID_STATE", "This link has already been used. Sign in instead.");
    const created = await bootstrapOrganizationTx(
      tx,
      { name: pending.organizationName, slug, currency: "KES", timezone: "Africa/Nairobi", branch: { name: "Main office", code: "MAIN" } },
      { name: pending.name, email: pending.email, passwordHash: pending.passwordHash, newUserOnly: true },
      { action: "organization.signup", metadata: { via: "self_service" } },
    );
    await tx.billingSettings.upsert({
      where: { organizationId: created.organization.id },
      create: { organizationId: created.organization.id, legalName: pending.organizationName, email: pending.email, phone: pending.phone },
      update: {},
    });
    await tx.signupRequest.update({ where: { id: pending.id }, data: { organizationId: created.organization.id, passwordHash: "" } });
    return created;
  });

  const session = await createSession(result.owner.id, result.organization.id, meta);
  await auditAnonymous({ action: "auth.login", organizationId: result.organization.id, actorUserId: result.owner.id, entityType: "session", entityId: session.sessionId, metadata: { via: "signup" }, ...meta });
  return { session, organization: { id: result.organization.id, name: result.organization.name, slug: result.organization.slug } };
}
