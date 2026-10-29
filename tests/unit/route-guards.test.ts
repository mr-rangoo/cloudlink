import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Release guard: every API route must go through an authenticated wrapper (staffRoute / customerRoute), or be on
 * the explicit lists below. A new public endpoint therefore needs a deliberate change to this test.
 */
const API_DIR = path.resolve(import.meta.dirname, "../../src/app/api");

const PUBLIC_ROUTES: Record<string, string> = {
  "v1/auth/login/route.ts": "staff sign-in (rate-limited)",
  "v1/auth/invite/route.ts": "staff setup/reset link (single-use token, rate-limited)",
  "v1/customer/auth/login/route.ts": "customer sign-in (rate-limited)",
  "v1/customer/auth/activate/route.ts": "customer activation link (single-use token, rate-limited)",
  "v1/hotspot/[org]/redeem/route.ts": "captive portal redemption (rate-limited)",
  "v1/hotspot/[org]/status/route.ts": "captive portal status (needs the voucher code, rate-limited)",
  "v1/hotspot/[org]/plans/route.ts": "captive portal plan list (public prices only)",
  "v1/hotspot/[org]/purchase/route.ts": "captive portal M-Pesa purchase / free trial (rate-limited, same-origin)",
  "v1/hotspot/[org]/purchase/status/route.ts": "purchase progress (needs the purchase token, rate-limited)",
  "v1/hotspot/[org]/purchase/simulate/route.ts": "test-mode payment simulation (refused in production and for real gateways)",
  "v1/hotspot/[org]/access/route.ts": "router readiness for a login the caller holds (rate-limited)",
  "v1/hotspot/[org]/reconnect/route.ts": "re-issue login details with M-Pesa code + phone (failure rate-limited)",
};
const WEBHOOK_ROUTES = ["v1/webhooks/mobile-money/stk/[token]/route.ts", "v1/webhooks/mobile-money/c2b/[token]/confirmation/route.ts", "v1/webhooks/mobile-money/c2b/[token]/validation/route.ts"];
const RAW_ROUTES: Record<string, string> = {
  "v1/health/live/route.ts": "liveness, no data",
  "v1/health/ready/route.ts": "readiness, coarse statuses only",
  "v1/openapi.json/route.ts": "API contract, no tenant data",
  "v1/routers/setup/[token]/route.ts": "router setup script (single-use token, rate-limited)",
  "v1/branding/[slug]/logo/route.ts": "organization logo image for portal/hotspot pages (public by design)",
  "v1/hotspot-files/[routerId]/login.html/route.ts": "router hotspot login page that redirects to the captive portal (no secrets, rate-limited)",
};

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
}

describe("API route guards", () => {
  const files = routeFiles(API_DIR).map((f) => ({ rel: path.relative(API_DIR, f).split(path.sep).join("/"), src: fs.readFileSync(f, "utf8") }));

  it("finds the API routes", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("protects every route or lists it explicitly", () => {
    const problems: string[] = [];
    for (const { rel, src } of files) {
      const methods = [...src.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      if (!methods.length) problems.push(`${rel}: no handlers`);
      const authed = /\b(staffRoute|customerRoute)\(/.test(src);
      const isPublic = /\bpublicRoute\(/.test(src);
      const isWebhook = /\bwebhookRoute\(/.test(src);
      if (isPublic && !PUBLIC_ROUTES[rel]) problems.push(`${rel}: publicRoute is not on the public allowlist`);
      if (isWebhook && !WEBHOOK_ROUTES.includes(rel)) problems.push(`${rel}: webhookRoute is not on the webhook allowlist`);
      if (!authed && !isPublic && !isWebhook && !RAW_ROUTES[rel]) problems.push(`${rel}: not wrapped by staffRoute/customerRoute`);
      // Every exported handler of a protected file must be created by the wrapper.
      for (const m of src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)\(/g)) {
        if (!["staffRoute", "customerRoute", "publicRoute", "webhookRoute"].includes(m[2]!)) problems.push(`${rel}: ${m[1]} built with ${m[2]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the allowlists honest", () => {
    const rels = new Set(files.map((f) => f.rel));
    for (const rel of [...Object.keys(PUBLIC_ROUTES), ...WEBHOOK_ROUTES, ...Object.keys(RAW_ROUTES)]) expect(rels.has(rel), rel).toBe(true);
  });

  it("keeps UI components out of server and worker code (the worker runs under the react-server condition)", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const src = path.resolve(import.meta.dirname, "../../src");
    const offenders = [...walk(path.join(src, "server")), ...walk(path.join(src, "worker"))].filter((f) => /from "@\/components\//.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(src, f));
    expect(offenders).toEqual([]);
  });

  it("checks permissions on staff mutations", () => {
    const missing = files
      .filter(({ src }) => /staffRoute\(\{[^}]*\}/.test(src))
      .flatMap(({ rel, src }) => [...src.matchAll(/export const (POST|PUT|PATCH|DELETE) = staffRoute\(\{([^)]*?)\},/gs)].filter((m) => !/permission:/.test(m[2]!)).map((m) => `${rel} ${m[1]}`))
      // Own-session actions that need no permission (switching re-verifies membership and branch scope in the service).
      .filter((r) => !/^v1\/auth\/(logout|session)\//.test(r));
    expect(missing).toEqual([]);
  });
});
