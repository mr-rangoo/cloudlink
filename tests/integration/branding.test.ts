import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { resetStorageForTests } from "@/server/integrations/storage";
import { brandingFor, brandingForSlug, removeLogo, updateBranding, uploadLogo } from "@/server/services/branding";
import { activePaymentInstructions, createPaymentMethod, deletePaymentMethod, listPaymentMethods, replacePaymentMethod, updatePaymentMethod } from "@/server/services/payment-methods";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { invoicePdf } from "@/server/services/documents";
import { GET as logoRoute } from "@/app/api/v1/branding/[slug]/logo/route";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { contextFor, createOrg, createStaff, request, TEST_PASSWORD } from "./fixtures";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(() => {
  resetStorageForTests(mkdtempSync(path.join(os.tmpdir(), "cloudlink-test-branding-")));
});

describe("branding and themes", () => {
  it("applies a preset or a readable brand colour, and rejects colours that would be hard to read", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const initial = await brandingFor(org.organization.id);
    expect(initial).toMatchObject({ themePreset: "midnight", customAccent: null, defaultMode: "light", logoUrl: null });
    expect(initial.css).toContain(":root{--accent:#1d6fe8");

    const forest = await updateBranding(ctx, { themePreset: "forest", defaultMode: "dark", portalWelcome: "Karibu!", supportHours: "Mon–Sat 8–8" });
    expect(forest.css).toContain("--accent:#15803d");
    expect(forest).toMatchObject({ defaultMode: "dark", portalWelcome: "Karibu!", supportHours: "Mon–Sat 8–8" });

    const brand = await updateBranding(ctx, { themePreset: "forest", customAccent: "#0B6E4F", defaultMode: "system" });
    expect(brand.customAccent).toBe("#0b6e4f");
    expect(brand.css).toContain("--accent:#0b6e4f");
    expect(brand.css).toContain("--sidebar:#0b1c14"); // keeps the preset's sidebar

    await expect(updateBranding(ctx, { themePreset: "forest", customAccent: "#ffe066", defaultMode: "light" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(updateBranding(ctx, { themePreset: "not-a-theme", defaultMode: "light" })).rejects.toThrow();
    expect(await db.auditLog.count({ where: { action: "settings.branding.update", organizationId: org.organization.id } })).toBe(2);

    const support = await createStaff(org.organization.id, "support");
    await expect(updateBranding(await contextFor(support.user.id, org.organization.id), { themePreset: "plum", defaultMode: "light" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts only real PNG/JPEG/WebP logos and serves them publicly by organization", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    await expect(uploadLogo(ctx, { name: "logo.svg", data: Buffer.from("<svg onload=alert(1)></svg>") })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(uploadLogo(ctx, { name: "big.png", data: Buffer.concat([PNG, Buffer.alloc(600 * 1024)]) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const b = await uploadLogo(ctx, { name: "logo.png", data: PNG });
    expect(b.logoUrl).toMatch(new RegExp(`^/api/v1/branding/${org.organization.slug}/logo\\?v=\\d+$`));

    const res = await logoRoute(request(`/api/v1/branding/${org.organization.slug}/logo`, { origin: null }), { params: Promise.resolve({ slug: org.organization.slug }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await brandingForSlug(org.organization.slug))?.logoUrl).toBe(b.logoUrl);
    await removeLogo(ctx);
    const gone = await logoRoute(request(`/api/v1/branding/${org.organization.slug}/logo`, { origin: null }), { params: Promise.resolve({ slug: org.organization.slug }) });
    expect(gone.status).toBe(404);
    expect((await logoRoute(request("/api/v1/branding/../x/logo", { origin: null }), { params: Promise.resolve({ slug: "../x" }) })).status).toBe(404);
  });

  it("signs people in with the organization's default appearance unless they chose one", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    await updateBranding(ctx, { themePreset: "ocean", defaultMode: "dark" });
    const fresh = await loginRoute(request("/api/v1/auth/login", { body: { email: org.owner.email, password: TEST_PASSWORD } }), { params: Promise.resolve({}) });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("set-cookie")).toMatch(/cloudlink_theme=dark/);
    const chosen = await loginRoute(request("/api/v1/auth/login", { body: { email: org.owner.email, password: TEST_PASSWORD }, headers: { cookie: "cloudlink_theme=light" } }), { params: Promise.resolve({}) });
    expect(chosen.headers.get("set-cookie") ?? "").not.toMatch(/cloudlink_theme=/);
  });
});

describe("customer payment methods", () => {
  it("stores each kind, personalises instructions, hides inactive ones and stays within the organization", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const paybill = await createPaymentMethod(ctx, { kind: "MPESA_PAYBILL", paybill: "522533" });
    const till = await createPaymentMethod(ctx, { kind: "MPESA_TILL", till: "5234567", label: "Shop till" });
    const bank = await createPaymentMethod(ctx, { kind: "BANK", bankName: "Equity Bank", accountName: "Skyline Fibre Ltd", accountNumber: "0123456789", branch: "Westlands", swiftCode: "eqblkena" });
    await createPaymentMethod(ctx, { kind: "CASH", location: "Kimathi Street, 2nd floor, Mon–Sat 8–6" });
    await createPaymentMethod(ctx, { kind: "OTHER", label: "Agent", instructions: "Pay any Skyline agent and keep the receipt." });
    await expect(createPaymentMethod(ctx, { kind: "MPESA_PAYBILL", paybill: "12" })).rejects.toThrow(/5–7 digits/);
    await expect(createPaymentMethod(ctx, { kind: "OTHER", label: "x" } as never)).rejects.toThrow();

    const list = await activePaymentInstructions(org.organization.id, "A000042");
    expect(list.map((m) => m.label)).toEqual(["M-Pesa Paybill", "Shop till", "Bank transfer", "Cash at our office", "Agent"]);
    expect(list[0]!.lines).toEqual(["M-Pesa → Lipa na M-Pesa → Pay Bill", "Business number: 522533", "Account number: A000042"]);
    expect(list[2]!.lines).toContain("SWIFT: EQBLKENA");
    expect(list[2]!.lines).toContain("Reference: A000042");

    await updatePaymentMethod(ctx, till.id, { active: false });
    await updatePaymentMethod(ctx, bank.id, { sortOrder: 0 });
    await updatePaymentMethod(ctx, paybill.id, { sortOrder: 1 });
    expect((await activePaymentInstructions(org.organization.id, "A1")).map((m) => m.label)).toEqual(["Bank transfer", "M-Pesa Paybill", "Cash at our office", "Agent"]);
    await replacePaymentMethod(ctx, paybill.id, { kind: "MPESA_PAYBILL", paybill: "400200", instructions: "Use your account number exactly." });
    expect((await listPaymentMethods(ctx)).find((m) => m.id === paybill.id)?.details).toEqual({ paybill: "400200" });
    await deletePaymentMethod(ctx, till.id);
    expect(await db.customerPaymentMethod.count({ where: { organizationId: org.organization.id } })).toBe(4);

    // Invoice PDFs include the instructions and still render.
    const pkg = await createPackage(ctx, packageInput.parse({ name: "Home", serviceType: "PPPOE", price: "1500.00", billingUnit: "MONTH", billingCount: 1 }));
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Mwangi", phone: "0711222333", packageId: pkg.id, activateSubscription: true }));
    const invoice = await db.invoice.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    const { pdf } = await invoicePdf(ctx, invoice.id);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    const other = await createOrg("Other ISP");
    const otherCtx = await contextFor(other.owner.id, other.organization.id);
    await expect(updatePaymentMethod(otherCtx, bank.id, { active: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deletePaymentMethod(otherCtx, bank.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await activePaymentInstructions(other.organization.id, "A1")).toEqual([]);
  });
});
