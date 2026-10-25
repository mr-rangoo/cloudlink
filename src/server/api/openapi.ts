import "server-only";
import { z, type ZodType } from "zod";
import { loginSchema } from "@/server/auth/service";
import { packageInput, packageListQuery, packageUpdate } from "@/server/services/packages";
import { noteInput, subscriberInput, subscriberListQuery, subscriberUpdate } from "@/server/services/subscribers";
import { subscriptionActionInput, subscriptionCreateInput, subscriptionListQuery } from "@/server/services/subscriptions";
import { leadActivityInput, leadConvertInput, leadInput, leadListQuery, leadUpdate } from "@/server/services/leads";
import { importPreviewInput } from "@/server/services/imports";

/**
 * OpenAPI 3.1 document generated from the same Zod schemas the handlers validate with.
 * Each phase registers its endpoints here; `tests/unit/openapi.test.ts` checks the document stays valid.
 */
interface Operation {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  summary: string;
  tag: string;
  auth: "session" | "none" | "webhook";
  permission?: string;
  body?: ZodType;
  query?: ZodType;
  idempotent?: boolean;
  responses?: Record<string, string>;
}

const errorEnvelope = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "correlationId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        correlationId: { type: "string" },
        fields: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
      },
    },
  },
} as const;

export const operations: Operation[] = [
  { method: "get", path: "/health/live", summary: "Liveness probe", tag: "Health", auth: "none" },
  { method: "get", path: "/health/ready", summary: "Readiness probe (database required, Redis reported)", tag: "Health", auth: "none", responses: { "503": "Not ready" } },
  { method: "post", path: "/auth/login", summary: "Staff sign-in (sets HTTP-only session cookie)", tag: "Auth", auth: "none", body: loginSchema, responses: { "401": "Invalid credentials", "429": "Rate limited" } },
  { method: "post", path: "/auth/logout", summary: "Revoke the current session", tag: "Auth", auth: "session" },
  { method: "get", path: "/auth/session", summary: "Current user, organization, roles, permissions and branches", tag: "Auth", auth: "session" },
  {
    method: "patch",
    path: "/auth/session",
    summary: "Switch active organization or branch filter",
    tag: "Auth",
    auth: "session",
    body: z.object({ organizationId: z.uuid().optional(), branchId: z.uuid().nullable().optional() }),
  },
  { method: "get", path: "/dashboard/summary", summary: "Database-backed KPIs (metric definitions in docs)", tag: "Dashboard", auth: "session", permission: "dashboard.view" },
  { method: "get", path: "/dashboard/activity", summary: "Recent subscriber activity", tag: "Dashboard", auth: "session", permission: "dashboard.view" },
  { method: "get", path: "/packages", summary: "List packages", tag: "Packages", auth: "session", permission: "packages.read", query: packageListQuery },
  { method: "post", path: "/packages", summary: "Create package", tag: "Packages", auth: "session", permission: "packages.write", body: packageInput },
  { method: "get", path: "/packages/:id", summary: "Get package", tag: "Packages", auth: "session", permission: "packages.read" },
  { method: "patch", path: "/packages/:id", summary: "Update package (existing subscriptions keep their snapshot)", tag: "Packages", auth: "session", permission: "packages.write", body: packageUpdate },
  { method: "get", path: "/subscribers", summary: "List subscribers (paginated)", tag: "Subscribers", auth: "session", permission: "subscribers.read", query: subscriberListQuery },
  { method: "post", path: "/subscribers", summary: "Create subscriber (optionally with first subscription)", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: subscriberInput, responses: { "409": "Duplicate contact" } },
  { method: "get", path: "/subscribers/:id", summary: "Get subscriber", tag: "Subscribers", auth: "session", permission: "subscribers.read" },
  { method: "patch", path: "/subscribers/:id", summary: "Update subscriber", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: subscriberUpdate },
  { method: "get", path: "/subscribers/:id/activity", summary: "Subscriber activity timeline", tag: "Subscribers", auth: "session", permission: "subscribers.read" },
  { method: "post", path: "/subscribers/:id/activity", summary: "Add a note", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: noteInput },
  { method: "post", path: "/subscribers/:id/renew", summary: "Renew the subscriber's subscription", tag: "Subscribers", auth: "session", permission: "subscriptions.write", idempotent: true },
  { method: "post", path: "/subscribers/:id/suspend", summary: "Suspend the subscriber's subscription", tag: "Subscribers", auth: "session", permission: "subscriptions.write" },
  { method: "post", path: "/subscribers/:id/reactivate", summary: "Reactivate the subscriber's subscription", tag: "Subscribers", auth: "session", permission: "subscriptions.write" },
  { method: "post", path: "/subscribers/imports", summary: "Validate a CSV and create an import preview", tag: "Subscribers", auth: "session", permission: "subscribers.import", body: importPreviewInput },
  { method: "get", path: "/subscribers/imports", summary: "Recent import jobs", tag: "Subscribers", auth: "session", permission: "subscribers.import" },
  { method: "post", path: "/subscribers/imports/:id/commit", summary: "Commit a clean preview (all rows or none)", tag: "Subscribers", auth: "session", permission: "subscribers.import" },
  { method: "get", path: "/subscriptions", summary: "List subscriptions", tag: "Subscriptions", auth: "session", permission: "subscriptions.read", query: subscriptionListQuery },
  { method: "post", path: "/subscriptions", summary: "Create subscription", tag: "Subscriptions", auth: "session", permission: "subscriptions.write", body: subscriptionCreateInput },
  { method: "get", path: "/subscriptions/:id", summary: "Get subscription with event history", tag: "Subscriptions", auth: "session", permission: "subscriptions.read" },
  ...(["activate", "renew", "suspend", "reactivate", "cancel"] as const).map((a) => ({
    method: "post" as const,
    path: `/subscriptions/:id/${a}`,
    summary: `${a.charAt(0).toUpperCase()}${a.slice(1)} subscription`,
    tag: "Subscriptions",
    auth: "session" as const,
    permission: "subscriptions.write",
    body: subscriptionActionInput,
    idempotent: a === "renew",
  })),
  { method: "get", path: "/leads", summary: "List leads with stage counts", tag: "CRM", auth: "session", permission: "leads.read", query: leadListQuery },
  { method: "post", path: "/leads", summary: "Create lead", tag: "CRM", auth: "session", permission: "leads.write", body: leadInput },
  { method: "get", path: "/leads/:id", summary: "Get lead with timeline", tag: "CRM", auth: "session", permission: "leads.read" },
  { method: "patch", path: "/leads/:id", summary: "Update lead / stage / owner", tag: "CRM", auth: "session", permission: "leads.write", body: leadUpdate },
  { method: "post", path: "/leads/:id/activities", summary: "Log a call, note, meeting or survey", tag: "CRM", auth: "session", permission: "leads.write", body: leadActivityInput },
  { method: "post", path: "/leads/:id/convert", summary: "Convert lead to subscriber atomically", tag: "CRM", auth: "session", permission: "leads.write + subscribers.write", body: leadConvertInput, responses: { "409": "Already converted or duplicate contact" } },
];

