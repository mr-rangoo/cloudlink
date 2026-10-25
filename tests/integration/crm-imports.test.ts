import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { addLeadActivity, convertLead, createLead, getLead, leadConvertInput, leadInput, leadUpdate, listLeads, updateLead } from "@/server/services/leads";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { commitSubscriberImport, previewSubscriberImport } from "@/server/services/imports";
import { dashboardSummary, monthlyEquivalent } from "@/server/services/dashboard";
import { D } from "@/server/domain/money";
import { POST as renewRoute } from "@/app/api/v1/subscriptions/[id]/[action]/route";
import { POST as createSubscriberRoute } from "@/app/api/v1/subscribers/route";
import { contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

async function ownerCtx() {
  const org = await createOrg();
  return { org, ctx: await contextFor(org.owner.id, org.organization.id) };
}
const lead = (o: Record<string, unknown> = {}) => leadInput.parse({ name: "Mary Akinyi", phone: "0711222333", source: "REFERRAL", location: "Ruaka", ...o });
const pkg = { name: "Fibre 20", serviceType: "PPPOE" as const, price: "3500.00", taxRate: "0", billingUnit: "MONTH" as const, billingCount: 1, description: null };

describe("leads", () => {
  it("records a timeline for creation, calls, stage changes and assignment", async () => {
    const { org, ctx } = await ownerCtx();
    const { lead: l } = await createLead(ctx, lead());
    expect(l.ownerId).toBe(org.owner.id);
    await addLeadActivity(ctx, l.id, { type: "call", message: "Interested in fibre" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("CONTACTED"); // auto-advanced
    await updateLead(ctx, l.id, leadUpdate.parse({ stage: "QUALIFIED" }));
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).location).toBe("Ruaka"); // untouched by PATCH
    await expect(updateLead(ctx, l.id, leadUpdate.parse({ stage: "LOST" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const detail = await getLead(ctx, l.id);
    expect(detail.activities.map((a) => a.type)).toEqual(["stage_changed", "stage_changed", "call", "created"]);
  });

  it("converts a lead into a subscriber + active subscription atomically, preserving history", async () => {
    const { ctx } = await ownerCtx();
    const p = await createPackage(ctx, pkg);
    const { lead: l } = await createLead(ctx, lead({ interestedPackageId: p.id }));
    await addLeadActivity(ctx, l.id, { type: "note", message: "Site survey booked" });
    const { subscriber, subscription } = await convertLead(ctx, l.id, leadConvertInput.parse({}));

    expect(subscriber.displayName).toBe("Mary Akinyi");
    expect(subscription?.status).toBe("ACTIVE");
    expect(subscription?.packageName).toBe("Fibre 20");
    const after = await getLead(ctx, l.id);
    expect(after.stage).toBe("WON");
    expect(after.convertedSubscriber?.id).toBe(subscriber.id);
    expect(after.activities.map((a) => a.type)).toEqual(["converted", "note", "created"]); // history kept
    const addr = await db.subscriberAddress.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    expect(addr.line1).toBe("Ruaka");
    expect(await db.subscriberActivity.count({ where: { subscriberId: subscriber.id, type: "lead.converted" } })).toBe(1);
    await expect(updateLead(ctx, l.id, leadUpdate.parse({ notes: "x" }))).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("cannot convert the same lead twice, even concurrently", async () => {
    const { ctx } = await ownerCtx();
    const { lead: l } = await createLead(ctx, lead());
    const results = await Promise.allSettled([convertLead(ctx, l.id, leadConvertInput.parse({})), convertLead(ctx, l.id, leadConvertInput.parse({}))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(await db.subscriber.count()).toBe(1);
  });

  it("flags existing subscribers with the same contact and blocks duplicate conversion by default", async () => {
    const { ctx } = await ownerCtx();
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "Existing", phone: "0711222333" }));
    const { lead: l, existingSubscribers } = await createLead(ctx, lead());
    expect(existingSubscribers).toHaveLength(1);
    await expect(convertLead(ctx, l.id, leadConvertInput.parse({}))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("NEW"); // rolled back
  });

  it("filters by stage and owner and reports stage counts", async () => {
    const { org, ctx } = await ownerCtx();
    await createLead(ctx, lead());
    const { user } = await createStaff(org.organization.id, "sales");
    await createLead(ctx, lead({ name: "Assigned One", phone: "0700000001", ownerId: user.id }));
    const sales = await contextFor(user.id, org.organization.id);
    const mine = await listLeads(sales, { stage: "OPEN", owner: "me", page: 1, pageSize: 25 });
    expect(mine.rows.map((r) => r.name)).toEqual(["Assigned One"]);
    expect(mine.stageCounts.NEW).toBe(2);
  });
});

describe("subscriber CSV import", () => {
  const header = "first_name,last_name,company_name,type,phone,email,package,branch_code,address,town";

  it("previews row-level errors without writing subscribers, and blocks commit", async () => {
    const { ctx } = await ownerCtx();
    await createPackage(ctx, pkg);
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "Existing", phone: "0799000000" }));
    const csv = [
      header,
      "Ann,One,,individual,0711000001,ann@example.com,Fibre 20,,Road 1,Nairobi",
      "Bad,Phone,,individual,12345,,,,,",
      "Dup,InFile,,individual,0711000001,,,,,",
      ",,,business,0711000003,,,,,",
      "Existing,Phone,,individual,0799000000,,,,,",
      "Unknown,Pkg,,individual,0711000005,,Gold Plan,,,",
      "Unknown,Branch,,individual,0711000006,,,ZZZ,,",
    ].join("\n");
    const preview = await previewSubscriberImport(ctx, { fileName: "batch.csv", content: csv });
    expect(preview.totalRows).toBe(7);
    expect(preview.validRows).toBe(1);
    expect(preview.errorRows).toBe(6);
    expect(preview.canCommit).toBe(false);
    const fields = preview.errors.map((e) => `${e.row}:${e.field}`);
    expect(fields).toEqual(expect.arrayContaining(["2:phone", "3:phone", "4:companyName", "5:phone", "6:package", "7:branch_code"]));
    expect(await db.subscriber.count()).toBe(1);
    await expect(commitSubscriberImport(ctx, preview.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("commits a clean file in one transaction exactly once", async () => {
    const { org, ctx } = await ownerCtx();
    await createPackage(ctx, pkg);
    const csv = [header, `Ann,One,,individual,0711000001,ann@example.com,Fibre 20,${org.branch.code},Road 1,Nairobi`, ",,Acme Ltd,business,0711000002,,,,,"].join("\r\n");
    const preview = await previewSubscriberImport(ctx, { fileName: "ok.csv", content: csv });
    expect(preview.canCommit).toBe(true);
    expect(await commitSubscriberImport(ctx, preview.jobId)).toEqual({ created: 2 });
    const subs = await db.subscriber.findMany({ orderBy: { accountNumber: "asc" }, include: { subscriptions: true } });
    expect(subs.map((s) => s.displayName)).toEqual(["Ann One", "Acme Ltd"]);
    expect(subs[0]!.subscriptions[0]!.status).toBe("PENDING"); // imported subscriptions await activation
    await expect(commitSubscriberImport(ctx, preview.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rolls back every row if a conflict appears between preview and commit", async () => {
    const { ctx } = await ownerCtx();
    const csv = [header, "Ann,One,,individual,0711000001,,,,,", "Ben,Two,,individual,0711000002,,,,,"].join("\n");
    const preview = await previewSubscriberImport(ctx, { fileName: "race.csv", content: csv });
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "Sneaky", phone: "0711000002" }));
    await expect(commitSubscriberImport(ctx, preview.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.subscriber.count()).toBe(1); // only the sneaky one
    expect((await db.importJob.findUniqueOrThrow({ where: { id: preview.jobId } })).status).toBe("FAILED");
  });

  it("requires the import permission", async () => {
    const { org } = await ownerCtx();
    const { user } = await createStaff(org.organization.id, "sales");
    const sales = await contextFor(user.id, org.organization.id);
    await expect(previewSubscriberImport(sales, { fileName: "x.csv", content: "phone\n0711000001" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("HTTP idempotency and authorization", () => {
  it("replays renewals with the same key, rejects key reuse with a different body, and requires a key", async () => {
    const { org, ctx } = await ownerCtx();
    const p = await createPackage(ctx, pkg);
    const { subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Pay", phone: "0711999000", packageId: p.id }));
    const token = await sessionFor(org.owner.id, org.organization.id);
    const call = (body: unknown, key?: string) =>
      renewRoute(request(`/api/v1/subscriptions/${subscription!.id}/renew`, { body, token, headers: key ? { "idempotency-key": key } : {} }), {
        params: Promise.resolve({ id: subscription!.id, action: "renew" }),
      });

    expect((await call({})).status).toBe(400);
    const first = await call({}, "renew-key-0001");
    const second = await call({}, "renew-key-0001");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await first.json()).data.periodIndex).toBe(1);
    expect((await second.json()).data.periodIndex).toBe(1);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } })).periodIndex).toBe(1);

    const reuse = await call({ reason: "different" }, "renew-key-0001");
    expect(reuse.status).toBe(409);
    expect((await reuse.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("does not store validation failures, so a corrected request can reuse the key", async () => {
    const { org, ctx } = await ownerCtx();
    const p = await createPackage(ctx, pkg);
    const { subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Val", phone: "0711999001", packageId: p.id }));
    const token = await sessionFor(org.owner.id, org.organization.id);
    const suspend = (body: unknown) =>
      renewRoute(request(`/api/v1/subscriptions/${subscription!.id}/suspend`, { body, token, headers: { "idempotency-key": "suspend-key-01" } }), {
        params: Promise.resolve({ id: subscription!.id, action: "suspend" }),
      });
    expect((await suspend({})).status).toBe(400); // reason missing
    const ok = await suspend({ reason: "Requested by customer" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.status).toBe("SUSPENDED");
  });

  it("returns 403 for roles without permission and 400 with field errors for invalid bodies", async () => {
    const { org } = await ownerCtx();
    const { user } = await createStaff(org.organization.id, "support");
    const supportToken = await sessionFor(user.id, org.organization.id);
    const denied = await createSubscriberRoute(request("/api/v1/subscribers", { body: { firstName: "X", phone: "0711000000" }, token: supportToken }), { params: Promise.resolve({}) });
    expect(denied.status).toBe(403);

    const ownerToken = await sessionFor(org.owner.id, org.organization.id);
    const invalid = await createSubscriberRoute(request("/api/v1/subscribers", { body: { firstName: "X", phone: "123" }, token: ownerToken }), { params: Promise.resolve({}) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.fields[0].path).toBe("phone");
  });
});

describe("dashboard KPIs", () => {
  it("normalises recurring revenue to a monthly equivalent", () => {
    expect(monthlyEquivalent(new D("12000"), "YEAR", 1).toFixed(2)).toBe("1000.00");
    expect(monthlyEquivalent(new D("6000"), "MONTH", 3).toFixed(2)).toBe("2000.00");
    expect(monthlyEquivalent(new D("100"), "WEEK", 1).toFixed(2)).toBe("433.33");
    expect(monthlyEquivalent(new D("50"), "DAY", 1).toFixed(2)).toBe("1520.83");
  });

  it("computes counts and MRR from persisted records only", async () => {
    const { ctx } = await ownerCtx();
    const monthly = await createPackage(ctx, pkg);
    const yearly = await createPackage(ctx, { ...pkg, name: "Annual", price: "36000.00", billingUnit: "YEAR" });
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "A", phone: "0711000001", packageId: monthly.id }));
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "B", phone: "0711000002", packageId: yearly.id }));
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "C", phone: "0711000003", packageId: monthly.id, activateSubscription: false }));
    await createLead(ctx, lead());

    const s = await dashboardSummary(ctx);
    expect(s.subscribers).toEqual({ total: 3, newThisMonth: 3 });
    expect(s.subscriptions).toMatchObject({ active: 2, pending: 1, suspended: 0 });
    expect(s.recurringRevenue).toEqual([{ currency: "KES", monthly: "6500.00" }]);
    expect(s.leads).toEqual({ open: 1, wonThisMonth: 0 });
  });

  it("hides metrics the user cannot read", async () => {
    const { org } = await ownerCtx();
    const { user } = await createStaff(org.organization.id, "technician");
    const tech = await contextFor(user.id, org.organization.id);
    const s = await dashboardSummary(tech);
    expect(s.leads).toBeNull();
    expect(s.subscribers).not.toBeNull();
  });
});
