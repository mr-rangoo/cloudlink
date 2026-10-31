import { paginated, staffRoute } from "@/server/api/handler";
import { enrolInput, enrolTr069Device, listTr069Devices, tr069ListQuery } from "@/server/services/tr069";

export const GET = staffRoute({ permission: "inventory.read", query: tr069ListQuery }, async ({ ctx, query }) => {
  const { rows, total, summary, acs } = await listTr069Devices(ctx, query);
  return { ...paginated(rows, total, query), summary, acs };
});

/** Enrol a device by serial number (optionally for a subscriber). Its status comes from the ACS. */
export const POST = staffRoute({ permission: "inventory.write", body: enrolInput }, async ({ ctx, body }) => ({ data: await enrolTr069Device(ctx, body), status: 201 }));
