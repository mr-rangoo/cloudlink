import { describe, expect, it, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { db } from "@/server/db/client";
import { resetStorageForTests } from "@/server/integrations/storage";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { createManualInvoice, invoiceCreateInput } from "@/server/services/invoices";
import { manualPaymentInput, recordManualPayment } from "@/server/services/payments";
import { activatePortalAccount, createPortalInviteLink, portalLogin, resolveCustomerContext, sendPortalInvite, setPortalAccess } from "@/server/portal/auth";
import { addAttachment, addCustomerComment, addStaffComment, createCustomerTicket, createTicket, getCustomerTicket, readAttachment, updateTicket } from "@/server/services/tickets";
import { savePreferences } from "@/server/services/notifications";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { staffAlerts } from "@/server/services/alerts";
import { GET as customerInvoiceRoute } from "@/app/api/v1/customer/invoices/[id]/route";
import { GET as customerMeRoute } from "@/app/api/v1/customer/me/route";
import { GET as customerReceiptRoute } from "@/app/api/v1/customer/receipts/[id]/route";
import { GET as staffInvoicesRoute } from "@/app/api/v1/invoices/route";
import { contextFor, createOrg, request } from "./fixtures";

const meta = { correlationId: "portal-test-01", ipAddress: "10.9.0.1", userAgent: "vitest" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let seq = 0;
const tel = () => `07${String(20_000_000 + seq++).padStart(8, "0")}`;

beforeAll(() => {
  resetStorageForTests(mkdtempSync(path.join(os.tmpdir(), "cloudlink-test-storage-")));
});

async function runAllOps() {
  const ops = await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED"] } } });
  for (const op of ops) await runOperation(op.id, operationHandlers);
}

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, { name: "Fibre", serviceType: "PPPOE", price: "2000.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
  const mk = async (name: string, email?: string) => (await createSubscriber(ctx, subscriberInput.parse({ firstName: name, phone: tel(), email, packageId: pkg.id }))).subscriber;
  return { org, ctx, mk };
}

async function activateCustomer(ctx: Awaited<ReturnType<typeof contextFor>>, subscriberId: string, password = "Portal-Pass-123") {
  const { link } = await createPortalInviteLink(ctx, subscriberId);
  const token = new URL(link).searchParams.get("token")!;
  await activatePortalAccount({ token, password }, meta);
  return token;
}

describe("customer portal authentication", () => {
  it("activates with a single-use link, then logs in by phone or account number", async () => {
    const { org, ctx, mk } = await setup();
    const sub = await mk("Asha");
    const { link } = await createPortalInviteLink(ctx, sub.id);
    expect(link).toContain(`/portal/${org.organization.slug}/activate?token=`);
    const token = new URL(link).searchParams.get("token")!;
    const account = await db.customerAccount.findUniqueOrThrow({ where: { subscriberId: sub.id } });
    expect(account.inviteTokenHash).not.toContain(token); // only a hash is stored
    await activatePortalAccount({ token, password: "Portal-Pass-123" }, meta);
    await expect(activatePortalAccount({ token, password: "Another-Pass-123" }, meta)).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // single use

    const byPhone = await portalLogin({ organization: org.organization.slug, identifier: sub.phone.replace(/^254/, "0"), password: "Portal-Pass-123" }, meta);
    const byAccount = await portalLogin({ organization: org.organization.slug, identifier: sub.accountNumber.toLowerCase(), password: "Portal-Pass-123" }, meta);
    const cctx = await resolveCustomerContext(byPhone.token, meta);
    expect(cctx?.subscriberId).toBe(sub.id);
    expect((await resolveCustomerContext(byAccount.token, meta))?.subscriberId).toBe(sub.id);
    await expect(portalLogin({ organization: org.organization.slug, identifier: sub.phone, password: "wrong" }, meta)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(portalLogin({ organization: "other-org", identifier: sub.phone, password: "Portal-Pass-123" }, meta)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("disabling access revokes sessions and blocks login", async () => {
    const { org, ctx, mk } = await setup();
    const sub = await mk("Ben");
    await activateCustomer(ctx, sub.id);
    const { token } = await portalLogin({ organization: org.organization.slug, identifier: sub.phone, password: "Portal-Pass-123" }, meta);
    await setPortalAccess(ctx, sub.id, false);
    expect(await resolveCustomerContext(token, meta)).toBeNull();
    await expect(portalLogin({ organization: org.organization.slug, identifier: sub.phone, password: "Portal-Pass-123" }, meta)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects expired invite links", async () => {
    const { ctx, mk } = await setup();
    const sub = await mk("Cara");
    const { link } = await createPortalInviteLink(ctx, sub.id);
    await db.customerAccount.update({ where: { subscriberId: sub.id }, data: { inviteExpiresAt: new Date(Date.now() - 1000) } });
    await expect(activatePortalAccount({ token: new URL(link).searchParams.get("token")!, password: "Portal-Pass-123" }, meta)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("customer data isolation", () => {
  it("shows a customer only their own invoices, receipts and tickets (other ids return 404)", async () => {
    const { org, ctx, mk } = await setup();
    const a = await mk("Alice");
    const b = await mk("Bob");
    await activateCustomer(ctx, a.id);
    const { token } = await portalLogin({ organization: org.organization.slug, identifier: a.phone, password: "Portal-Pass-123" }, meta);
    const invB = await db.invoice.findFirstOrThrow({ where: { subscriberId: b.id } });
    const { payment: payB } = await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: b.id, amount: "100", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));

    const me = await (await customerMeRoute(request("/api/v1/customer/me", { portalToken: token }), { params: Promise.resolve({}) })).json();
    expect(me.data.subscriber.accountNumber).toBe(a.accountNumber);
    expect(me.data.openInvoices).toHaveLength(1);

    const res = await customerInvoiceRoute(request(`/api/v1/customer/invoices/${invB.id}`, { portalToken: token }), { params: Promise.resolve({ id: invB.id }) });
    expect(res.status).toBe(404);
    const rec = await customerReceiptRoute(request(`/api/v1/customer/receipts/${payB.id}`, { portalToken: token }), { params: Promise.resolve({ id: payB.id }) });
    expect(rec.status).toBe(404);

    const ticketB = await createTicket(ctx, { subscriberId: b.id, subject: "B issue", description: "private", category: "OTHER", priority: "NORMAL", channel: "phone" });
    const cctx = (await resolveCustomerContext(token, meta))!;
    await expect(getCustomerTicket(cctx, ticketB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addCustomerComment(cctx, ticketB.id, "hi")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not let a customer session call staff endpoints", async () => {
    const { org, ctx, mk } = await setup();
    const a = await mk("Dana");
    await activateCustomer(ctx, a.id);
    const { token } = await portalLogin({ organization: org.organization.slug, identifier: a.phone, password: "Portal-Pass-123" }, meta);
    const res = await staffInvoicesRoute(request("/api/v1/invoices", { portalToken: token }), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });
});

describe("support tickets", () => {
  it("runs the ticket lifecycle with internal notes hidden from the customer", async () => {
    const { org, ctx, mk } = await setup();
    const a = await mk("Eve", "eve@example.test");
    await activateCustomer(ctx, a.id);
    const cctx = (await resolveCustomerContext((await portalLogin({ organization: org.organization.slug, identifier: a.phone, password: "Portal-Pass-123" }, meta)).token, meta))!;

    const t = await createCustomerTicket(cctx, { subject: "No internet", description: "Red LOS light since morning", category: "CONNECTIVITY" });
    expect(t.ticketNumber).toBe("TKT-000001");
    expect(t.priority).toBe("HIGH");
    await addStaffComment(ctx, t.id, { body: "Checking the OLT port", internal: true });
    await addStaffComment(ctx, t.id, { body: "A technician is on the way", internal: false });
    let view = await getCustomerTicket(cctx, t.id);
    expect(view.comments.map((c) => c.body)).toEqual(["A technician is on the way"]);
    expect(view.status).toBe("IN_PROGRESS");

    await expect(updateTicket(ctx, t.id, { status: "RESOLVED" } as never)).rejects.toThrow();
    await updateTicket(ctx, t.id, { status: "RESOLVED", resolution: "Replaced patch cord" });
    await addCustomerComment(cctx, t.id, "Still down again");
    view = await getCustomerTicket(cctx, t.id);
    expect(view.status).toBe("OPEN"); // reopened
    const events = await db.ticketEvent.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["created", "status_changed", "resolved", "reopened"]);

    // Notifications: public reply + resolution queued to SMS and email; internal note queued nothing.
    const notes = await db.notification.findMany({ where: { subscriberId: a.id, templateKey: { in: ["ticket.reply", "ticket.resolved"] } } });
    expect(notes.map((n) => `${n.templateKey}:${n.channel}`).sort()).toEqual(["ticket.reply:EMAIL", "ticket.reply:SMS", "ticket.resolved:EMAIL", "ticket.resolved:SMS"]);
  });

  it("validates attachments by content and enforces ownership on download", async () => {
    const { org, ctx, mk } = await setup();
    const a = await mk("Fay");
    const b = await mk("Gus");
    await activateCustomer(ctx, a.id);
    await activateCustomer(ctx, b.id);
    const ca = (await resolveCustomerContext((await portalLogin({ organization: org.organization.slug, identifier: a.phone, password: "Portal-Pass-123" }, meta)).token, meta))!;
    const cb = (await resolveCustomerContext((await portalLogin({ organization: org.organization.slug, identifier: b.phone, password: "Portal-Pass-123" }, meta)).token, meta))!;
    const t = await createCustomerTicket(ca, { subject: "Router", description: "Photo attached", category: "EQUIPMENT" });

    await expect(addAttachment(ca, t.id, { name: "evil.png", data: Buffer.from("MZ\u0090\u0000binary") })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(addAttachment(ca, t.id, { name: "big.txt", data: Buffer.alloc(6 * 1024 * 1024, 97) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const att = await addAttachment(ca, t.id, { name: "../../router photo.png", data: PNG });
    expect(att.contentType).toBe("image/png");
    expect(att.fileName).toBe("router photo.png");
    expect((await readAttachment(ca, att.id)).data.equals(PNG)).toBe(true);
    expect((await readAttachment(ctx, att.id)).data.equals(PNG)).toBe(true);
    await expect(readAttachment(cb, att.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addAttachment(cb, t.id, { name: "x.png", data: PNG })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("notifications", () => {
  it("queues one invoice notice per channel, honours opt-outs, and delivers via the mock adapter as simulated", async () => {
    const { ctx, mk } = await setup();
    const a = await mk("Hana", "hana@example.test");
    const activation = await db.notification.findMany({ where: { subscriberId: a.id, templateKey: "invoice.issued" } });
    expect(activation.map((n) => n.channel).sort()).toEqual(["EMAIL", "SMS"]);
    expect(activation[0]!.body).toMatch(/KES 2,000\.00/);

    await savePreferences(ctx.organizationId, a.id, { preferences: [{ category: "billing", channel: "SMS", enabled: false }] });
    await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: a.id, lines: [{ description: "Router", quantity: "1", unitPrice: "3000" }] }));
    const second = await db.notification.findMany({ where: { subscriberId: a.id, templateKey: "invoice.issued" }, orderBy: { createdAt: "desc" }, take: 2 });
    expect(second.find((n) => n.channel === "SMS")?.status).toBe("SKIPPED");
    expect(second.find((n) => n.channel === "SMS")?.lastError).toBe("OPTED_OUT");

    await runAllOps();
    const sent = await db.notification.findMany({ where: { subscriberId: a.id, status: "SENT" } });
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.every((n) => n.simulated && n.providerMessageId?.startsWith("mock-"))).toBe(true);
  });

  it("skips (never fakes) delivery when no provider is configured", async () => {
    const { mk } = await setup();
    const prev = process.env.MESSAGING_ADAPTER;
    process.env.MESSAGING_ADAPTER = "smtp"; // SMTP_HOST unset → email not configured; no SMS provider either
    try {
      const a = await mk("Ivan", "ivan@example.test");
      await runAllOps();
      const rows = await db.notification.findMany({ where: { subscriberId: a.id } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((n) => n.status === "SKIPPED" && /NOT_CONFIGURED/.test(n.lastError ?? ""))).toBe(true);
    } finally {
      process.env.MESSAGING_ADAPTER = prev;
    }
  });

  it("mints the portal invite token at send time and never stores the link", async () => {
    const { ctx, mk } = await setup();
    const a = await mk("Jade");
    await sendPortalInvite(ctx, a.id);
    const queued = await db.notification.findFirstOrThrow({ where: { subscriberId: a.id, templateKey: "portal.invite" } });
    expect(queued.body).toContain("{{link}}");
    await runAllOps();
    const sent = await db.notification.findUniqueOrThrow({ where: { id: queued.id } });
    expect(sent.status).toBe("SENT");
    expect(sent.body).toContain("[secure link sent - not stored]");
    expect(sent.body).not.toMatch(/token=/);
    const account = await db.customerAccount.findUniqueOrThrow({ where: { subscriberId: a.id } });
    expect(account.inviteTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends a payment confirmation with receipt and balance", async () => {
    const { ctx, mk } = await setup();
    const a = await mk("Kofi");
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: a.id, amount: "500", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const n = await db.notification.findFirstOrThrow({ where: { subscriberId: a.id, templateKey: "payment.received", channel: "SMS" } });
    expect(n.body).toMatch(/KES 500\.00/);
    expect(n.body).toMatch(/RCT-\d{6}/);
    expect(n.body).toMatch(/KES 1,500\.00 due/);
  });
});

describe("staff alerts", () => {
  it("reports real attention items filtered by permission", async () => {
    const { ctx } = await setup();
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: null, amount: "100", method: "BANK_TRANSFER", reference: "UNKN-1", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    await createTicket(ctx, { subject: "Fibre cut", description: "Area outage", category: "CONNECTIVITY", priority: "URGENT", channel: "phone" });
    const alerts = await staffAlerts(ctx);
    expect(alerts.map((a) => a.key)).toEqual(expect.arrayContaining(["unmatched", "urgent-unassigned"]));
  });
});
