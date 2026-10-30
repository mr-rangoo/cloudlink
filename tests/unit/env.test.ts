import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "@/server/env";

const base = {
  APP_URL: "http://localhost:3100",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_SECRET: "a-very-long-development-secret-value-0123456789",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("environment validation", () => {
  it("accepts a valid development configuration with mock adapters", () => {
    const env = parseEnv({ ...base, APP_ENV: "development", PAYMENT_ADAPTER: "mock", NETWORK_ADAPTER: "mock" });
    expect(env.PAYMENT_ADAPTER).toBe("mock");
    expect(env.APP_TIMEZONE).toBe("Africa/Nairobi");
    expect(env.DEFAULT_CURRENCY).toBe("KES");
  });

  it("rejects a short AUTH_SECRET and a malformed encryption key without echoing values", () => {
    try {
      parseEnv({ ...base, AUTH_SECRET: "short", APP_ENCRYPTION_KEY: "not-a-key" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain("AUTH_SECRET");
      expect(msg).toContain("APP_ENCRYPTION_KEY");
      expect(msg).not.toContain("not-a-key");
    }
  });

  it("forbids mock adapters, demo seed and http in production", () => {
    try {
      parseEnv({ ...base, APP_ENV: "production", PAYMENT_ADAPTER: "mock", NETWORK_ADAPTER: "mock", MESSAGING_ADAPTER: "mock", ENABLE_DEMO_SEED: "true" });
      expect.unreachable();
    } catch (err) {
      const issues = (err as EnvValidationError).issues.join("\n");
      expect(issues).toMatch(/PAYMENT_ADAPTER/);
      expect(issues).toMatch(/NETWORK_ADAPTER/);
      expect(issues).toMatch(/MESSAGING_ADAPTER/);
      expect(issues).toMatch(/ENABLE_DEMO_SEED/);
      expect(issues).toMatch(/APP_URL: must use https/);
    }
  });

  it("accepts a production configuration with real adapters", () => {
    const env = parseEnv({
      ...base,
      APP_ENV: "production",
      APP_URL: "https://billing.example.co.ke",
      PAYMENT_ADAPTER: "daraja",
      NETWORK_ADAPTER: "routeros",
      MIKROTIK_CONNECTION_MODE: "api-ssl",
      MIKROTIK_ALLOWED_NETWORKS: "10.8.0.0/24",
      MESSAGING_ADAPTER: "smtp",
      ENABLE_DEMO_SEED: "false",
    });
    expect(env.APP_ENV).toBe("production");
  });

  it("guards the AI assistant settings in production", () => {
    const prod = { ...base, APP_ENV: "production", APP_URL: "https://billing.example.co.ke", PAYMENT_ADAPTER: "disabled", NETWORK_ADAPTER: "disabled", MESSAGING_ADAPTER: "disabled" };
    expect(parseEnv(prod).ASSISTANT_ADAPTER).toBe("disabled"); // off unless configured
    const issues = (src: Record<string, string>) => {
      try {
        parseEnv(src);
        return "";
      } catch (err) {
        return (err as EnvValidationError).issues.join("\n");
      }
    };
    expect(issues({ ...prod, ASSISTANT_ADAPTER: "mock" })).toMatch(/ASSISTANT_ADAPTER: mock assistant is not allowed/);
    expect(issues({ ...prod, ASSISTANT_ADAPTER: "anthropic" })).toMatch(/ANTHROPIC_API_KEY: is required/);
    expect(issues({ ...prod, ASSISTANT_ADAPTER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x", ASSISTANT_BASE_URL: "http://127.0.0.1:9" })).toMatch(/ASSISTANT_BASE_URL/);
    expect(issues({ ...prod, ASSISTANT_ADAPTER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-secret-value", ASSISTANT_MODEL: "gpt-4" })).toMatch(/ASSISTANT_MODEL: must be a Claude model id/);
    expect(issues({ ...prod, ASSISTANT_ADAPTER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-secret-value", ASSISTANT_MODEL: "gpt-4" })).not.toContain("sk-ant-secret-value");
    expect(parseEnv({ ...prod, ASSISTANT_ADAPTER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ ASSISTANT_MODEL: "claude-opus-5-5", ASSISTANT_EFFORT: "low" });
  });

  it("accepts PAYMENT_ADAPTER=live and refuses the test-only Kopo Kopo override in production", () => {
    const prod = { ...base, APP_ENV: "production", APP_URL: "https://billing.example.co.ke", PAYMENT_ADAPTER: "live", NETWORK_ADAPTER: "disabled", MESSAGING_ADAPTER: "disabled" };
    expect(parseEnv(prod).PAYMENT_ADAPTER).toBe("live");
    expect(() => parseEnv({ ...prod, KOPOKOPO_BASE_URL: "http://127.0.0.1:9" })).toThrow(/KOPOKOPO_BASE_URL/);
  });

  it("rejects placeholder secrets in production", () => {
    expect(() =>
      parseEnv({
        ...base,
        APP_ENV: "production",
        APP_URL: "https://x.example",
        AUTH_SECRET: "replace-with-a-long-random-development-secret",
        PAYMENT_ADAPTER: "disabled",
        NETWORK_ADAPTER: "disabled",
        MESSAGING_ADAPTER: "disabled",
      }),
    ).toThrow(/placeholder/);
  });
});
