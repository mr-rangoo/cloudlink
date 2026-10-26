import { paginated, staffRoute } from "@/server/api/handler";
import { conversationListQuery, listAssistantConversations } from "@/server/assistant/service";

export const GET = staffRoute({ permission: "support.read", query: conversationListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listAssistantConversations(ctx, query);
  return paginated(rows, total, query);
});
