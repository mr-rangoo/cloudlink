import { z } from "zod";
import { staffRoute, uuidParam } from "@/server/api/handler";
import { resolveRouterAlert } from "@/server/services/routers";

const body = z.object({ note: z.string().trim().max(300).optional() });

export const POST = staffRoute({ permission: "network.operate", params: uuidParam, body }, async ({ ctx, params, body }) => ({ data: await resolveRouterAlert(ctx, params.id, body.note) }));
