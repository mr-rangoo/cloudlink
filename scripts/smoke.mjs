#!/usr/bin/env node
// Release smoke test against a running Cloudlink deployment. Read-only except an optional sign-in/sign-out.
//
//   node scripts/smoke.mjs --base https://billing.example.co.ke [--worker http://127.0.0.1:3199]
//   SMOKE_EMAIL=… SMOKE_PASSWORD=… node scripts/smoke.mjs --base …   # also checks a real staff session
//
// Exit code 0 only when every check passes.
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const base = arg("base", process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const worker = arg("worker", process.env.SMOKE_WORKER_URL);
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ check: name, ok: true, detail: detail ?? "" });
  } catch (err) {
    results.push({ check: name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });

await check("liveness", async () => {
  const r = await get("/api/v1/health/live");
  assert(r.status === 200 && (await r.json()).status === "ok", `HTTP ${r.status}`);
});
await check("readiness", async () => {
  const r = await get("/api/v1/health/ready");
  const body = await r.json();
  assert(r.status === 200 && body.status === "ready", `HTTP ${r.status} ${JSON.stringify(body)}`);
  return JSON.stringify(body.checks);
});
await check("login page, security headers and CSP nonce", async () => {
  const r = await get("/login");
  assert(r.status === 200, `HTTP ${r.status}`);
  const csp = r.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert(nonce, "no CSP nonce");
  assert(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp), "CSP too weak");
  assert(r.headers.get("x-frame-options") === "DENY", "X-Frame-Options missing");
  assert(r.headers.get("x-content-type-options") === "nosniff", "nosniff missing");
  assert(!r.headers.get("x-powered-by"), "X-Powered-By present");
  if (base.startsWith("https://")) assert(/max-age=\d+/.test(r.headers.get("strict-transport-security") ?? ""), "HSTS missing");
  const html = await r.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  const unsigned = scripts.filter((s) => !s.includes(`nonce="${nonce}"`));
  assert(scripts.length > 0 && unsigned.length === 0, `${unsigned.length} of ${scripts.length} script tags without the nonce`);
  return `${scripts.length} scripts carry the nonce`;
});
await check("staff pages require a session", async () => {
  const r = await get("/dashboard");
  assert([302, 303, 307, 308].includes(r.status) && (r.headers.get("location") ?? "").includes("/login"), `HTTP ${r.status}`);
});
await check("API refuses anonymous access with the error envelope", async () => {
  const r = await get("/api/v1/subscribers");
  const body = await r.json();
  assert(r.status === 401 && body.error?.code === "UNAUTHENTICATED" && body.error?.correlationId, `HTTP ${r.status}`);
  assert(!JSON.stringify(body).includes("at "), "stack trace leaked");
});
await check("OpenAPI document", async () => {
  const r = await get("/api/v1/openapi.json");
  const body = await r.json();
  assert(r.status === 200 && body.openapi === "3.1.0", `HTTP ${r.status}`);
  return `${Object.keys(body.paths).length} paths`;
});
await check("wrong password gets a generic refusal", async () => {
  const r = await get("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: "nobody@smoke.invalid", password: "definitely-wrong-123" }) });
  const body = await r.json();
  assert(r.status === 401 && body.error?.code === "UNAUTHENTICATED", `HTTP ${r.status}`);
});
await check("unknown payment callback token is rejected", async () => {
  const r = await get("/api/v1/webhooks/mobile-money/stk/smoke-unknown-token-000000000000", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(r.status === 404, `HTTP ${r.status}`);
});
await check("unknown router setup link is rejected", async () => {
  const r = await get("/api/v1/routers/setup/smoke-unknown-token-000000000000000000");
  assert(r.status === 404 && (r.headers.get("cache-control") ?? "").includes("no-store"), `HTTP ${r.status}`);
});
if (worker) {
  await check("worker readiness", async () => {
    const r = await fetch(`${worker.replace(/\/$/, "")}/health/ready`);
    const body = await r.json();
    assert(r.status === 200 && body.status === "ready", `HTTP ${r.status}`);
  });
}
if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
  await check("staff sign-in, session and sign-out", async () => {
    const login = await get("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }) });
    assert(login.status === 200, `login HTTP ${login.status}`);
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert(/HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie), "session cookie flags");
    if (base.startsWith("https://")) assert(/Secure/i.test(setCookie) && setCookie.startsWith("__Host-"), "cookie not Secure/__Host-");
    const cookie = setCookie.split(";")[0];
    const session = await get("/api/v1/auth/session", { headers: { cookie } });
    assert(session.status === 200, `session HTTP ${session.status}`);
    const logout = await get("/api/v1/auth/logout", { method: "POST", headers: { cookie, origin: base } });
    assert(logout.status === 200, `logout HTTP ${logout.status}`);
    const after = await get("/api/v1/auth/session", { headers: { cookie } });
    assert(after.status === 401, `session still valid after logout (HTTP ${after.status})`);
  });
}

console.table(results);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) FAILED against ${base}` : `All ${results.length} checks passed against ${base}`);
process.exit(failed ? 1 : 0);
