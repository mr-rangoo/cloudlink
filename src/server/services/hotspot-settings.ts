import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { normalizePhone } from "@/server/domain/contact";
import { DEFAULT_TEMPLATE, PORTAL_TEMPLATES } from "@/lib/portal-templates";

/** Captive portal look and content. The portal reads it without a session (it holds nothing secret). */

const optionalPhone = z
  .union([z.string().trim(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: "custom", message: "Enter a phone number such as 0712 345 678 or +254 712 345 678." });
    return n;
  });

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null));

export const hotspotSettingsInput = z.object({
  template: z.enum(PORTAL_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
  headline: optionalText(160),
  instructions: optionalText(1500),
  supportPhone: optionalPhone,
  whatsappPhone: optionalPhone,
  showVouchers: z.boolean().default(true),
  showReconnect: z.boolean().default(true),
});

export interface HotspotSettingsView {
  template: string;
  headline: string | null;
  instructions: string | null;
  supportPhone: string | null;
  whatsappPhone: string | null;
  showVouchers: boolean;
  showReconnect: boolean;
}

const DEFAULTS: HotspotSettingsView = { template: DEFAULT_TEMPLATE, headline: null, instructions: null, supportPhone: null, whatsappPhone: null, showVouchers: true, showReconnect: true };

export async function hotspotSettingsFor(organizationId: string): Promise<HotspotSettingsView> {
  const row = await db.hotspotSettings.findUnique({ where: { organizationId } });
  if (!row) return DEFAULTS;
  return { template: row.template, headline: row.headline, instructions: row.instructions, supportPhone: row.supportPhone, whatsappPhone: row.whatsappPhone, showVouchers: row.showVouchers, showReconnect: row.showReconnect };
}

export async function getHotspotSettings(ctx: StaffContext) {
  requirePermission(ctx, "settings.write");
  return hotspotSettingsFor(ctx.organizationId);
}

export async function saveHotspotSettings(ctx: StaffContext, raw: z.input<typeof hotspotSettingsInput>) {
  requirePermission(ctx, "settings.write");
  const input = hotspotSettingsInput.parse(raw);
  const data = {
    template: input.template,
    headline: input.headline ?? null,
    instructions: input.instructions ?? null,
    supportPhone: input.supportPhone ?? null,
    whatsappPhone: input.whatsappPhone ?? null,
    showVouchers: input.showVouchers,
    showReconnect: input.showReconnect,
  };
  await db.hotspotSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
  await audit(ctx, { action: "settings.hotspot.update", entityType: "organization", entityId: ctx.organizationId, metadata: { template: data.template, showVouchers: data.showVouchers, showReconnect: data.showReconnect } });
  return hotspotSettingsFor(ctx.organizationId);
}