/** Register additional operations (called by feature modules at import time). */
export function registerOperations(ops: Operation[]): void {
  for (const op of ops) {
    if (!operations.some((o) => o.method === op.method && o.path === op.path)) operations.push(op);
  }
}

function jsonSchema(schema: ZodType) {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
}

export function buildOpenApiDocument(serverUrl = "/api/v1") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const oasPath = op.path.replace(/:(\w+)/g, "{$1}");
    const params = [...op.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    if (op.idempotent) params.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } });
    if (op.query) {
      const qs = jsonSchema(op.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(qs.properties ?? {})) {
        params.push({ name, in: "query", required: qs.required?.includes(name) ?? false, schema: schema as { type: string } });
      }
    }
    const responses: Record<string, unknown> = {
      "200": { description: "Success" },
      ...(op.auth === "session" ? { "401": { description: "Not authenticated" }, "403": { description: "Forbidden" } } : {}),
      "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    };
    for (const [code, description] of Object.entries(op.responses ?? {})) responses[code] = { description };

    paths[oasPath] ??= {};
    paths[oasPath][op.method] = {
      summary: op.summary,
      tags: [op.tag],
      ...(op.permission ? { description: `Requires permission \`${op.permission}\`.` } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } } } : {}),
      ...(op.auth === "session" ? { security: [{ session: [] }] } : { security: [] }),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Cloudlink API", version: "1.0.0", description: "ISP billing, payments and network operations API. All money values are decimal strings with an explicit currency." },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { session: { type: "apiKey", in: "cookie", name: "cloudlink_session" } },
      schemas: { Error: errorEnvelope },
    },
    paths,
  };
}
