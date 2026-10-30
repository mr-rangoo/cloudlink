import { staffRoute } from "@/server/api/handler";
import { searchQuery, searchRecords } from "@/server/services/search";

/** Record search for the command menu; each record type is filtered by its own read permission and branch scope. */
export const GET = staffRoute({ query: searchQuery }, async ({ ctx, query }) => ({ data: await searchRecords(ctx, query) }));
