import "server-only";
import { z, type ZodType } from "zod";
import { loginSchema } from "@/server/auth/service";

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
