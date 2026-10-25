import { z } from "zod";
import { paginated, staffRoute } from "@/server/api/handler";
import { listLedgerEntries } from "@/server/services/ledger";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  account: z.string().regex(/^\d{4}$/).optional(),
  subscriberId: z.uuid().optional(),
});

export const GET = staffRoute({ permission: "ledger.read", query }, async ({ ctx, query }) => {
  const { rows, total } = await listLedgerEntries(ctx, query);
  return paginated(rows, total, query);
});
