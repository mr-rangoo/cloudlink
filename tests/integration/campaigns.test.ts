import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput, subscriberUpdate, updateSubscriber } from "@/server/services/subscribers";
import { savePreferences } from "@/server/services/notifications";
import { cancelCampaign, createCampaign, dispatchCampaign, listCampaigns, previewCampaign, sendCampaign } from "@/server/services/campaigns";
import { saveOperatorAlertSettings, sendDailyDigest } from "@/server/services/operator-alerts";
import { createRouter, runRouterHealthChecks } from "@/server/services/routers";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { fromWallTime, toWallTime } from "@/server/domain/time";
import { contextFor, createOrg, createStaff } from "./fixtures";

let phoneSeq = 0;
const nextPhone = () => `07${String(85_000_000 + phoneSeq++).padStart(8, "0")}`;

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const fibre = await createPackage(ctx, { name: "Fibre 10", serviceType: "PPPOE", price: "2000.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
  const make = async (firstName: string, packageId?: string) =>
    (await createSubscriber(ctx, subscriberInput.parse({ firstName, phone: nextPhone(), ...(packageId ? { packageId, activateSubscription: true } : {}) }))).subscriber;
  return { org, ctx, fibre, make };
}

async function runDue(type: string) {
  for (const op of await db.backgroundOperation.findMany({ where: { type, status: { in: ["PENDING", "QUEUED"] } } })) await runOperation(op.id, operationHandlers);
}

const campaignMessages = (campaignId: string) => db.notification.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });

