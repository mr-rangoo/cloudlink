import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/server/api/openapi";

describe("OpenAPI document", () => {
  it("is a valid-looking OpenAPI 3.1 document generated from Zod schemas", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    const login = doc.paths["/auth/login"]?.post as { requestBody: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } };
    expect(Object.keys(login.requestBody.content["application/json"].schema.properties)).toEqual(["email", "password"]);
    const session = doc.paths["/auth/session"]?.get as { security: unknown[]; responses: Record<string, unknown> };
    expect(session.security).toEqual([{ session: [] }]);
    expect(session.responses["401"]).toBeDefined();
  });
});
