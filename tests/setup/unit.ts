// Deterministic fictional configuration for unit tests. No real secrets.
process.env.APP_ENV ??= "test";
process.env.LOG_LEVEL = "silent";
process.env.APP_URL ??= "http://localhost:3100";
process.env.AUTH_SECRET ??= "unit-test-auth-secret-that-is-long-enough-123456";
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:1/unit";
