import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { expireDueSubscriptions } from "@/server/services/subscriptions";
import { systemContext } from "@/server/auth/context";
import { getMpesaSettings, registerC2bUrls, saveMpesaSettings, testMpesaCredentials } from "@/server/services/mpesa-config";
import { getAttempt, getCustomerAttempt, initiateCustomerPayment, initiateStkPush, listAttempts, runStatusQuery, simulateMockResponse } from "@/server/services/mobile-money";
import { listPayments, manualPaymentInput, recordManualPayment } from "@/server/services/payments";
import { runReconciliationChecks } from "@/server/services/finance";
import { integrationStatus } from "@/server/services/integrations";
import { createRouter } from "@/server/services/routers";
import { provisionSubscriptionNetwork } from "@/server/services/network";
import { createPortalInviteLink, activatePortalAccount, portalLogin, resolveCustomerContext } from "@/server/portal/auth";
import { clearDarajaTokenCache } from "@/server/integrations/payments/daraja";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { POST as stkCallbackRoute } from "@/app/api/v1/webhooks/mobile-money/stk/[token]/route";
import { POST as c2bConfirmRoute } from "@/app/api/v1/webhooks/mobile-money/c2b/[token]/confirmation/route";
import { POST as c2bValidateRoute } from "@/app/api/v1/webhooks/mobile-money/c2b/[token]/validation/route";
import { POST as customerPayRoute } from "@/app/api/v1/customer/payments/route";
import { FakeDaraja } from "../support/fake-daraja";
import { contextFor, createOrg, createStaff, request } from "./fixtures";

const fake = new FakeDaraja();
let baseUrl = "";
let seq = 0;
const tel = () => `07${String(40_000_000 + seq++).padStart(8, "0")}`;
const meta = { correlationId: "mpesa-test-0001", ipAddress: "10.9.0.1", userAgent: "vitest" };
const KEYS = ["PAYMENT_ADAPTER", "MPESA_BASE_URL", "MPESA_VERIFY_CALLBACKS", "MPESA_CALLBACK_ALLOWED_IPS", "NETWORK_ADAPTER", "APP_ENV"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  baseUrl = await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PAYMENT_ADAPTER = "daraja";
  process.env.MPESA_BASE_URL = baseUrl;
  process.env.MPESA_VERIFY_CALLBACKS = "true";
  process.env.MPESA_CALLBACK_ALLOWED_IPS = "";
  process.env.NETWORK_ADAPTER = "mock";
  fake.reset();
  clearDarajaTokenCache();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function setup(opts: { configure?: boolean; price?: string } = {}) {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: opts.price ?? "1500.00", billingUnit: "MONTH", billingCount: 1 }));
  const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Wanjiru", phone: tel(), packageId: pkg.id, activateSubscription: true }));
  const invoice = await db.invoice.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
  if (opts.configure !== false) {
    await saveMpesaSettings(ctx, { environment: "sandbox", type: "PAYBILL", shortcode: fake.shortcode, consumerKey: fake.consumerKey, consumerSecret: fake.consumerSecret, passkey: fake.passkey });
  }
  return { org, ctx, subscriber, subscription: subscription!, invoice };
}

const lastRequest = () => fake.stkRequests.at(-1)!;
const tokenOf = (callbackUrl: string) => new URL(callbackUrl).pathname.split("/").pop()!;

