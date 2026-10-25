import { staffRoute } from "@/server/api/handler";
import { runReconciliationChecks } from "@/server/services/finance";

/** Recompute cached balances from source records and verify the ledger; the result is recorded. */
export const POST = staffRoute({ permission: "payments.reconcile" }, async ({ ctx }) => ({ data: await runReconciliationChecks(ctx) }));
