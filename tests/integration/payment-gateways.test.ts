import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { saveMpesaSettings } from "@/server/services/mpesa-config";
import { listGateways, saveKopoKopoSettings, setActiveGateway, testKopoKopoCredentials } from "@/server/services/payment-gateways";
import { initiateStkPush, runStatusQuery } from "@/server/services/mobile-money";
import { clearKopoKopoTokenCache, kopokopoSignatureValid } from "@/server/integrations/payments/kopokopo";
import { clearDarajaTokenCache } from "@/server/integrations/payments/daraja";
import { POST as k2CallbackRoute } from "@/app/api/v1/webhooks/mobile-money/kopokopo/[token]/route";
import { FakeKopoKopo } from "../support/fake-kopokopo";
import { FakeDaraja } from "../support/fake-daraja";
import { contextFor, createOrg, createStaff, request } from "./fixtures";

const k2 = new FakeKopoKopo();
const daraja = new FakeDaraja();
let darajaUrl = "";
let seq = 0;
const tel = () => `07${String(50_000_000 + seq++).padStart(8, "0")}`;
const KEYS = ["PAYMENT_ADAPTER", "KOPOKOPO_BASE_URL", "MPESA_BASE_URL", "MPESA_VERIFY_CALLBACKS"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await k2.start();
  darajaUrl = await daraja.start();
});
afterAll(async () => {
  await k2.stop();
  await daraja.stop();
});
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PAYMENT_ADAPTER = "live";
  process.env.KOPOKOPO_BASE_URL = k2.baseUrl;
  process.env.MPESA_BASE_URL = darajaUrl;
  process.env.MPESA_VERIFY_CALLBACKS = "true";
  k2.reset();
  daraja.reset();
  clearKopoKopoTokenCache();
  clearDarajaTokenCache();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: "1500.00", billingUnit: "MONTH", billingCount: 1 }));
  const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Achieng", phone: tel(), packageId: pkg.id, activateSubscription: true }));
  const invoice = await db.invoice.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
  return { org, ctx, subscriber, invoice };
}

async function useKopoKopo(ctx: Awaited<ReturnType<typeof contextFor>>) {
  await saveKopoKopoSettings(ctx, { environment: "sandbox", tillNumber: k2.tillNumber.toLowerCase(), clientId: k2.clientId, clientSecret: k2.clientSecret, apiKey: k2.apiKey });
  await setActiveGateway(ctx, { provider: "kopokopo" });
}

const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;
async function callback(callbackUrl: string, body: unknown, signature?: string | null) {
  const raw = JSON.stringify(body);
  const token = tokenOf(callbackUrl);
  const headers: Record<string, string> = { "x-forwarded-for": "52.1.2.3" };
  if (signature !== null) headers["x-kopokopo-signature"] = signature ?? k2.sign(raw);
  const req = request(`/api/v1/webhooks/mobile-money/kopokopo/${token}`, { method: "POST", origin: null, headers: { ...headers, "content-type": "application/json" } });
  const res = await k2CallbackRoute(new Request(req.url, { method: "POST", headers: req.headers, body: raw }) as never, { params: Promise.resolve({ token }) });
  return res.status;
}

