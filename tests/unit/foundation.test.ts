import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { AppError, toEnvelope } from "@/server/errors";
import { REDACT_PATHS } from "@/server/observability/logger";
import { backoffMs } from "@/server/jobs/operations";
import { formatMoney } from "@/lib/utils";

describe("error envelope", () => {
  it("produces the documented shape with a stable code and correlation ID", () => {
    const env = toEnvelope(new AppError("VALIDATION_ERROR", undefined, { fields: [{ path: "email", message: "Invalid email" }] }), "corr-123");
    expect(env).toEqual({
      error: { code: "VALIDATION_ERROR", message: "The request could not be processed.", correlationId: "corr-123", fields: [{ path: "email", message: "Invalid email" }] },
    });
  });

  it("maps codes to HTTP statuses", () => {
    expect(new AppError("UNAUTHENTICATED").status).toBe(401);
    expect(new AppError("FORBIDDEN").status).toBe(403);
    expect(new AppError("RATE_LIMITED").status).toBe(429);
    expect(new AppError("INTERNAL_ERROR").status).toBe(500);
  });
});

describe("structured logger redaction", () => {
  it("never writes secrets to log output", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
    log.info({ password: "hunter2", req: { headers: { cookie: "session=abc", authorization: "Bearer xyz" } }, mpesa: { passkey: "pk-1", consumerSecret: "cs" } }, "test");
    const out = lines.join("");
    for (const secret of ["hunter2", "session=abc", "Bearer xyz", "pk-1", '"cs"']) expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });
});

describe("job retry backoff", () => {
  it("grows exponentially and is capped at one hour", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });
});

describe("money formatting", () => {
  it("formats decimal strings without floating point conversion", () => {
    expect(formatMoney("1234567.5")).toBe("KES 1,234,567.50");
    expect(formatMoney("0.1")).toBe("KES 0.10");
    expect(formatMoney("-250")).toBe("-KES 250.00");
    expect(formatMoney(null)).toBe("—");
  });
});
