import { staffRoute } from "@/server/api/handler";
import { catalogueQuery, packageCatalogue } from "@/server/services/packages";

/** Plans with type, availability, live subscriptions and 30-day revenue (revenue only with payments.read or reports.read). */
export const GET = staffRoute({ permission: "packages.read", query: catalogueQuery }, async ({ ctx, query }) => ({ data: await packageCatalogue(ctx, query) }));
