import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { applySubscriptionAction } from "@/server/services/subscriptions";
import { createRouter } from "@/server/services/routers";
import { deprovisionSubscriptionNetwork, getNetworkOperation, provisionSubscriptionNetwork, revealNetworkCredentials, syncNetworkSessions } from "@/server/services/network";
import { closeRadiusPool } from "@/server/integrations/radius";
import { integrationStatus } from "@/server/services/integrations";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { FakeRouterOs } from "../support/fake-routeros";
import { installRadiusSchema, radiusQuery } from "../support/radius-schema";
import { testDatabaseUrl } from "../setup/test-db";
import { contextFor, createOrg } from "./fixtures";

/**
 * RADIUS provisioning against real PostgreSQL tables (schema "radius" in the isolated test database), with the
 * fake RouterOS server standing in for the NAS (used to disconnect sessions when access is disabled).
 */
const SCHEMA = "radius";
const url = testDatabaseUrl();
const fake = new FakeRouterOs();
let phoneSeq = 0;
const saved: Record<string, string | undefined> = {};
const KEYS = ["NETWORK_ADAPTER", "RADIUS_DATABASE_URL", "RADIUS_DB_SCHEMA", "ROUTEROS_TIMEOUT_MS"];

beforeAll(async () => {
  await installRadiusSchema(url, SCHEMA);
  await fake.start();
});
afterAll(async () => {
  await closeRadiusPool();
  await fake.stop();
});
beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.NETWORK_ADAPTER = "routeros";
  process.env.RADIUS_DATABASE_URL = url;
  process.env.RADIUS_DB_SCHEMA = SCHEMA;
  process.env.ROUTEROS_TIMEOUT_MS = "400";
  fake.reset();
  await radiusQuery(url, `TRUNCATE "${SCHEMA}".radcheck, "${SCHEMA}".radreply, "${SCHEMA}".radusergroup, "${SCHEMA}".radacct`);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function drain(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await db.backgroundOperation.updateMany({ where: { status: "FAILED" }, data: { runAfter: new Date(0) } });
    const due = await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED", "FAILED"] } }, orderBy: { createdAt: "asc" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1, downloadKbps: 10240, uploadKbps: 5120, networkProfile: "home-10m" }));
  const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Amina", phone: `07${String(30_000_000 + phoneSeq++)}`, packageId: pkg.id, activateSubscription: true }));
  const router = await createRouter(ctx, { name: "NAS-1", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", pppoeAuth: "RADIUS" });
  return { org, ctx, subscriber, subscription: subscription!, router, username: subscriber.accountNumber.toLowerCase() };
}

const rows = (table: string, username: string) => radiusQuery<{ attribute?: string; value?: string; groupname?: string; op?: string }>(url, `SELECT * FROM "${SCHEMA}".${table} WHERE username = $1 ORDER BY id`, [username]);

describe("RADIUS provisioning (FreeRADIUS SQL)", () => {
  it("writes radcheck/radreply/radusergroup, rejects while suspended, and removes on deprovision", async () => {
    const { ctx, subscription, router, username } = await setup();
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    expect(await getNetworkOperation(ctx, operation.id)).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    const { password } = await revealNetworkCredentials(ctx, subscription.id);
    expect(await rows("radcheck", username)).toEqual([expect.objectContaining({ attribute: "Cleartext-Password", op: ":=", value: password })]);
    expect(await rows("radreply", username)).toEqual([expect.objectContaining({ attribute: "Mikrotik-Rate-Limit", value: "5M/10M" })]);
    expect(await rows("radusergroup", username)).toEqual([expect.objectContaining({ groupname: "home-10m" })]);
    expect(fake.tables["/ppp/secret"]).toEqual([]); // RADIUS routers keep no local secrets
    const radiusRow = (await integrationStatus(ctx)).find((x) => x.key === "radius");
    expect(radiusRow).toMatchObject({ status: "ok", mode: "sql" });

    fake.addActivePppoe(username);
    await applySubscriptionAction(ctx, subscription.id, "suspend", { reason: "Non-payment" });
    await drain();
    expect((await rows("radcheck", username)).map((r) => [r.attribute, r.value])).toEqual([
      ["Cleartext-Password", password],
      ["Auth-Type", "Reject"],
    ]);
    expect(fake.tables["/ppp/active"]).toEqual([]); // the NAS session was disconnected through the router API
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("DISABLED");

    await applySubscriptionAction(ctx, subscription.id, "reactivate");
    await drain();
    expect((await rows("radcheck", username)).map((r) => r.attribute)).toEqual(["Cleartext-Password"]);

    await deprovisionSubscriptionNetwork(ctx, subscription.id, { reason: "Contract ended" });
    await drain();
    expect(await rows("radcheck", username)).toEqual([]);
    expect(await rows("radusergroup", username)).toEqual([]);
    expect(await rows("radreply", username)).toEqual([]);
  });

  it("reads active sessions from radacct for the router's NAS address", async () => {
    const { org, ctx, subscription, subscriber, router, username } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    await radiusQuery(
      url,
      `INSERT INTO "${SCHEMA}".radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctsessiontime, acctinputoctets, acctoutputoctets, callingstationid, framedipaddress)
       VALUES ('81a00001', 'u-1', $1, '127.0.0.1', now() - interval '2 minutes', 120, 1000, 250000, 'AA:BB:CC:00:00:09', '10.10.1.5'),
              ('81a00002', 'u-2', 'someone-else', '10.99.0.1', now(), 5, 1, 1, null, null)`,
      [username],
    );
    await syncNetworkSessions(org.organization.id);
    const sessions = await db.networkSession.findMany({ where: { routerId: router.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: "PPPOE", username, subscriberId: subscriber.id, externalId: "81a00001", address: "10.10.1.5", source: "radius_accounting", uptimeSeconds: 120 });
    expect(sessions[0]!.bytesIn).toBe(1000n);
    expect(sessions[0]!.bytesOut).toBe(250000n);
  });

  it("fails clearly when the RADIUS database is not configured", async () => {
    const { ctx, subscription, router } = await setup();
    process.env.RADIUS_DATABASE_URL = "";
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    const op = await getNetworkOperation(ctx, operation.id);
    expect(op).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(op.attemptsLog[0]).toMatchObject({ outcome: "PERMANENT_ERROR", errorCode: "RADIUS_NOT_CONFIGURED" });
    expect(op.alerts).toHaveLength(1);
  });
});
