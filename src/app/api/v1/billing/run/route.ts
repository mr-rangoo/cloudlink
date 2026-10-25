import { staffRoute } from "@/server/api/handler";
import { audit } from "@/server/audit/audit";
import { runRecurringBilling } from "@/server/services/invoices";

/** Run recurring billing now (the worker also runs it hourly). Safe to repeat: invoices are unique per period. */
export const POST = staffRoute({ permission: "invoices.issue" }, async ({ ctx }) => {
  const result = await runRecurringBilling(ctx);
  await audit(ctx, { action: "billing.run_manual", metadata: result });
  return { data: result };
});