describe("campaigns", () => {
  it("service notices reach the filtered audience except those who opted out, once", async () => {
    const { org, ctx, fibre, make } = await setup();
    const a = await make("Amina", fibre.id);
    const b = await make("Brian", fibre.id);
    await make("Chao"); // no plan: outside the audience
    await savePreferences(org.organization.id, b.id, { preferences: [{ category: "service", channel: "SMS", enabled: false }] });

    const draft = { name: "Fibre cut Ruaka", channel: "SMS" as const, kind: "service" as const, body: "Hi {{name}}, a fibre cut affects {{packageName}} in Ruaka. Engineers are on site.", audience: { subscription: "ACTIVE" as const } };
    expect(await previewCampaign(ctx, draft)).toMatchObject({ matched: 2, willReceive: 1, excluded: 1, sample: { body: expect.stringContaining("Fibre 10") } });
    const c = await createCampaign(ctx, draft);
    expect(c.status).toBe("DRAFT");
    expect(await db.notification.count({ where: { campaignId: c.id } })).toBe(0);

    await sendCampaign(ctx, c.id, {});
    await runDue("campaigns.dispatch");
    const msgs = await campaignMessages(c.id);
    expect(msgs).toHaveLength(2);
    expect(msgs.find((m) => m.subscriberId === a.id)).toMatchObject({ status: "QUEUED", category: "service", templateKey: "campaign", body: expect.stringContaining("Hi Amina") });
    expect(msgs.find((m) => m.subscriberId === b.id)).toMatchObject({ status: "SKIPPED", lastError: "OPTED_OUT" });
    expect(await db.messageCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "SENT", recipients: 2, queued: 1, skipped: 1 });

    // A retried dispatch writes nothing twice; a campaign is sent once.
    await db.messageCampaign.update({ where: { id: c.id }, data: { status: "SENDING" } });
    await dispatchCampaign(c.id);
    expect(await campaignMessages(c.id)).toHaveLength(2);
    await expect(sendCampaign(ctx, c.id, {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    const listed = (await listCampaigns(ctx)).find((x) => x.id === c.id)!;
    expect(listed.delivery).toMatchObject({ queued: 1, skipped: 1 });
  });

  it("offers go only to customers who agreed", async () => {
    const { ctx, fibre, make } = await setup();
    const a = await make("Amina", fibre.id);
    await make("Brian", fibre.id);
    const offer = { name: "Upgrade offer", channel: "SMS" as const, kind: "marketing" as const, body: "{{organization}}: double speed for a month, ask us!", audience: {} };
    expect((await previewCampaign(ctx, offer)).willReceive).toBe(0);
    await updateSubscriber(ctx, a.id, subscriberUpdate.parse({ marketingConsent: true }));
    expect((await previewCampaign(ctx, offer)).willReceive).toBe(1);
    const c = await createCampaign(ctx, offer);
    await sendCampaign(ctx, c.id, {});
    await runDue("campaigns.dispatch");
    const msgs = await campaignMessages(c.id);
    expect(msgs.filter((m) => m.status === "QUEUED").map((m) => m.subscriberId)).toEqual([a.id]);
    expect(msgs.filter((m) => m.status === "SKIPPED").every((m) => m.lastError === "NO_MARKETING_CONSENT")).toBe(true);
    expect(await db.subscriberActivity.count({ where: { subscriberId: a.id, type: "consent" } })).toBe(1);
  });

  it("validates messages, schedules and cancels, keeps branch scope and needs permission", async () => {
    const { org, ctx, fibre, make } = await setup();
    await expect(createCampaign(ctx, { name: "Bad", channel: "SMS", kind: "service", body: "Hello {{nickname}}" })).rejects.toThrow();
    await expect(createCampaign(ctx, { name: "Long", channel: "SMS", kind: "service", body: "x".repeat(481) })).rejects.toThrow();
    await expect(createCampaign(ctx, { name: "Mail", channel: "EMAIL", kind: "service", body: "Body text" })).rejects.toThrow();

    const c = await createCampaign(ctx, { name: "Later", channel: "SMS", kind: "service", body: "Planned maintenance tonight." });
    const scheduled = await sendCampaign(ctx, c.id, { scheduledAt: new Date(Date.now() + 3_600_000) });
    expect(scheduled.status).toBe("SCHEDULED");
    expect((await db.backgroundOperation.findFirstOrThrow({ where: { dedupeKey: `campaign:${c.id}` } })).runAfter.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    expect((await cancelCampaign(ctx, c.id)).status).toBe("CANCELLED");
    expect(await dispatchCampaign(c.id)).toMatchObject({ status: "CANCELLED" });
    await expect(sendCampaign(ctx, c.id, { scheduledAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // A branch-restricted creator reaches only their branch.
    const branch = await db.branch.create({ data: { organizationId: org.organization.id, name: "Thika", code: "THK" } });
    const inBranch = await make("Wanjiku", fibre.id);
    await db.subscriber.update({ where: { id: inBranch.id }, data: { branchId: branch.id } });
    await make("Otieno", fibre.id);
    const admin = await createStaff(org.organization.id, "admin", { branchIds: [branch.id] });
    const scoped = await contextFor(admin.user.id, org.organization.id);
    const local = await createCampaign(scoped, { name: "Thika notice", channel: "SMS", kind: "service", body: "Thika maintenance." });
    await sendCampaign(scoped, local.id, {});
    await runDue("campaigns.dispatch");
    expect((await campaignMessages(local.id)).map((m) => m.subscriberId)).toEqual([inBranch.id]);

    const support = await createStaff(org.organization.id, "support");
    await expect(createCampaign(await contextFor(support.user.id, org.organization.id), { name: "Nope", channel: "SMS", kind: "service", body: "Hello there" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await createOrg("Other ISP");
    await expect(sendCampaign(await contextFor(other.owner.id, other.organization.id), local.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("operator alerts", () => {
  it("text the chosen people when a router goes offline, once per alert, and send the daily digest at its hour", async () => {
    const { org, ctx } = await setup();
    await expect(saveOperatorAlertSettings(ctx, { recipients: [{ channel: "SMS", to: "12345" }], events: ["router_offline"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const tz = "Africa/Nairobi";
    const hour = toWallTime(new Date(), tz).hour;
    await saveOperatorAlertSettings(ctx, { recipients: [{ channel: "SMS", to: "0712 000 999", label: "NOC" }, { channel: "EMAIL", to: "Noc@Isp.example" }], events: ["router_offline", "daily_digest"], digestHour: hour });
    await createRouter(ctx, { name: "Edge [offline]", host: "10.0.0.5", username: "api", password: "secret-pass" });
    await runRouterHealthChecks(org.organization.id);
    await runRouterHealthChecks(org.organization.id); // still offline: same open alert, no second message
    const alerts = await db.notification.findMany({ where: { organizationId: org.organization.id, templateKey: "operator.alert" } });
    expect(alerts.map((a) => [a.channel, a.recipient]).sort()).toEqual([
      ["EMAIL", "noc@isp.example"],
      ["SMS", "254712000999"],
    ]);
    expect(alerts[0]!.body).toContain("Edge [offline] is unreachable");
    expect(alerts.every((a) => a.subscriberId === null && a.status === "QUEUED")).toBe(true);

    expect(await sendDailyDigest(org.organization.id)).toEqual({ sent: 2 });
    expect(await sendDailyDigest(org.organization.id)).toEqual({ sent: 0 }); // once per day
    const digest = await db.notification.findFirstOrThrow({ where: { organizationId: org.organization.id, templateKey: "operator.digest", channel: "SMS" } });
    expect(digest.body).toMatch(/collected KES 0\.00 \(0 payments\).*1 routers offline/);
    const w = toWallTime(new Date(), tz);
    const otherHour = fromWallTime({ ...w, hour: (w.hour + 5) % 24 }, tz);
    expect(await sendDailyDigest(org.organization.id, otherHour)).toEqual({ sent: 0 });

    // Events not chosen send nothing.
    await saveOperatorAlertSettings(ctx, { recipients: [{ channel: "SMS", to: "0712000999" }], events: [] });
    await createRouter(ctx, { name: "Core [offline]", host: "10.0.0.6", username: "api", password: "secret-pass" });
    await runRouterHealthChecks(org.organization.id);
    expect(await db.notification.count({ where: { organizationId: org.organization.id, templateKey: "operator.alert" } })).toBe(2);
  });
});
