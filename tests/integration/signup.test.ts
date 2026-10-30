import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { completeSignup, describeSignup, slugFor, startSignup } from "@/server/services/signup";
import { loginStaff } from "@/server/auth/service";
import { resolveSession } from "@/server/auth/session";
import { requestPortalSetupLink, requestService } from "@/server/portal/signup";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { setPortalAccess } from "@/server/portal/auth";
import { saveOperatorAlertSettings } from "@/server/services/operator-alerts";
import { POST as completeRoute } from "@/app/api/v1/auth/signup/complete/route";
import { POST as startRoute } from "@/app/api/v1/auth/signup/route";
import { contextFor, createOrg, noParams, request } from "./fixtures";

const meta = (ip = "10.20.0.1") => ({ correlationId: "signup-test", ipAddress: ip, userAgent: "vitest" });
/** Raw form input (deliberately loose so tests can submit invalid values). */
const form = (over: Record<string, unknown> = {}) =>
  ({ organizationName: "Skyline Fibre Ltd", name: "Amina Wanjiru", email: "amina@skyline.example", phone: "0712 345 678", password: "Strong-Pass-2026", acceptTerms: true, ...over }) as unknown as Parameters<typeof startSignup>[0];
const tokenOf = (link: string | null | undefined) => new URL(link!).searchParams.get("token")!;
const saved = { SIGNUP_MODE: process.env.SIGNUP_MODE, MESSAGING_ADAPTER: process.env.MESSAGING_ADAPTER };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ISP self-service sign-up", () => {
  it("emails a link, then creates the workspace, owner and session once the email is confirmed", async () => {
    const started = await startSignup(form(), meta());
    expect(started.email).toBe("amina@skyline.example");
    expect(started.preview?.subject).toBe("Confirm your email to create your Cloudlink account");
    expect(started.preview?.link).toMatch(/^http:\/\/localhost:3100\/signup\/verify\?token=/);
    const token = tokenOf(started.preview?.link);
    const pending = await db.signupRequest.findFirstOrThrow();
    expect(pending.tokenHash).not.toContain(token);
    expect(pending.passwordHash).not.toContain("Strong-Pass-2026");
    expect(await db.organization.count()).toBe(0); // nothing exists before confirmation
    expect(await describeSignup(token)).toEqual({ email: "amina@skyline.example", name: "Amina Wanjiru", organizationName: "Skyline Fibre Ltd" });

    const { session, organization } = await completeSignup({ token }, meta());
    expect(organization).toMatchObject({ name: "Skyline Fibre Ltd", slug: "skyline-fibre-ltd" });
    const resolved = await resolveSession(session.token);
    expect(resolved?.organizationId).toBe(organization.id);
    const membership = await db.membership.findFirstOrThrow({ where: { organizationId: organization.id }, include: { roles: { include: { role: true } } } });
    expect(membership.roles.map((r) => r.role.key)).toEqual(["owner"]);
    expect(await db.branch.findFirst({ where: { organizationId: organization.id } })).toMatchObject({ name: "Main office", code: "MAIN" });
    expect(await db.billingSettings.findUnique({ where: { organizationId: organization.id } })).toMatchObject({ phone: "254712345678", email: "amina@skyline.example" });
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: "organization.signup" } })).toBe(1);

    // The link works once, and the stored password hash is cleared from the request.
    await expect(completeSignup({ token }, meta())).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await describeSignup(token)).toBeNull();
    expect((await db.signupRequest.findFirstOrThrow()).passwordHash).toBe("");
    // The chosen password signs in.
    expect((await loginStaff({ email: "AMINA@skyline.example", password: "Strong-Pass-2026" }, meta("10.20.0.2"))).token).toBeTruthy();
  });

  it("never reveals or reuses an existing account, and gives a second company with the same name its own address", async () => {
    const existing = await createOrg("Skyline Fibre Ltd");
    const before = await db.user.findUniqueOrThrow({ where: { id: existing.owner.id } });
    const again = await startSignup(form({ email: existing.owner.email, password: "Another-Pass-2026" }), meta());
    expect(again.preview).toMatchObject({ subject: "You already have a Cloudlink account", link: null });
    expect(await db.signupRequest.count()).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: existing.owner.id } })).passwordHash).toBe(before.passwordHash);

    const other = await startSignup(form({ email: "brian@lakeside.example" }), meta("10.20.0.3"));
    const { organization } = await completeSignup({ token: tokenOf(other.preview?.link) }, meta("10.20.0.3"));
    expect(organization.slug).not.toBe(existing.organization.slug);
    expect(organization.slug).toMatch(/^skyline-fibre-ltd(-\d+)?$/);
    expect(slugFor("Ünïcode & Co. — Fibre!")).toBe("unicode-co-fibre");
    expect(slugFor("Login")).toBe("isp"); // reserved portal path
  });

  it("refuses an email that gained an account before the link was confirmed, expired links, and concurrent confirmations", async () => {
    const a = await startSignup(form({ email: "race@example.co.ke" }), meta());
    const token = tokenOf(a.preview?.link);
    const results = await Promise.allSettled([completeSignup({ token }, meta("10.20.0.4")), completeSignup({ token }, meta("10.20.0.5"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.organization.count()).toBe(1);

    const b = await startSignup(form({ email: "late@example.co.ke", organizationName: "Late ISP" }), meta("10.20.0.6"));
    const someone = await createOrg("Someone Else");
    await db.user.update({ where: { id: someone.owner.id }, data: { email: "late@example.co.ke" } });
    await expect(completeSignup({ token: tokenOf(b.preview?.link) }, meta("10.20.0.6"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.organization.count({ where: { name: "Late ISP" } })).toBe(0);

    const c = await startSignup(form({ email: "old@example.co.ke" }), meta("10.20.0.7"));
    await db.signupRequest.updateMany({ where: { email: "old@example.co.ke" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await describeSignup(tokenOf(c.preview?.link))).toBeNull();
    await expect(completeSignup({ token: tokenOf(c.preview?.link) }, meta("10.20.0.7"))).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("validates input, honours SIGNUP_MODE, needs a mailer, and rate-limits", async () => {
    await expect(startSignup(form({ acceptTerms: false }), meta())).rejects.toThrow();
    await expect(startSignup(form({ password: "short" }), meta())).rejects.toThrow(/at least 10/);
    await expect(startSignup(form({ phone: "12" }), meta())).rejects.toThrow(/valid phone/);

    process.env.SIGNUP_MODE = "closed";
    await expect(startSignup(form(), meta())).rejects.toMatchObject({ code: "FORBIDDEN" });
    delete process.env.SIGNUP_MODE;

    process.env.MESSAGING_ADAPTER = "disabled";
    await expect(startSignup(form(), meta())).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
    process.env.MESSAGING_ADAPTER = "mock";

    for (let i = 0; i < 3; i++) await startSignup(form({ email: "busy@example.co.ke" }), meta(`10.30.0.${i}`));
    await expect(startSignup(form({ email: "busy@example.co.ke" }), meta("10.30.0.9"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    for (let i = 0; i < 5; i++) await startSignup(form({ email: `ip${i}@example.co.ke` }), meta("10.40.0.1"));
    await expect(startSignup(form({ email: "ip9@example.co.ke" }), meta("10.40.0.1"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("works through the API routes and sets the session cookie on confirmation", async () => {
    const res = await startRoute(request("/api/v1/auth/signup", { body: form({ email: "route@example.co.ke" }) }), noParams);
    expect(res.status).toBe(202);
    const { data } = (await res.json()) as { data: { preview: { link: string } } };
    const bad = await startRoute(request("/api/v1/auth/signup", { body: form({ email: "x@example.co.ke" }), origin: "https://evil.example" }), noParams);
    expect(bad.status).toBe(403);
    const done = await completeRoute(request("/api/v1/auth/signup/complete", { body: { token: tokenOf(data.preview.link) } }), noParams);
    expect(done.status).toBe(201);
    expect(done.headers.get("set-cookie")).toMatch(/cloudlink_session=/);
  });
});

describe("customer portal sign-up", () => {
  async function isp() {
    const org = await createOrg("Skyline Fibre");
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const pkg = await createPackage(ctx, packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1 }));
    return { org, ctx, pkg };
  }

  it("turns a connection request into one lead, ignores bots, and alerts operators who asked", async () => {
    const { org, ctx, pkg } = await isp();
    await saveOperatorAlertSettings(ctx, { recipients: [{ channel: "EMAIL", to: "ops@skyline.example" }], events: ["service_request"], digestHour: 7 });
    const body = { organization: org.organization.slug, name: "Wanjiku Mwangi", phone: "0722 111 222", email: "", location: "Kileleshwa, Othaya Rd, House 4", packageId: pkg.id, notes: "Evenings please" };
    expect(await requestService(body, meta())).toEqual({ received: true });
    const lead = await db.lead.findFirstOrThrow({ where: { organizationId: org.organization.id } });
    expect(lead).toMatchObject({ name: "Wanjiku Mwangi", phone: "254722111222", source: "WEBSITE", interestedPackageId: pkg.id, location: "Kileleshwa, Othaya Rd, House 4" });
    expect(lead.notes).toContain("Message: Evenings please");
    expect(await db.notification.count({ where: { organizationId: org.organization.id, recipient: "ops@skyline.example" } })).toBe(1);

    expect(await requestService(body, meta("10.20.0.9"))).toEqual({ received: true }); // same phone, open lead: no duplicate
    expect(await requestService({ ...body, phone: "0733 000 111", website: "http://spam.example" }, meta("10.20.0.8"))).toEqual({ received: true });
    expect(await db.lead.count({ where: { organizationId: org.organization.id } })).toBe(1);

    // A plan from another provider is not attached; unknown providers are refused.
    const other = await isp();
    await requestService({ ...body, phone: "0744 000 222", packageId: other.pkg.id }, meta("10.20.0.7"));
    expect((await db.lead.findFirstOrThrow({ where: { phone: "254744000222" } })).interestedPackageId).toBeNull();
    await expect(requestService({ ...body, organization: "nope" }, meta())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestService({ ...body, phone: "12" }, meta())).rejects.toThrow(/valid phone/);
  });

  it("sends a setup link only to a matching, enabled account, with the same reply either way", async () => {
    const { org, ctx, pkg } = await isp();
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Otieno", phone: "0711 999 888", packageId: pkg.id }));
    const invites = () => db.notification.count({ where: { organizationId: org.organization.id, templateKey: "portal.invite" } });

    expect(await requestPortalSetupLink({ organization: org.organization.slug, identifier: "0700 000 000" }, meta())).toEqual({ requested: true });
    expect(await invites()).toBe(0);
    expect(await requestPortalSetupLink({ organization: org.organization.slug, identifier: "0711 999 888" }, meta())).toEqual({ requested: true });
    expect(await invites()).toBe(1);
    expect(await db.customerAccount.findUniqueOrThrow({ where: { subscriberId: subscriber.id } })).toMatchObject({ status: "INVITED", loginPhone: "254711999888" });
    expect(await requestPortalSetupLink({ organization: org.organization.slug, identifier: subscriber.accountNumber.toLowerCase() }, meta("10.20.0.3"))).toEqual({ requested: true });
    expect(await invites()).toBe(2);

    await setPortalAccess(ctx, subscriber.id, false);
    expect(await requestPortalSetupLink({ organization: org.organization.slug, identifier: subscriber.accountNumber }, meta("10.20.0.4"))).toEqual({ requested: true });
    expect(await invites()).toBe(2); // disabled: nothing sent, same reply

    // Another provider's customer cannot be reached through this provider.
    const other = await isp();
    expect(await requestPortalSetupLink({ organization: other.org.organization.slug, identifier: "0711 999 888" }, meta("10.20.0.5"))).toEqual({ requested: true });
    expect(await db.notification.count({ where: { organizationId: other.org.organization.id } })).toBe(0);
  });
});
