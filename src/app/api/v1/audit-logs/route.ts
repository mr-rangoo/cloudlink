import { paginated, staffRoute } from "@/server/api/handler";
import { auditQuery, searchAuditLogs } from "@/server/services/admin";

export const GET = staffRoute({ permission: "audit.read", query: auditQuery }, async ({ ctx, query }) => {
  const { rows, total } = await searchAuditLogs(ctx, query);
  return paginated(rows, total, query);
});
