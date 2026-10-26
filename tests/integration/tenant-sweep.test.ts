import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { manualPaymentInput, recordManualPayment } from "@/server/services/payments";
import { createLead, leadInput } from "@/server/services/leads";
import { createRouter } from "@/server/services/routers";
import { provisionSubscriptionNetwork } from "@/server/services/network";
import { initiateStkPush } from "@/server/services/mobile-money";
import { createTicket, staffTicketInput } from "@/server/services/tickets";
import { generateBatch } from "@/server/services/vouchers";
import { createItem, itemInput } from "@/server/services/inventory";
import { contextFor, createOrg, request, sessionFor } from "./fixtures";

import { GET as subscriberGet } from "@/app/api/v1/subscribers/[id]/route";
import { GET as subscriptionGet } from "@/app/api/v1/subscriptions/[id]/route";
import { GET as subscriptionNetworkGet, POST as subscriptionProvision } from "@/app/api/v1/subscriptions/[id]/network/route";
import { POST as credentialsReveal } from "@/app/api/v1/subscriptions/[id]/network/credentials/route";
import { POST as subscriptionAction } from "@/app/api/v1/subscriptions/[id]/[action]/route";
import { GET as invoiceGet } from "@/app/api/v1/invoices/[id]/route";
import { GET as invoicePdf } from "@/app/api/v1/invoices/[id]/pdf/route";
import { POST as invoiceVoid } from "@/app/api/v1/invoices/[id]/void/route";
import { GET as paymentGet } from "@/app/api/v1/payments/[id]/route";
import { GET as paymentReceipt } from "@/app/api/v1/payments/[id]/receipt/route";
import { POST as paymentRefund } from "@/app/api/v1/payments/[id]/refunds/route";
import { GET as leadGet } from "@/app/api/v1/leads/[id]/route";
import { GET as packageGet } from "@/app/api/v1/packages/[id]/route";
import { GET as routerGet } from "@/app/api/v1/routers/[id]/route";
import { GET as routerSessions } from "@/app/api/v1/routers/[id]/sessions/route";
import { POST as routerOperation } from "@/app/api/v1/routers/[id]/operations/route";
import { POST as routerSetupCommand } from "@/app/api/v1/routers/[id]/setup-command/route";
import { GET as networkOpGet } from "@/app/api/v1/network/operations/[id]/route";
import { POST as networkOpRetry } from "@/app/api/v1/network/operations/[id]/retry/route";
import { GET as attemptGet } from "@/app/api/v1/payments/attempts/[id]/route";
import { POST as attemptQuery } from "@/app/api/v1/payments/attempts/[id]/query/route";
import { GET as ticketGet } from "@/app/api/v1/support/tickets/[id]/route";
import { GET as batchGet } from "@/app/api/v1/vouchers/batches/[id]/route";
import { GET as itemGet } from "@/app/api/v1/inventory/[id]/route";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.PAYMENT_ADAPTER = process.env.PAYMENT_ADAPTER;
  saved.NETWORK_ADAPTER = process.env.NETWORK_ADAPTER;
  process.env.PAYMENT_ADAPTER = "mock";
  process.env.NETWORK_ADAPTER = "mock";
});
afterEach(() => {
  for (const k of ["PAYMENT_ADAPTER", "NETWORK_ADAPTER"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("tenant isolation sweep", () => {
  it("every detail endpoint and key action returns 404 for another organization's records", async () => {
    // Organization A with one record of every kind.
    const a = await createOrg("Alpha");
    const ctx = await contextFor(a.owner.id, a.organization.id);
    const pkg = await createPackage(ctx, packageInput.parse({ name: "Home", serviceType: "PPPOE", price: "1000.00", billingUnit: "MONTH", billingCount: 1 }));
    const hs = await createPackage(ctx, packageInput.parse({ name: "Day", serviceType: "HOTSPOT", price: "50.00", billingUnit: "DAY", billingCount: 1 }));
    const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Asha", phone: "0711999001", packageId: pkg.id, activateSubscription: true }));
    const invoice = await db.invoice.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    const { payment } = await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "500", method: "CASH", receivedAt: new Date(Date.now() - 60_000).toISOString() }));
    const { lead } = await createLead(ctx, leadInput.parse({ name: "Prospect", phone: "0711999002" }));
    const router = await createRouter(ctx, { name: "Core", host: "10.0.0.1", username: "a", password: "b" });
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription!.id, { routerId: router.id });
    const attempt = await initiateStkPush(ctx, { subscriberId: subscriber.id, phone: "0711999001", amount: 100 }, { channel: "staff", idempotencyKey: "sweep" });
    const ticket = await createTicket(ctx, staffTicketInput.parse({ subscriberId: subscriber.id, subject: "Slow", description: "Slow at night" }));
    const { batch } = await generateBatch(ctx, { packageId: hs.id, quantity: 1, codeLength: 10 });
    const item = await createItem(ctx, itemInput.parse({ category: "router", model: "hAP", serialNumber: "SN-SWEEP-1" }));

    // Organization B's owner (full permissions in B) probes A's ids.
    const b = await createOrg("Bravo");
    const token = await sessionFor(b.owner.id, b.organization.id);
    const probes: Array<[string, Handler, Record<string, string>, unknown?]> = [
      ["GET subscriber", subscriberGet as Handler, { id: subscriber.id }],
      ["GET subscription", subscriptionGet as Handler, { id: subscription!.id }],
      ["GET subscription network", subscriptionNetworkGet as Handler, { id: subscription!.id }],
      ["POST provision", subscriptionProvision as Handler, { id: subscription!.id }, { routerId: router.id }],
      ["POST reveal credentials", credentialsReveal as Handler, { id: subscription!.id }],
      ["POST suspend", subscriptionAction as Handler, { id: subscription!.id, action: "suspend" }, { reason: "probe" }],
      ["GET invoice", invoiceGet as Handler, { id: invoice.id }],
      ["GET invoice pdf", invoicePdf as Handler, { id: invoice.id }],
      ["POST void invoice", invoiceVoid as Handler, { id: invoice.id }, { reason: "probe" }],
      ["GET payment", paymentGet as Handler, { id: payment.id }],
      ["GET receipt", paymentReceipt as Handler, { id: payment.id }],
      ["POST refund", paymentRefund as Handler, { id: payment.id }, { amount: "1", method: "CASH", reason: "probe" }],
      ["GET lead", leadGet as Handler, { id: lead.id }],
      ["GET package", packageGet as Handler, { id: pkg.id }],
      ["GET router", routerGet as Handler, { id: router.id }],
      ["GET router sessions", routerSessions as Handler, { id: router.id }],
      ["POST router operation", routerOperation as Handler, { id: router.id }, { type: "session.disconnect", kind: "PPPOE", username: "x1" }],
      ["POST router setup command", routerSetupCommand as Handler, { id: router.id }],
      ["GET network operation", networkOpGet as Handler, { id: operation.id }],
      ["POST retry operation", networkOpRetry as Handler, { id: operation.id }],
      ["GET payment request", attemptGet as Handler, { id: attempt.id }],
      ["POST payment request check", attemptQuery as Handler, { id: attempt.id }],
      ["GET ticket", ticketGet as Handler, { id: ticket.id }],
      ["GET voucher batch", batchGet as Handler, { id: batch.id }],
      ["GET inventory item", itemGet as Handler, { id: item.id }],
    ];
    const leaks: string[] = [];
    for (const [label, handler, params, body] of probes) {
      const path = `/api/v1/probe/${Object.values(params).join("/")}`;
      const method = body !== undefined || label.startsWith("POST") ? "POST" : "GET";
      const res = await handler(request(path, { method, token, ...(body !== undefined ? { body } : {}), headers: method === "POST" ? { "idempotency-key": `probe-${label.replace(/\W/g, "-")}` } : {} }), { params: Promise.resolve(params) });
      if (res.status !== 404) leaks.push(`${label}: ${res.status}`);
    }
    expect(leaks).toEqual([]);

    // Nothing in A was changed by the probes.
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } })).status).toBe("ACTIVE");
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).not.toBe("VOID");
    expect(await db.refund.count({ where: { paymentId: payment.id } })).toBe(0);
    expect((await db.router.findUniqueOrThrow({ where: { id: router.id } })).setupTokenHash).toBeNull();
  });
});