describe("payment gateway catalogue", () => {
  it("stores Kopo Kopo credentials encrypted, tests them, and only activates configured gateways", async () => {
    const { ctx, org } = await setup();
    let cat = await listGateways(ctx);
    expect(cat.active).toBe("mpesa_daraja");
    expect(cat.gateways.map((g) => [g.key, g.configured])).toEqual([
      ["mpesa_daraja", false],
      ["kopokopo", false],
    ]);
    await expect(setActiveGateway(ctx, { provider: "kopokopo" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(saveKopoKopoSettings(ctx, { environment: "sandbox", tillNumber: "K000123", clientId: k2.clientId })).rejects.toThrow(/together/);
    await expect(saveKopoKopoSettings(ctx, { environment: "sandbox", tillNumber: "12" })).rejects.toThrow();

    await useKopoKopo(ctx);
    const row = await db.integrationConfiguration.findFirstOrThrow({ where: { organizationId: org.organization.id, provider: "kopokopo" } });
    for (const secret of [k2.clientSecret, k2.apiKey, k2.clientId]) expect(row.encryptedSecret).not.toContain(secret);
    expect(row.safeConfig).toEqual({ environment: "sandbox", tillNumber: "K000123" });
    cat = await listGateways(ctx);
    expect(cat.active).toBe("kopokopo");
    expect(cat.kopokopo).toEqual({ environment: "sandbox", tillNumber: "K000123", credentialsSet: true });
    expect(JSON.stringify(cat)).not.toContain(k2.apiKey);

    expect(await testKopoKopoCredentials(ctx)).toEqual({ ok: true, error: null });
    await saveKopoKopoSettings(ctx, { environment: "sandbox", tillNumber: "K000123", clientId: k2.clientId, clientSecret: "wrong-secret-value", apiKey: k2.apiKey });
    expect(await testKopoKopoCredentials(ctx)).toMatchObject({ ok: false, error: "Kopo Kopo rejected the client ID or secret" });
    expect(await db.auditLog.count({ where: { organizationId: org.organization.id, action: { in: ["integration.kopokopo.configure", "integration.gateway.activate", "integration.kopokopo.test"] } } })).toBe(5);

    const support = await createStaff(org.organization.id, "support");
    await expect(setActiveGateway(await contextFor(support.user.id, org.organization.id), { provider: "mpesa_daraja" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("checks Kopo Kopo signatures in constant time against the raw body", () => {
    const body = '{"a":1}';
    expect(kopokopoSignatureValid(k2.apiKey, body, k2.sign(body))).toBe(true);
    expect(kopokopoSignatureValid(k2.apiKey, body, k2.sign(body, "other-key"))).toBe(false);
    expect(kopokopoSignatureValid(k2.apiKey, '{"a": 1}', k2.sign(body))).toBe(false);
    expect(kopokopoSignatureValid(k2.apiKey, body, null)).toBe(false);
    expect(kopokopoSignatureValid(k2.apiKey, body, "zz")).toBe(false);
  });
});

describe("Kopo Kopo payments", () => {
  it("prompts through Kopo Kopo, then records the money once from a signed callback confirmed by the status query", async () => {
    const { ctx, subscriber, invoice } = await setup();
    await useKopoKopo(ctx);
    const attempt = await initiateStkPush(ctx, { subscriberId: subscriber.id, invoiceId: invoice.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "k2-0001" });
    expect(attempt).toMatchObject({ provider: "kopokopo", status: "SUBMITTED" });
    const sent = k2.requests[0]!;
    expect(sent.body).toMatchObject({ payment_channel: "M-PESA STK Push", till_number: "K000123", amount: { currency: "KES", value: 1500 }, subscriber: { phone_number: `+${subscriber.phone}` } });
    expect(sent.body._links.callback_url).toMatch(/\/api\/v1\/webhooks\/mobile-money\/kopokopo\/[A-Za-z0-9_-]{20,}$/);
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).checkoutRequestId).toBe(sent.id);

    // Forged or unsigned callbacks change nothing.
    k2.outcomes.set(sent.id, { status: "Success", reference: "QJK1ABCD23", amount: "1500.0" });
    expect(await callback(sent.body._links.callback_url, k2.resultBody(sent.id), "0".repeat(64))).toBe(401);
    expect(await callback(sent.body._links.callback_url, k2.resultBody(sent.id), null)).toBe(401);
    expect(await db.payment.count({ where: { subscriberId: subscriber.id, status: "CONFIRMED" } })).toBe(0);

    expect(await callback(sent.body._links.callback_url, k2.resultBody(sent.id))).toBe(200);
    const done = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(done).toMatchObject({ status: "CONFIRMED", providerReceipt: "QJK1ABCD23" });
    expect(k2.queries).toContain(sent.id); // verified with the provider before recording
    const payment = await db.payment.findUniqueOrThrow({ where: { id: done.paymentId! } });
    expect(payment).toMatchObject({ provider: "kopokopo", providerTransactionId: "QJK1ABCD23", method: "MPESA" });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("PAID");

    // A repeat is acknowledged and never re-applied; the gateway is now marked sandbox tested.
    expect(await callback(sent.body._links.callback_url, k2.resultBody(sent.id))).toBe(200);
    expect(await db.payment.count({ where: { providerTransactionId: "QJK1ABCD23" } })).toBe(1);
    expect((await listGateways(ctx)).gateways.find((g) => g.key === "kopokopo")?.status).toBe("SANDBOX_TESTED");
  });

  it("rejects a callback whose receipt or amount differs from what Kopo Kopo reports, and handles failures", async () => {
    const { ctx, subscriber } = await setup();
    await useKopoKopo(ctx);
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "k2-0002" });
    const req = k2.requests[0]!;
    k2.outcomes.set(req.id, { status: "Success", reference: "REAL000001", amount: "1500.0" });
    const forged = k2.resultBody(req.id);
    (forged.data.attributes.event.resource as { reference: string }).reference = "FAKE000001";
    expect(await callback(req.body._links.callback_url, forged)).toBe(200);
    expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "UNKNOWN" });
    expect(await db.payment.count({ where: { subscriberId: subscriber.id, status: "CONFIRMED" } })).toBe(0);

    const b = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 700 }, { channel: "staff", idempotencyKey: "k2-0003" });
    const req2 = k2.requests[1]!;
    k2.outcomes.set(req2.id, { status: "Success", reference: "REAL000002", amount: "70.0" });
    expect(await callback(req2.body._links.callback_url, k2.resultBody(req2.id))).toBe(200);
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("UNKNOWN");

    const c = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 300 }, { channel: "staff", idempotencyKey: "k2-0004" });
    const req3 = k2.requests[2]!;
    k2.outcomes.set(req3.id, { status: "Failed", errors: ["The initiator information is invalid."] });
    expect(await callback(req3.body._links.callback_url, k2.resultBody(req3.id))).toBe(200);
    expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "FAILED", detail: expect.stringContaining("initiator information is invalid") });
  });

  it("settles from the authenticated status query when no callback arrives, and keeps verifying with the sending gateway after a switch", async () => {
    const { ctx, subscriber } = await setup();
    await useKopoKopo(ctx);
    const a = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "k2-0005" });
    const req = k2.requests[0]!;
    await expect(runStatusQuery(a.id, { final: false })).rejects.toMatchObject({ code: "STK_PENDING" }); // still pending

    // The organization switches to Daraja meanwhile; the Kopo Kopo request is still checked with Kopo Kopo.
    await saveMpesaSettings(ctx, { environment: "sandbox", type: "PAYBILL", shortcode: daraja.shortcode, consumerKey: daraja.consumerKey, consumerSecret: daraja.consumerSecret, passkey: daraja.passkey });
    await setActiveGateway(ctx, { provider: "mpesa_daraja" });
    k2.outcomes.set(req.id, { status: "Success", reference: "QRY0000001", amount: "1500.0" });
    expect(await runStatusQuery(a.id, { final: false })).toMatchObject({ outcome: "SUCCESS" });
    expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "CONFIRMED", providerReceipt: "QRY0000001" });
    expect(daraja.queries).toHaveLength(0);

    // New requests now go through Daraja.
    const next = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 100 }, { channel: "staff", idempotencyKey: "k2-0006" });
    expect(next.provider).toBe("mpesa_daraja");
    expect(daraja.stkRequests).toHaveLength(1);
  });

  it("does not accept a callback for another provider's request or with a body for another request", async () => {
    const { ctx, subscriber } = await setup();
    await useKopoKopo(ctx);
    await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 1500 }, { channel: "staff", idempotencyKey: "k2-0007" });
    await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: subscriber.phone, amount: 900 }, { channel: "staff", idempotencyKey: "k2-0008" });
    const [r1, r2] = k2.requests;
    k2.outcomes.set(r2!.id, { status: "Success", reference: "OTHER00001", amount: "900.0" });
    // Request 2's genuine, signed result posted on request 1's URL: identifiers do not match → rejected.
    expect(await callback(r1!.body._links.callback_url, k2.resultBody(r2!.id))).toBe(200);
    expect(await db.payment.count({ where: { subscriberId: subscriber.id, status: "CONFIRMED" } })).toBe(0);
    expect(await callback("http://localhost/x/unknowntoken0000000000000", k2.resultBody(r2!.id))).toBe(404);
  });
});
