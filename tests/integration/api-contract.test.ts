import { describe, expect, it } from "vitest";
import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { GET as live } from "@/app/api/v1/health/live/route";
import { GET as ready } from "@/app/api/v1/health/ready/route";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { createOrg, createStaff, noParams, request, sessionFor } from "./fixtures";

// A representative protected endpoint built with the same wrapper as production routes.
const refundLike = staffRoute(
  { permission: "payments.refund", body: z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }), requireIdempotencyKey: true },
  async ({ body }) => ({ data: { accepted: body.amount }, status: 201 }),
);

describe("API contract and protections", () => {
  it("returns 401 with the error envelope when unauthenticated", async () => {
    const res = await refundLike(request("/api/v1/x", { body: { amount: "10" } }), noParams);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("UNAUTHENTICATED");
    expect(json.error.correlationId).toBe(res.headers.get("x-correlation-id"));
  });

  it("returns 403 when the role lacks the permission (cashier cannot refund)", async () => {
    const { organization } = await createOrg();
    const { user } = await createStaff(organization.id, "cashier");
    const token = await sessionFor(user.id, organization.id);
    const res = await refundLike(request("/api/v1/x", { body: { amount: "10" }, token, headers: { "idempotency-key": "idem-key-0001" } }), noParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("validates bodies and idempotency keys, and allows authorized requests", async () => {
    const { organization } = await createOrg();
    const { user } = await createStaff(organization.id, "accountant");
    const token = await sessionFor(user.id, organization.id);

    const noKey = await refundLike(request("/api/v1/x", { body: { amount: "10" }, token }), noParams);
    expect(noKey.status).toBe(400);

    const bad = await refundLike(request("/api/v1/x", { body: { amount: "10.999" }, token, headers: { "idempotency-key": "idem-key-0002" } }), noParams);
    expect(bad.status).toBe(400);
    const badJson = await bad.json();
    expect(badJson.error.code).toBe("VALIDATION_ERROR");
    expect(badJson.error.fields[0].path).toBe("amount");

    const ok = await refundLike(request("/api/v1/x", { body: { amount: "10.50" }, token, headers: { "idempotency-key": "idem-key-0003" } }), noParams);
    expect(ok.status).toBe(201);
    expect((await ok.json()).data.accepted).toBe("10.50");
  });

  it("rejects cross-site mutations (missing or foreign Origin)", async () => {
    const { owner, organization } = await createOrg();
    const token = await sessionFor(owner.id, organization.id);
    const foreign = await refundLike(request("/api/v1/x", { body: { amount: "1" }, token, origin: "https://evil.example" }), noParams);
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("BAD_ORIGIN");
    const missing = await refundLike(request("/api/v1/x", { body: { amount: "1" }, token, origin: null }), noParams);
    expect(missing.status).toBe(403);
    const login = await loginRoute(request("/api/v1/auth/login", { body: { email: "a@b.co", password: "x" }, origin: "https://evil.example" }), noParams);
    expect(login.status).toBe(403);
  });

  it("rejects malformed JSON safely", async () => {
    const req = request("/api/v1/auth/login", { method: "POST" });
    const malformed = new Request(req.url, { method: "POST", headers: req.headers, body: "{not json" });
    const { NextRequest } = await import("next/server");
    const res = await loginRoute(new NextRequest(malformed), noParams);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/valid JSON/);
  });

  it("exposes liveness and readiness without sensitive details", async () => {
    expect((await live()).status).toBe(200);
    const res = await ready();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.checks.database).toBe("ok");
    expect(json.checks.redis).toBe("not_configured");
    expect(JSON.stringify(json)).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("enforces the PostgreSQL rate limiter atomically under concurrency", async () => {
    const rule = { name: "test:concurrent", limit: 5, windowSeconds: 60 };
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeRateLimit(rule, "same-subject")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
  });
});
