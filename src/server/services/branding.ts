import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { sniffContentType } from "@/server/domain/uploads";
import { storage } from "@/server/integrations/storage";
import { DEFAULT_THEME, isHexColor, presetById, resolveTheme, THEME_PRESETS, themeCss, tokensFromBrand } from "@/lib/themes";

/**
 * Organization branding: theme preset, optional brand colour, default light/dark mode, logo and portal texts.
 * Applied to the staff app, the customer portal and the hotspot captive portal.
 */
export const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const brandingInput = z.object({
  themePreset: z.enum(THEME_PRESETS.map((p) => p.id) as [string, ...string[]]),
  customAccent: z
    .union([z.string().trim().toLowerCase().refine(isHexColor, "Use a colour like #1d6fe8"), z.literal("").transform(() => null), z.null()])
    .optional(),
  defaultMode: z.enum(["light", "dark", "system"]),
  portalWelcome: z.string().trim().max(300).nullable().optional(),
  supportHours: z.string().trim().max(120).nullable().optional(),
});

export interface BrandingView {
  themePreset: string;
  customAccent: string | null;
  defaultMode: "light" | "dark" | "system";
  logoUrl: string | null;
  portalWelcome: string | null;
  supportHours: string | null;
  css: string;
}

function view(slug: string, row: { themePreset: string; customAccent: string | null; defaultMode: string; logoKey: string | null; logoUpdatedAt: Date | null; portalWelcome: string | null; supportHours: string | null } | null): BrandingView {
  const themePreset = row?.themePreset ?? DEFAULT_THEME;
  const customAccent = row?.customAccent ?? null;
  return {
    themePreset,
    customAccent,
    defaultMode: (row?.defaultMode as BrandingView["defaultMode"]) ?? "light",
    logoUrl: row?.logoKey ? `/api/v1/branding/${slug}/logo?v=${row.logoUpdatedAt?.getTime() ?? 0}` : null,
    portalWelcome: row?.portalWelcome ?? null,
    supportHours: row?.supportHours ?? null,
    css: themeCss(resolveTheme(themePreset, customAccent)),
  };
}

/** Branding for rendering (no permission needed: it is shown to anyone who can see the organization's pages). */
export async function brandingFor(organizationId: string): Promise<BrandingView> {
  const [org, row] = await Promise.all([db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } }), db.organizationBranding.findUnique({ where: { organizationId } })]);
  return view(org.slug, row);
}

export async function brandingForSlug(slug: string): Promise<(BrandingView & { organizationId: string; name: string }) | null> {
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true, name: true, status: true } });
  if (!org || org.status !== "ACTIVE") return null;
  const row = await db.organizationBranding.findUnique({ where: { organizationId: org.id } });
  return { ...view(slug, row), organizationId: org.id, name: org.name };
}

export async function updateBranding(ctx: StaffContext, raw: z.input<typeof brandingInput>) {
  requirePermission(ctx, "settings.write");
  const input = brandingInput.parse(raw);
  const accent = input.customAccent ?? null;
  if (accent && !tokensFromBrand(accent, presetById(input.themePreset))) {
    const message = "Text on this colour would be hard to read. Choose a darker shade.";
    throw new AppError("VALIDATION_ERROR", message, { fields: [{ path: "customAccent", message }] });
  }
  const data = { themePreset: input.themePreset, customAccent: accent, defaultMode: input.defaultMode, portalWelcome: input.portalWelcome ?? null, supportHours: input.supportHours ?? null };
  await db.organizationBranding.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
  await audit(ctx, { action: "settings.branding.update", entityType: "organization", entityId: ctx.organizationId, metadata: { themePreset: data.themePreset, customAccent: accent, defaultMode: data.defaultMode } });
  return brandingFor(ctx.organizationId);
}

export async function uploadLogo(ctx: StaffContext, file: { name: string; data: Buffer }) {
  requirePermission(ctx, "settings.write");
  if (file.data.length === 0) throw new AppError("VALIDATION_ERROR", "The file is empty.");
  if (file.data.length > MAX_LOGO_BYTES) throw new AppError("VALIDATION_ERROR", "Logos must be 512 KB or smaller.");
  const type = sniffContentType(file.data);
  if (!type || !(LOGO_TYPES as readonly string[]).includes(type)) throw new AppError("VALIDATION_ERROR", "Upload a PNG, JPEG or WebP image.");
  const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
  const key = `branding/${ctx.organizationId}/logo-${randomBytes(6).toString("hex")}.${ext}`;
  const previous = await db.organizationBranding.findUnique({ where: { organizationId: ctx.organizationId }, select: { logoKey: true } });
  await storage().put(key, file.data, type);
  await db.organizationBranding.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, logoKey: key, logoContentType: type, logoUpdatedAt: new Date() },
    update: { logoKey: key, logoContentType: type, logoUpdatedAt: new Date() },
  });
  if (previous?.logoKey) await storage().remove(previous.logoKey).catch(() => undefined);
  await audit(ctx, { action: "settings.branding.logo", entityType: "organization", entityId: ctx.organizationId, metadata: { bytes: file.data.length, type } });
  return brandingFor(ctx.organizationId);
}

export async function removeLogo(ctx: StaffContext) {
  requirePermission(ctx, "settings.write");
  const row = await db.organizationBranding.findUnique({ where: { organizationId: ctx.organizationId }, select: { logoKey: true } });
  if (row?.logoKey) {
    await db.organizationBranding.update({ where: { organizationId: ctx.organizationId }, data: { logoKey: null, logoContentType: null, logoUpdatedAt: new Date() } });
    await storage().remove(row.logoKey).catch(() => undefined);
    await audit(ctx, { action: "settings.branding.logo_removed", entityType: "organization", entityId: ctx.organizationId });
  }
  return brandingFor(ctx.organizationId);
}

/** Public logo bytes for an organization (used by portal and hotspot pages). */
export async function logoForSlug(slug: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) return null;
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!org || org.status !== "ACTIVE") return null;
  const row = await db.organizationBranding.findUnique({ where: { organizationId: org.id }, select: { logoKey: true, logoContentType: true } });
  if (!row?.logoKey || !row.logoContentType) return null;
  try {
    return { data: await storage().get(row.logoKey), contentType: row.logoContentType };
  } catch {
    throw notFound("logo");
  }
}
