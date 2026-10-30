import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { manualPaymentInput, recordManualPayment } from "@/server/services/payments";
import { expireDueSubscriptions, remindExpiringSubscriptions } from "@/server/services/subscriptions";
import { checkSmsBalance, confirmTestReceived, getMessagingSettings, saveEmailSettings, saveSmsSettings, sendTestMessage } from "@/server/services/messaging-config";
import { batchInput, generateBatch, redeemVoucher, sendVoucherBySms } from "@/server/services/vouchers";
import { systemContext } from "@/server/auth/context";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { FakeSmsApi, FakeSmtp } from "../support/fake-messaging";
import { contextFor, createOrg, createStaff } from "./fixtures";

const sms = new FakeSmsApi();
const smtp = new FakeSmtp();
const ENV = ["MESSAGING_ADAPTER", "MESSAGING_TEST_BASE_URL", "APP_ENV"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
let phoneSeq = 0;
const nextPhone = () => `07${String(74_000_000 + phoneSeq++).padStart(8, "0")}`;

beforeAll(async () => {
  process.env.MESSAGING_TEST_BASE_URL = await sms.start();
  await smtp.start();
});
afterAll(async () => {
  await sms.stop();
  await smtp.stop();
});
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MESSAGING_ADAPTER = "live";
  process.env.MESSAGING_TEST_BASE_URL = `http://127.0.0.1:${sms.port}`;
  sms.reset();
  smtp.messages.length = 0;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function drain() {
  for (let i = 0; i < 5; i++) {
    const due = await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED"] }, type: "notifications.send" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  await saveSmsSettings(ctx, { provider: "africastalking", username: "cloudlinkisp", senderId: "CLOUDLINK", apiKey: sms.apiKey });
  return { org, ctx };
}

describe("messaging providers per organization", () => {
  it("stores credentials encrypted, sends a test through the provider, and verifies only after confirmation", async () => {
    const { org, ctx } = await setup();
    const row = await db.integrationConfiguration.findFirstOrThrow({ where: { organizationId: org.organization.id, provider: "sms" } });
    expect(JSON.stringify(row.safeConfig)).not.toContain(sms.apiKey);
    expect(row.encryptedSecret).not.toContain(sms.apiKey);
    const view = await getMessagingSettings(ctx);
    expect(JSON.stringify(view)).not.toContain(sms.apiKey);
    expect(view.sms).toMatchObject({ provider: "africastalking", username: "cloudlinkisp", senderId: "CLOUDLINK", credentialsSet: true, status: "NOT_CONFIGURED", inUse: { provider: "africastalking", source: "integration", available: true } });

    const test = await sendTestMessage(ctx, { channel: "SMS", to: "0712 345 678" });
    expect(test).toMatchObject({ accepted: true, simulated: false, source: "integration", provider: "africastalking" });
    expect(sms.sends()).toEqual([expect.objectContaining({ path: "/version1/messaging", form: expect.objectContaining({ username: "cloudlinkisp", to: "+254712345678", from: "CLOUDLINK" }) })]);
    expect((await getMessagingSettings(ctx)).sms.status).toBe("NOT_CONFIGURED"); // accepted is not delivered
    expect((await confirmTestReceived(ctx, "SMS")).sms.status).toBe("PRODUCTION_VERIFIED");

    // Changing the sender resets verification; keeping the stored key works.
    await saveSmsSettings(ctx, { provider: "africastalking", username: "cloudlinkisp", senderId: "NEWSENDER" });
    expect((await getMessagingSettings(ctx)).sms).toMatchObject({ status: "NOT_CONFIGURED", credentialsSet: true, lastTest: null });
    await expect(saveSmsSettings(ctx, { provider: "twilio", accountSid: sms.twilio.sid, from: "+15005550006" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(await checkSmsBalance(ctx)).toMatchObject({ amount: "1234.50", currency: "KES", source: "integration" });
    expect((await getMessagingSettings(ctx)).sms.lastBalance).toMatchObject({ amount: "1234.50", currency: "KES" });

    const support = await createStaff(org.organization.id, "support");
    await expect(saveSmsSettings(await contextFor(support.user.id, org.organization.id), { provider: "africastalking", username: "x1", apiKey: "y".repeat(12) })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("supports Twilio, reports rejections honestly, and fails deliveries the provider refuses", async () => {
    const { org, ctx } = await setup();
    await saveSmsSettings(ctx, { provider: "twilio", accountSid: sms.twilio.sid, from: "+15005550006", authToken: sms.twilio.token });
    expect(await sendTestMessage(ctx, { channel: "SMS", to: "0712000111" })).toMatchObject({ accepted: true, provider: "twilio" });
    expect(sms.sends().at(-1)).toMatchObject({ path: `/2010-04-01/Accounts/${sms.twilio.sid}/Messages.json`, form: { To: "+254712000111", From: "+15005550006", Body: expect.stringContaining("test message") } });
    expect(await checkSmsBalance(ctx)).toMatchObject({ amount: "12.34", currency: "USD" });

    sms.failNext = 400;
    const rejected = await sendTestMessage(ctx, { channel: "SMS", to: "0712000111" });
    expect(rejected).toMatchObject({ accepted: false, error: expect.stringContaining("21211") });
    await expect(confirmTestReceived(ctx, "SMS")).rejects.toMatchObject({ code: "INVALID_STATE" });

    // A queued notification goes through the organization's provider; a refusal is final, not "sent".
    const pkg = await createPackage(ctx, { name: "Fibre 5", serviceType: "PPPOE", price: "1500.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Njeri", phone: nextPhone(), packageId: pkg.id, activateSubscription: true }));
    sms.failNext = 401;
    await drain();
    const notes = await db.notification.findMany({ where: { subscriberId: subscriber.id, channel: "SMS" }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => n.templateKey)).toEqual(expect.arrayContaining(["subscriber.welcome", "invoice.issued"]));
    expect(notes.filter((n) => n.status === "FAILED")).toHaveLength(1);
    expect(notes.filter((n) => n.status === "SENT").every((n) => n.provider === "twilio" && !n.simulated)).toBe(true);
    expect(org.organization.id).toBeTruthy();
  });

  it("sends email through the organization's SMTP server, and refuses private servers in production", async () => {
    const { ctx } = await setup();
    await saveEmailSettings(ctx, { host: "127.0.0.1", port: smtp.port, security: "none", username: "mailer", password: "smtp-pass-1", fromAddress: "billing@isp.example", fromName: "Test ISP" });
    expect(JSON.stringify(await getMessagingSettings(ctx))).not.toContain("smtp-pass-1");
    expect(await sendTestMessage(ctx, { channel: "EMAIL", to: "Owner@Example.com" })).toMatchObject({ accepted: true, provider: "smtp" });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toMatchObject({ from: "billing@isp.example", to: ["owner@example.com"], auth: "\u0000mailer\u0000smtp-pass-1" });
    expect(smtp.messages[0]!.data).toContain("Cloudlink test message");

    process.env.APP_ENV = "production";
    const refused = await sendTestMessage(ctx, { channel: "EMAIL", to: "owner@example.com" });
    expect(refused).toMatchObject({ accepted: false });
    expect(smtp.messages).toHaveLength(1);
    await expect(saveEmailSettings(ctx, { host: "smtp.example.com", port: 25, security: "none", fromAddress: "a@b.example" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("uses the mock adapter in development whatever is saved, and skips when nothing is configured", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    expect(await sendTestMessage(ctx, { channel: "SMS", to: "0712345678" }).catch((e) => e)).toMatchObject({ code: "INVALID_STATE" });
    process.env.MESSAGING_ADAPTER = "mock";
    expect(await sendTestMessage(ctx, { channel: "SMS", to: "0712345678" })).toMatchObject({ accepted: true, simulated: true, source: "mock" });
    expect(sms.sends()).toHaveLength(0);
  });
});

describe("service messages", () => {
  it("welcome on staff-created accounts, credit saved on overpayment, expired and reminders for long plans only", async () => {
    const { org, ctx } = await setup();
    const monthly = await createPackage(ctx, { name: "Home 10", serviceType: "PPPOE", price: "2000.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
    const hourly = await createPackage(ctx, { name: "Hour pass", serviceType: "HOTSPOT", price: "20.00", taxRate: "0", billingUnit: "HOUR", billingCount: 1, description: null });
    const a = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Achieng", phone: nextPhone(), packageId: monthly.id, activateSubscription: true }));
    const b = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Baraka", phone: nextPhone(), packageId: hourly.id, activateSubscription: true }));
    const keys = async (subscriberId: string) => (await db.notification.findMany({ where: { subscriberId, channel: "SMS" }, orderBy: { createdAt: "asc" } })).map((n) => n.templateKey);
    expect(await keys(a.subscriber.id)).toContain("subscriber.welcome");

    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: a.subscriber.id, amount: "2500", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const credit = await db.notification.findFirstOrThrow({ where: { subscriberId: a.subscriber.id, templateKey: "credit.saved", channel: "SMS" } });
    expect(credit.body).toContain("KES 500.00");

    // Reminder: the monthly plan ends in 2 days; the hourly one never gets reminders or "ended" messages.
    const soon = new Date(Date.now() + 2 * 86_400_000);
    await db.subscription.update({ where: { id: a.subscription!.id }, data: { currentPeriodEnd: soon } });
    expect(await remindExpiringSubscriptions(org.organization.id)).toEqual({ reminded: 1 });
    expect(await remindExpiringSubscriptions(org.organization.id)).toEqual({ reminded: 0 }); // once per period
    await db.billingSettings.update({ where: { organizationId: org.organization.id }, data: { expiryReminderDays: 0 } });
    await db.notification.deleteMany({ where: { templateKey: "subscription.expiring" } });
    expect(await remindExpiringSubscriptions(org.organization.id)).toEqual({ reminded: 0 });

    const past = new Date(Date.now() - 60_000);
    for (const id of [a.subscription!.id, b.subscription!.id]) await db.subscription.update({ where: { id }, data: { currentPeriodStart: new Date(past.getTime() - 3_600_000), currentPeriodEnd: past } });
    expect(await expireDueSubscriptions(org.organization.id, systemContext(org.organization.id, "test", "test-expire"))).toBe(2);
    expect(await keys(a.subscriber.id)).toContain("subscription.expired");
    expect(await keys(b.subscriber.id)).not.toContain("subscription.expired");

    await drain();
    expect(sms.sends().map((r) => r.form.message).join("\n")).toContain("Welcome to");
  });

  it("texts a voucher code without storing it, and only while the voucher is unused", async () => {
    const { org, ctx } = await setup();
    const pkg = await createPackage(ctx, { name: "Day pass", serviceType: "HOTSPOT", price: "50.00", taxRate: "0", billingUnit: "DAY", billingCount: 1, description: null });
    const { batch, codes } = await generateBatch(ctx, batchInput.parse({ packageId: pkg.id, quantity: 2 }));
    const vouchers = await db.voucher.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: "asc" } });
    const first = vouchers.find((v) => codes[0]!.endsWith(v.codeHint))!;

    const sent = await sendVoucherBySms(ctx, first.id, { phone: "0711 222 333" });
    expect(sent.status).toBe("QUEUED");
    await drain();
    const n = await db.notification.findUniqueOrThrow({ where: { id: sent.notificationId } });
    expect(n).toMatchObject({ status: "SENT", recipient: "254711222333", templateKey: "voucher.delivery" });
    expect(n.body).not.toContain(codes.find((c) => c.endsWith(first.codeHint))!);
    expect(n.body).toContain("[voucher code sent - not stored]");
    const delivered = sms.sends().at(-1)!.form.message!;
    expect(codes.some((c) => delivered.includes(c))).toBe(true);
    expect(await db.auditLog.count({ where: { action: "voucher.send_sms", entityId: first.id } })).toBe(1);

    // Redeemed between queuing and sending: the message fails instead of leaking a used code.
    const second = vouchers.find((v) => v.id !== first.id)!;
    const queued = await sendVoucherBySms(ctx, second.id, { phone: "0711222333" });
    const secondCode = codes.find((c) => c.endsWith(second.codeHint))!;
    await redeemVoucher(ctx, { code: secondCode }, "staff");
    await drain();
    expect(await db.notification.findUniqueOrThrow({ where: { id: queued.notificationId } })).toMatchObject({ status: "FAILED", lastError: "VOUCHER_UNAVAILABLE" });
    await expect(sendVoucherBySms(ctx, second.id, { phone: "0711222333" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const support = await createStaff(org.organization.id, "support");
    await expect(sendVoucherBySms(await contextFor(support.user.id, org.organization.id), first.id, { phone: "0711222333" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
