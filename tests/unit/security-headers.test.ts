import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { contentSecurityPolicy } from "@/proxy";

describe("post-login redirects", () => {
  it("keeps same-origin paths and rejects everything that could leave the site", () => {
    expect(safeRedirectPath("/invoices?status=OPEN#top")).toBe("/invoices?status=OPEN#top");
    expect(safeRedirectPath("/subscribers/0193a3e4-0000-7000-8000-000000000000")).toBe("/subscribers/0193a3e4-0000-7000-8000-000000000000");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "/%0d%0aLocation:x", "javascript:alert(1)", "/\u0000x", "", undefined, null]) {
      const out = safeRedirectPath(bad as string);
      expect(out === "/dashboard" || out.startsWith("/%0d")).toBe(true);
      expect(new URL(out, "http://cloudlink.invalid").origin).toBe("http://cloudlink.invalid");
    }
  });
});

describe("content security policy", () => {
  it("uses a nonce for scripts and forbids framing, plugins and foreign form targets", () => {
    const csp = contentSecurityPolicy("abc123", "/dashboard", { dev: false, https: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("lets only the captive portal post to the hotspot router, and locks down API responses", () => {
    expect(contentSecurityPolicy("n", "/hotspot/alpha", { dev: false, https: false })).toContain("form-action 'self' http: https:");
    expect(contentSecurityPolicy("n", "/api/v1/subscribers", { dev: false, https: true })).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(contentSecurityPolicy("n", "/login", { dev: true, https: false })).toContain("'unsafe-eval'");
  });
});