async function postCallback(callbackUrl: string, body: unknown, ip = "196.201.214.200") {
  const token = tokenOf(callbackUrl);
  const res = await stkCallbackRoute(request(`/api/v1/webhooks/mobile-money/stk/${token}`, { method: "POST", body, origin: null, headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function runOps(type: string) {
  await db.backgroundOperation.updateMany({ where: { type, status: "FAILED" }, data: { runAfter: new Date(0) } });
  await db.backgroundOperation.updateMany({ where: { type, status: { in: ["PENDING", "QUEUED"] } }, data: { runAfter: new Date(0) } });
  for (const op of await db.backgroundOperation.findMany({ where: { type, status: { in: ["PENDING", "QUEUED", "FAILED"] } } })) await runOperation(op.id, operationHandlers);
}

describe("M-Pesa STK Push", () => {
  it("sends a correct request, confirms a verified callback once, pays the invoice and keeps the books balanced", async () => {
    const { org, ctx, subscriber, invoice } = await setup();
    const attempt = await initiateStkPush(ctx, { subscriberId: subscriber.id, invoiceId: invoice.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "stk-key-0001" });
    expect(attempt).toMatchObject({ status: "SUBMITTED", amount: "1500", provider: "mpesa_daraja" });
    const sent = lastRequest();
    expect(sent).toMatchObject({ BusinessShortCode: "174379", TransactionType: "CustomerPayBillOnline", PartyB: "174379", Amount: 1500, PhoneNumber: subscriber.phone, AccountReference: subscriber.accountNumber });
    expect(sent.CallBackURL).toMatch(/^http:\/\/localhost:3100\/api\/v1\/webhooks\/mobile-money\/stk\/[A-Za-z0-9_-]{30,}$/);
    expect(sent.CallBackURL.toLowerCase()).not.toMatch(/mpesa|safaricom/);
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).callbackTokenHash).not.toContain(tokenOf(sent.CallBackURL));

    // Same idempotency key → same request, no second prompt.
    const again = await initiateStkPush(ctx, { subscriberId: subscriber.id, invoiceId: invoice.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "stk-key-0001" });
    expect(again.id).toBe(attempt.id);
    expect(fake.stkRequests).toHaveLength(1);

    fake.results.set(sent.CheckoutRequestID, "0");
    const body = fake.callbackBody(sent.CheckoutRequestID, "0", { receipt: "RKT0000AAA" });
    expect(await postCallback(sent.CallBackURL, body)).toEqual({ status: 200, body: { ResultCode: 0, ResultDesc: "Accepted" } });
    expect(fake.queries).toEqual([sent.CheckoutRequestID]); // verified with the provider before recording money

    const confirmed = await getAttempt(ctx, attempt.id);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", providerReceipt: "RKT0000AAA" });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: confirmed.paymentId! } });
    expect(payment).toMatchObject({ method: "MPESA", provider: "mpesa_daraja", source: "stk", providerTransactionId: "RKT0000AAA", status: "CONFIRMED", subscriberId: subscriber.id });
    expect(payment.amount.toString()).toBe("1500");
    expect(payment.receiptNumber).toMatch(/^[A-Z]{2,6}-\d{6}$/);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("PAID");
    expect(await db.ledgerEntry.count({ where: { organizationId: org.organization.id, account: { code: "1020" } } })).toBe(1);

    // Duplicate and tampered repeats are acknowledged and never applied again.
    expect((await postCallback(sent.CallBackURL, body)).status).toBe(200);
    expect((await postCallback(sent.CallBackURL, fake.callbackBody(sent.CheckoutRequestID, "0", { receipt: "RKT0000BBB" }))).status).toBe(200);
    expect(await db.payment.count({ where: { organizationId: org.organization.id, method: "MPESA" } })).toBe(1);
    const event = await db.webhookEvent.findFirstOrThrow({ where: { attemptId: attempt.id, kind: "stk_callback" } });
    expect(event).toMatchObject({ status: "PROCESSED", duplicateCount: 2, conflictingDuplicate: true, paymentId: payment.id });
    expect(JSON.stringify(event.payload)).not.toContain(subscriber.phone); // minimised: no full phone number

    const checks = await runReconciliationChecks(ctx);
    expect(checks.ledgerBalanced).toBe(true);
    expect(checks.paymentCacheMismatches).toEqual([]);
    expect(checks.invoiceCacheMismatches).toEqual([]);
    const status = (await integrationStatus(ctx)).find((r) => r.key === "mpesa_daraja");
    expect(status?.status).toBe("sandbox_tested");
  });

  it("rejects unknown, malformed, forged, mismatched and off-allowlist callbacks without recording money", async () => {
    const { org, ctx, subscriber } = await setup();
    const unknown = await stkCallbackRoute(request("/api/v1/webhooks/mobile-money/stk/not-a-real-token-0000000000", { method: "POST", body: {}, origin: null }), { params: Promise.resolve({ token: "not-a-real-token-0000000000" }) });
    expect(unknown.status).toBe(404);

    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 100 }, { channel: "staff", idempotencyKey: "k-a" });
    const ra = lastRequest();
    expect((await postCallback(ra.CallBackURL, { hello: "world" })).status).toBe(400);

    // Forged success: the provider says the customer cancelled.
    fake.results.set(ra.CheckoutRequestID, "1032");
    expect((await postCallback(ra.CallBackURL, fake.callbackBody(ra.CheckoutRequestID, "0"))).status).toBe(200);
    expect((await getAttempt(ctx, a.id)).status).toBe("CANCELLED");
    expect((await db.webhookEvent.findFirstOrThrow({ where: { attemptId: a.id, status: { not: "REJECTED" } }, orderBy: { receivedAt: "desc" } }).catch(() => null))).toBeNull();

    // Amount different from the request.
    const b = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 200 }, { channel: "staff", idempotencyKey: "k-b" });
    const rb = lastRequest();
    fake.results.set(rb.CheckoutRequestID, "0");
    await postCallback(rb.CallBackURL, fake.callbackBody(rb.CheckoutRequestID, "0", { amount: 1 }));
    expect((await getAttempt(ctx, b.id)).status).toBe("UNKNOWN");

    // Identifiers of another request on this request's URL.
    const c = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 300 }, { channel: "staff", idempotencyKey: "k-c" });
    const rc = lastRequest();
    const d = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 300 }, { channel: "staff", idempotencyKey: "k-d" });
    const rd = lastRequest();
    fake.results.set(rd.CheckoutRequestID, "0");
    await postCallback(rc.CallBackURL, fake.callbackBody(rd.CheckoutRequestID, "0"));
    expect((await getAttempt(ctx, c.id)).status).toBe("SUBMITTED");
    expect((await getAttempt(ctx, d.id)).status).toBe("SUBMITTED");

    // Source allowlist.
    process.env.MPESA_CALLBACK_ALLOWED_IPS = "196.201.214.0/24";
    expect((await postCallback(rd.CallBackURL, fake.callbackBody(rd.CheckoutRequestID, "0"), "41.90.1.1")).status).toBe(403);
    expect((await postCallback(rd.CallBackURL, fake.callbackBody(rd.CheckoutRequestID, "0"), "196.201.214.10")).status).toBe(200);
    expect((await getAttempt(ctx, d.id)).status).toBe("CONFIRMED");

    expect(await db.payment.count({ where: { organizationId: org.organization.id, method: "MPESA" } })).toBe(1);
  });

  it("records cancellations and failures with plain reasons", async () => {
    const { ctx, subscriber } = await setup();
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 50 }, { channel: "staff", idempotencyKey: "k-1" });
    fake.results.set(lastRequest().CheckoutRequestID, "1032");
    await postCallback(lastRequest().CallBackURL, fake.callbackBody(lastRequest().CheckoutRequestID, "1032"));
    expect(await getAttempt(ctx, a.id)).toMatchObject({ status: "CANCELLED", detail: expect.stringMatching(/cancelled on the phone/) });
    const b = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 50 }, { channel: "staff", idempotencyKey: "k-2" });
    fake.results.set(lastRequest().CheckoutRequestID, "1");
    await postCallback(lastRequest().CallBackURL, fake.callbackBody(lastRequest().CheckoutRequestID, "1"));
    expect(await getAttempt(ctx, b.id)).toMatchObject({ status: "FAILED", detail: expect.stringMatching(/balance was not enough/) });
  });

  it("a forged failure cannot hide a real payment: the provider is asked, and the genuine callback still confirms", async () => {
    const { org, ctx, subscriber } = await setup();
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 60 }, { channel: "staff", idempotencyKey: "f-1" });
    const r = lastRequest();
    fake.results.set(r.CheckoutRequestID, "0"); // the customer actually paid
    await postCallback(r.CallBackURL, fake.callbackBody(r.CheckoutRequestID, "1032")); // forged "cancelled" arrives first
    expect((await getAttempt(ctx, a.id)).status).toBe("SUBMITTED");
    await postCallback(r.CallBackURL, fake.callbackBody(r.CheckoutRequestID, "0", { receipt: "RKT00REAL1" }));
    expect(await getAttempt(ctx, a.id)).toMatchObject({ status: "CONFIRMED", providerReceipt: "RKT00REAL1" });
    expect(await db.payment.count({ where: { organizationId: org.organization.id } })).toBe(1);
    const events = await db.webhookEvent.findMany({ where: { attemptId: a.id }, orderBy: { receivedAt: "asc" } });
    expect(events.map((e) => e.status)).toEqual(["REJECTED", "PROCESSED"]);
    expect(events[0]!.conflictingDuplicate).toBe(true);
  });

  it("status queries settle requests without a callback and never record money from a query alone", async () => {
    const { org, ctx, subscriber } = await setup();
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 70 }, { channel: "staff", idempotencyKey: "q-1" });
    const ra = lastRequest();
    expect(await db.backgroundOperation.count({ where: { type: "payments.mpesa.query" } })).toBe(1);
    await expect(runStatusQuery(a.id, { final: false })).rejects.toMatchObject({ code: "STK_PENDING" });
    fake.results.set(ra.CheckoutRequestID, "1037");
    await runOps("payments.mpesa.query");
    expect((await getAttempt(ctx, a.id)).status).toBe("EXPIRED");

    const b = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 80 }, { channel: "staff", idempotencyKey: "q-2" });
    const rb = lastRequest();
    fake.results.set(rb.CheckoutRequestID, "0");
    await expect(runStatusQuery(b.id, { final: false })).rejects.toMatchObject({ code: "AWAITING_CALLBACK" });
    await runStatusQuery(b.id, { final: true });
    expect((await getAttempt(ctx, b.id)).status).toBe("UNKNOWN");
    expect(await db.payment.count({ where: { organizationId: org.organization.id } })).toBe(0);

    // The confirmation arrives late: money is recorded once it is verified.
    await postCallback(rb.CallBackURL, fake.callbackBody(rb.CheckoutRequestID, "0"));
    expect((await getAttempt(ctx, b.id)).status).toBe("CONFIRMED");
    expect(await db.payment.count({ where: { organizationId: org.organization.id } })).toBe(1);
  });

  it("waits to verify while M-Pesa is still processing, then confirms from the stored callback", async () => {
    const { ctx, subscriber } = await setup();
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 90 }, { channel: "staff", idempotencyKey: "v-1" });
    const ra = lastRequest();
    expect((await postCallback(ra.CallBackURL, fake.callbackBody(ra.CheckoutRequestID, "0"))).status).toBe(200);
    expect((await getAttempt(ctx, a.id)).status).toBe("SUBMITTED");
    expect((await db.webhookEvent.findFirstOrThrow({ where: { attemptId: a.id } })).status).toBe("RECEIVED");
    expect(await db.backgroundOperation.count({ where: { type: "payments.mpesa.verify" } })).toBe(1);
    fake.results.set(ra.CheckoutRequestID, "0");
    await runOps("payments.mpesa.verify");
    expect((await getAttempt(ctx, a.id)).status).toBe("CONFIRMED");
  });

  it("handles provider errors honestly: rejected requests fail, unreachable ones stay unknown, tokens refresh", async () => {
    const { ctx, subscriber } = await setup();
    fake.failures.push({ path: "/mpesa/stkpush", status: 400, body: { requestId: "x", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" } });
    const rejected = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "e-1" });
    expect(rejected).toMatchObject({ status: "FAILED", detail: expect.stringMatching(/Invalid PhoneNumber/) });

    fake.failures.push({ path: "/mpesa/stkpush", drop: true });
    const unknown = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "e-2" });
    expect(unknown).toMatchObject({ status: "UNKNOWN", detail: expect.stringMatching(/recorded when M-Pesa reports it/) });

    fake.tokens.clear(); // cached token no longer valid on the provider side
    const before = fake.tokenRequests;
    const ok = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "e-3" });
    expect(ok.status).toBe("SUBMITTED");
    expect(fake.tokenRequests).toBe(before + 1);

    await saveMpesaSettings(ctx, { environment: "sandbox", type: "PAYBILL", shortcode: fake.shortcode, consumerKey: fake.consumerKey, consumerSecret: "wrong-secret-value", passkey: fake.passkey });
    clearDarajaTokenCache();
    expect(await testMpesaCredentials(ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/consumer key or secret/) });
    const bad = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "e-4" });
    expect(bad).toMatchObject({ status: "FAILED", detail: expect.stringMatching(/consumer key or secret/) });

    await expect(initiateStkPush(ctx, { subscriberId: subscriber.id, phone: "+44 20 7946 0000", amount: 10 }, { channel: "staff", idempotencyKey: "e-5" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10.5 }, { channel: "staff", idempotencyKey: "e-6" })).rejects.toThrow(/whole shillings/);
  });

  it("stores credentials encrypted, never returns them, and needs configuration before use", async () => {
    const { ctx, subscriber } = await setup({ configure: false });
    await expect(initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "c-1" })).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
    await saveMpesaSettings(ctx, { environment: "sandbox", type: "TILL", shortcode: "174379", tillNumber: "5234567", consumerKey: fake.consumerKey, consumerSecret: fake.consumerSecret, passkey: fake.passkey });
    const row = await db.integrationConfiguration.findFirstOrThrow({ where: { organizationId: ctx.organizationId, provider: "mpesa_daraja" } });
    expect(row.encryptedSecret).not.toContain(fake.consumerSecret);
    expect(row.encryptedSecret).not.toContain(fake.passkey);
    const settings = await getMpesaSettings(ctx);
    expect(JSON.stringify(settings)).not.toMatch(new RegExp(`${fake.consumerSecret}|${fake.passkey}|${fake.consumerKey}`));
    expect(settings).toMatchObject({ credentialsSet: true, type: "TILL", tillNumber: "5234567" });
    expect(await testMpesaCredentials(ctx)).toEqual({ ok: true, error: null });
    await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "c-2" });
    expect(lastRequest()).toMatchObject({ TransactionType: "CustomerBuyGoodsOnline", BusinessShortCode: "174379", PartyB: "5234567" });

    const support = await createStaff(ctx.organizationId, "support");
    const supportCtx = await contextFor(support.user.id, ctx.organizationId);
    await expect(initiateStkPush(supportCtx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "c-3" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(saveMpesaSettings(supportCtx, { environment: "sandbox", type: "PAYBILL", shortcode: "174379" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("limits how often one phone can be prompted", async () => {
    const { ctx, subscriber } = await setup();
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      try {
        await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 5 }, { channel: "staff", idempotencyKey: `rl-${i}` });
      } catch (err) {
        if ((err as { code?: string }).code === "RATE_LIMITED") limited = true;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("M-Pesa C2B (direct paybill payments)", () => {
  async function c2b(token: string, body: Record<string, unknown>, kind: "confirmation" | "validation" = "confirmation") {
    const route = kind === "confirmation" ? c2bConfirmRoute : c2bValidateRoute;
    const res = await route(request(`/api/v1/webhooks/mobile-money/c2b/${token}/${kind}`, { method: "POST", body, origin: null }), { params: Promise.resolve({ token }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const confirmation = (o: Record<string, unknown>) => ({ TransactionType: "Pay Bill", TransTime: "20261025101530", BusinessShortCode: "174379", InvoiceNumber: "", MSISDN: "2547 ***** 126", FirstName: "Achieng", ...o });

  it("matches by account number, sends unknown references to reconciliation, and records each receipt once", async () => {
    const { org, ctx, subscriber, invoice } = await setup();
    await registerC2bUrls(ctx);
    const reg = fake.registrations[0]!;
    expect(String(reg.ConfirmationURL)).toMatch(/\/api\/v1\/webhooks\/mobile-money\/c2b\/[A-Za-z0-9_-]+\/confirmation$/);
    const settings = await getMpesaSettings(ctx);
    expect(settings.c2bUrls?.confirmationUrl).toBe(reg.ConfirmationURL);
    const token = new URL(String(reg.ConfirmationURL)).pathname.split("/").at(-2)!;

    expect(await c2b(token, confirmation({ TransID: "RKA1234567", TransAmount: "1500.00", BillRefNumber: ` ${subscriber.accountNumber.toLowerCase()} ` }))).toEqual({ status: 200, body: { ResultCode: 0, ResultDesc: "Accepted" } });
    const matched = await db.payment.findFirstOrThrow({ where: { providerTransactionId: "RKA1234567" } });
    expect(matched).toMatchObject({ subscriberId: subscriber.id, method: "MPESA", provider: "mpesa_daraja", source: "c2b", payerName: "Achieng" });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("PAID");

    await c2b(token, confirmation({ TransID: "RKA1234567", TransAmount: "1500.00", BillRefNumber: subscriber.accountNumber }));
    expect(await db.payment.count({ where: { providerTransactionId: "RKA1234567" } })).toBe(1);

    await c2b(token, confirmation({ TransID: "RKA7654321", TransAmount: "250", BillRefNumber: "WRONGREF" }));
    const unmatched = await listPayments(ctx, { status: "ALL", unmatched: "1", page: 1, pageSize: 25 });
    expect(unmatched.rows.map((p) => p.providerTransactionId)).toEqual(["RKA7654321"]);

    await c2b(token, confirmation({ TransID: "RKA0000009", TransAmount: "100", BillRefNumber: subscriber.accountNumber, BusinessShortCode: "999999" }));
    expect(await db.payment.count({ where: { providerTransactionId: "RKA0000009" } })).toBe(0);

    // A clerk cannot record the same M-Pesa receipt again by hand.
    await expect(recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "1500", method: "MPESA", reference: "rka1234567", receivedAt: new Date(Date.now() - 60_000).toISOString() }))).rejects.toMatchObject({ code: "CONFLICT" });

    // External validation: optional rejection of unknown account references.
    expect((await c2b(token, confirmation({ TransID: "RKV0000001", TransAmount: "10", BillRefNumber: "NOPE" }), "validation")).body).toEqual({ ResultCode: "0", ResultDesc: "Accepted" });
    await saveMpesaSettings(ctx, { environment: "sandbox", type: "PAYBILL", shortcode: fake.shortcode, rejectUnknownAccounts: true });
    expect((await c2b(token, confirmation({ TransID: "RKV0000002", TransAmount: "10", BillRefNumber: "NOPE" }), "validation")).body).toMatchObject({ ResultCode: "C2B00012" });
    expect((await c2b(token, confirmation({ TransID: "RKV0000003", TransAmount: "10", BillRefNumber: subscriber.accountNumber }), "validation")).body).toMatchObject({ ResultCode: "0" });

    const checks = await runReconciliationChecks(ctx);
    expect(checks.ledgerBalanced).toBe(true);
    expect(org.organization.id).toBeTruthy();
  });
});

describe("M-Pesa with billing, network, portal and the mock adapter", () => {
  it("a confirmed payment renews a lapsed subscription and re-enables its network access; pending payments delay expiry", async () => {
    const { org, ctx, subscriber, subscription, invoice } = await setup();
    const router = await createRouter(ctx, { name: "Core", host: "10.0.0.1", username: "a", password: "b" });
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await db.subscription.update({ where: { id: subscription.id }, data: { currentPeriodStart: new Date(Date.now() - 31 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 86_400_000) } });

    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, invoiceId: invoice.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "r-1" });
    const sys = systemContext(org.organization.id, "worker:subscriptions", "test");
    expect(await expireDueSubscriptions(org.organization.id, sys)).toBe(0); // payment in progress: not cut off
    await db.paymentAttempt.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    expect(await expireDueSubscriptions(org.organization.id, sys)).toBe(1);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("EXPIRED");

    const r = lastRequest();
    fake.results.set(r.CheckoutRequestID, "0");
    await postCallback(r.CallBackURL, fake.callbackBody(r.CheckoutRequestID, "0"));
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(sub.status).toBe("ACTIVE");
    const ops = await db.networkOperation.findMany({ where: { subscriptionId: subscription.id }, orderBy: { createdAt: "asc" } });
    expect(ops.map((o) => o.type)).toEqual(["pppoe.enable", "pppoe.disable", "pppoe.enable"]);
  });

  it("customers pay only their own balance and see only their own requests", async () => {
    const { org, ctx, subscriber, invoice } = await setup();
    const other = (await createSubscriber(ctx, subscriberInput.parse({ firstName: "Other", phone: tel() }))).subscriber;
    const activate = async (subscriberId: string) => {
      const { link } = await createPortalInviteLink(ctx, subscriberId);
      await activatePortalAccount({ token: new URL(link).searchParams.get("token")!, password: "Portal-Pass-123" }, meta);
    };
    await activate(subscriber.id);
    await activate(other.id);
    const login = async (phone: string) => (await portalLogin({ organization: org.organization.slug, identifier: phone, password: "Portal-Pass-123" }, meta)).token;
    const tokenA = await login(subscriber.phone);
    const cA = (await resolveCustomerContext(tokenA, meta))!;
    const cB = (await resolveCustomerContext(await login(other.phone), meta))!;

    const res = await customerPayRoute(request("/api/v1/customer/payments", { portalToken: tokenA, body: { invoiceId: invoice.id, phone: subscriber.phone, amount: 1500, requestId: "0193a3e4-1111-7000-8000-000000000001" } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(202);
    const attempt = ((await res.json()) as { data: { id: string; status: string; channel: string } }).data;
    expect(attempt).toMatchObject({ status: "SUBMITTED", channel: "portal" });
    expect((await getCustomerAttempt(cA, attempt.id)).status).toBe("SUBMITTED");
    await expect(getCustomerAttempt(cB, attempt.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(initiateCustomerPayment(cB, { invoiceId: invoice.id, phone: other.phone, amount: 100, requestId: "0193a3e4-1111-7000-8000-000000000002" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(initiateCustomerPayment(cA, { invoiceId: invoice.id, phone: subscriber.phone, amount: 99999, requestId: "0193a3e4-1111-7000-8000-000000000003" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // more than the invoice balance
    // Same request id → same request.
    const again = await initiateCustomerPayment(cA, { invoiceId: invoice.id, phone: subscriber.phone, amount: 1500, requestId: "0193a3e4-1111-7000-8000-000000000001" });
    expect(again.id).toBe(attempt.id);

    const otherOrg = await createOrg("Other ISP");
    const otherCtx = await contextFor(otherOrg.owner.id, otherOrg.organization.id);
    await expect(getAttempt(otherCtx, attempt.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listAttempts(otherCtx, { status: "ALL", page: 1, pageSize: 25 })).total).toBe(0);
  });

  it("mock adapter: simulations run through the callback pipeline, are labelled, and are refused in production", async () => {
    process.env.PAYMENT_ADAPTER = "mock";
    const { org, ctx, subscriber, invoice } = await setup({ configure: false });
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, invoiceId: invoice.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "m-1" });
    expect(a).toMatchObject({ status: "SUBMITTED", simulated: true, detail: expect.stringMatching(/no prompt was sent/) });
    expect(fake.stkRequests).toHaveLength(0);
    const after = await simulateMockResponse(ctx, a.id, { outcome: "success" });
    expect(after.status).toBe("CONFIRMED");
    const p = await db.payment.findUniqueOrThrow({ where: { id: after.paymentId! } });
    expect(p).toMatchObject({ provider: "mock", notes: expect.stringMatching(/Simulated/) });
    expect(p.providerTransactionId).toMatch(/^SIM/);
    expect((await integrationStatus(ctx)).find((r) => r.key === "mpesa_daraja")?.status).toBe("mock");

    const failed = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: "0712000000", amount: 10 }, { channel: "staff", idempotencyKey: "m-2" });
    expect(failed.status).toBe("FAILED");

    const b = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 10 }, { channel: "staff", idempotencyKey: "m-3" });
    process.env.APP_ENV = "production";
    await expect(simulateMockResponse(ctx, b.id, { outcome: "success" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    process.env.APP_ENV = "test";
    expect((await simulateMockResponse(ctx, b.id, { outcome: "cancelled" })).status).toBe("CANCELLED");
    expect(await db.payment.count({ where: { organizationId: org.organization.id } })).toBe(1);
  });
});
