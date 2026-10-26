import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { activatePortalAccount, createPortalInviteLink, portalLogin, resolveCustomerContext } from "@/server/portal/auth";
import {
  ASSISTANT_RATE,
  customerAssistant,
  endAssistantConversation,
  getAssistantConversation,
  listAssistantConversations,
  conversationListQuery,
  pruneAssistantConversations,
  sendAssistantMessage,
  updateAssistantSettings,
} from "@/server/assistant/service";
import { mockIntent } from "@/server/assistant/model";
import { resetRateLimit } from "@/server/security/rate-limit";
import { POST as sendRoute } from "@/app/api/v1/customer/assistant/messages/route";
import { contextFor, createOrg, createStaff, noParams, request } from "./fixtures";

const meta = { correlationId: "assistant-test-01", ipAddress: "10.9.0.3", userAgent: "vitest" };
let seq = 0;
const tel = () => `07${String(40_000_000 + seq++).padStart(8, "0")}`;
const ENV_KEYS = ["ASSISTANT_ADAPTER", "ANTHROPIC_API_KEY", "ASSISTANT_BASE_URL", "ASSISTANT_MODEL", "ASSISTANT_EFFORT"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ASSISTANT_ADAPTER = "mock";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, packageInput.parse({ name: "Fibre 20", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1 }));
  const customer = async (firstName: string) => {
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName, lastName: "Test", phone: tel(), packageId: pkg.id, activateSubscription: true }));
    const { link } = await createPortalInviteLink(ctx, subscriber.id);
    await activatePortalAccount({ token: new URL(link).searchParams.get("token")!, password: "Portal-Pass-123" }, meta);
    const { token } = await portalLogin({ organization: org.organization.slug, identifier: subscriber.phone, password: "Portal-Pass-123" }, meta);
    return { subscriber, token, cctx: (await resolveCustomerContext(token, meta))! };
  };
  return { org, ctx, customer };
}

describe("assistant (test mode)", () => {
  it("is off until an administrator enables it, and only administrators can", async () => {
    const { org, ctx, customer } = await setup();
    const { cctx } = await customer("Amina");
    expect(await customerAssistant(cctx)).toMatchObject({ enabled: false, conversation: null });
    await expect(sendAssistantMessage(cctx, { text: "hi" })).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });

    const support = await createStaff(org.organization.id, "support");
    await expect(updateAssistantSettings(await contextFor(support.user.id, org.organization.id), { enabled: true, name: "Nuru" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await updateAssistantSettings(ctx, { enabled: true, name: "Nuru", instructions: "Our office is on Moi Avenue." });
    expect(await customerAssistant(cctx)).toMatchObject({ enabled: true, name: "Nuru", simulated: true });
    expect(await db.auditLog.count({ where: { organizationId: org.organization.id, action: "settings.assistant.update" } })).toBe(1);

    // The deployment switch wins over the organization setting.
    process.env.ASSISTANT_ADAPTER = "disabled";
    expect((await customerAssistant(cctx)).enabled).toBe(false);
    await expect(sendAssistantMessage(cctx, { text: "hi" })).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
  });

  it("answers from the customer's own records through the tools and escalates to a ticket once", async () => {
    const { ctx, customer } = await setup();
    await updateAssistantSettings(ctx, { enabled: true, name: "Nuru" });
    const { cctx, subscriber } = await customer("Baraka");

    const balance = await sendAssistantMessage(cctx, { text: "What is my balance?" });
    expect(balance.simulated).toBe(true);
    expect(balance.messages.map((m) => m.role)).toEqual(["customer", "assistant"]);
    expect(balance.messages[1]!.text).toContain("Your balance due is KES 2,500.00.");
    expect(balance.messages[1]!.text).toContain("Fibre 20: active");
    expect(balance.messages[1]!.tools).toEqual(["get_account_summary"]); // shown as "Checked your account"

    const invoices = await sendAssistantMessage(cctx, { conversationId: balance.conversationId, text: "Show my invoices" });
    const inv = await db.invoice.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    expect(invoices.messages[1]!.text).toContain(inv.invoiceNumber!);

    const net = await sendAssistantMessage(cctx, { text: "Is my internet online?" });
    expect(net.messages[1]!.text).toMatch(/can't see a network connection/);

    const hello = await sendAssistantMessage(cctx, { text: "Habari" });
    expect(hello.messages[1]!.text).toMatch(/^I can check your balance/);

    const t = await sendAssistantMessage(cctx, { text: "My internet is very slow, I want to talk to a technician" });
    expect(t.ticket?.ticketNumber).toMatch(/^TKT-/);
    const ticket = await db.supportTicket.findUniqueOrThrow({ where: { id: t.ticket!.id } });
    expect(ticket).toMatchObject({ subscriberId: subscriber.id, channel: "ai_assistant", category: "CONNECTIVITY" });
    expect(ticket.description).toContain("Opened by Nuru (AI assistant)");
    const again = await sendAssistantMessage(cctx, { text: "Please open another ticket" });
    expect(again.ticket).toBeNull();
    expect(again.messages[1]!.text).toContain(`already opened in this chat: ${ticket.ticketNumber}`);
    expect(await db.supportTicket.count({ where: { subscriberId: subscriber.id } })).toBe(1);

    // Stored history alternates correctly and every tool call has its result.
    const rows = await db.assistantMessage.findMany({ where: { conversationId: balance.conversationId }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
    const conv = await db.assistantConversation.findUniqueOrThrow({ where: { id: balance.conversationId } });
    expect(conv).toMatchObject({ turns: 6, messageCount: rows.length, ticketId: ticket.id, source: "mock" });

    // The portal shows only the readable conversation.
    const view = await customerAssistant(cctx);
    expect(view.conversation?.messages.map((m) => m.role)).toEqual(["customer", "assistant", "customer", "assistant", "customer", "assistant", "customer", "assistant", "customer", "assistant", "customer", "assistant"]);

    // Ending the chat starts a fresh one.
    await endAssistantConversation(cctx);
    const fresh = await sendAssistantMessage(cctx, { text: "balance" });
    expect(fresh.conversationId).not.toBe(balance.conversationId);
    await expect(sendAssistantMessage(cctx, { conversationId: balance.conversationId, text: "hi" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("keeps customers apart, rate-limits, and shows staff the transcript within their scope", async () => {
    const { org, ctx, customer } = await setup();
    await updateAssistantSettings(ctx, { enabled: true, name: "Nuru" });
    const a = await customer("Chausiku");
    const b = await customer("Daudi");
    const first = await sendAssistantMessage(a.cctx, { text: "What is my balance?" });
    await expect(sendAssistantMessage(b.cctx, { conversationId: first.conversationId, text: "hi" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await customerAssistant(b.cctx)).conversation).toBeNull();

    // Through the API route with the customer's session cookie; staff/no session gets 401.
    const res = await sendRoute(request("/api/v1/customer/assistant/messages", { portalToken: b.token, body: { text: "How do I pay?" } }), noParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { messages: Array<{ text: string }> } };
    expect(body.data.messages[1]!.text).toContain(b.subscriber.accountNumber);
    expect((await sendRoute(request("/api/v1/customer/assistant/messages", { body: { text: "hi" } }), noParams)).status).toBe(401);
    expect((await sendRoute(request("/api/v1/customer/assistant/messages", { portalToken: b.token, body: { text: "x".repeat(1001) } }), noParams)).status).toBe(400);

    await resetRateLimit(ASSISTANT_RATE.perCustomer, a.cctx.customerAccountId);
    for (let i = 0; i < ASSISTANT_RATE.perCustomer.limit; i++) await sendAssistantMessage(a.cctx, { text: "hello" }).catch((e) => e);
    await expect(sendAssistantMessage(a.cctx, { text: "hello" })).rejects.toMatchObject({ code: "RATE_LIMITED" });

    const list = await listAssistantConversations(ctx, conversationListQuery.parse({}));
    expect(list.total).toBe(2);
    const t = await getAssistantConversation(ctx, first.conversationId);
    expect(t.subscriber?.id).toBe(a.subscriber.id);
    expect(t.messages.find((m) => m.toolCalls.length)?.toolCalls).toEqual([{ name: "get_account_summary", input: {} }]);
    expect(t.messages.find((m) => m.toolResults.length)?.toolResults).toEqual([{ isError: false }]);

    const cashier = await createStaff(org.organization.id, "cashier");
    await expect(listAssistantConversations(await contextFor(cashier.user.id, org.organization.id), conversationListQuery.parse({}))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await createOrg("Other ISP");
    await expect(getAssistantConversation(await contextFor(other.owner.id, other.organization.id), first.conversationId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Retention.
    await db.assistantConversation.update({ where: { id: first.conversationId }, data: { lastMessageAt: new Date(Date.now() - 200 * 86_400_000) } });
    expect(await pruneAssistantConversations(org.organization.id)).toEqual({ deleted: 1 });
    expect(await db.assistantMessage.count({ where: { conversationId: first.conversationId } })).toBe(0);
  });

  it("routes the customer's words to the right tool", () => {
    expect(mockIntent("nataka kuongea na technician")?.tool).toBe("create_support_ticket");
    expect(mockIntent("my wifi is down")?.tool).toBe("get_connection_status");
    expect(mockIntent("how do I pay?")?.tool).toBe("get_payment_options");
    expect(mockIntent("I paid yesterday")?.tool).toBe("list_payments");
    expect(mockIntent("send my invoice")?.tool).toBe("list_invoices");
    expect(mockIntent("salio langu")?.tool).toBe("get_account_summary");
    expect(mockIntent("good morning")).toBeNull();
  });
});

// ───────── Claude adapter against a local fake of the Messages API ─────────

type Recorded = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
const recorded: Recorded[] = [];
const script: Array<{ status?: number; body: Record<string, unknown> }> = [];
let server: http.Server;
let baseURL = "";

const msg = (content: unknown[], stop_reason: string) => ({
  id: `msg_${recorded.length}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      recorded.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
      const next = script.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "no scripted reply" } } };
      res.writeHead(next.status ?? 200, { "content-type": "application/json", "request-id": "req_test" }).end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("assistant (Claude adapter)", () => {
  it("sends a scoped, cache-friendly request, runs tools, and replays history unchanged", async () => {
    process.env.ASSISTANT_ADAPTER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    process.env.ASSISTANT_BASE_URL = baseURL;
    delete process.env.ASSISTANT_MODEL;
    delete process.env.ASSISTANT_EFFORT;
    recorded.length = 0;
    const { org, ctx, customer } = await setup();
    await updateAssistantSettings(ctx, { enabled: true, name: "Nuru", instructions: "Mention our office hours: 8am to 6pm." });
    const { cctx, subscriber } = await customer("Eshe");

    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    script.push({ body: msg([thinking, { type: "tool_use", id: "toolu_01", name: "get_account_summary", input: {} }], "tool_use") });
    script.push({ body: msg([{ type: "text", text: "You owe KES 2,500.00.", citations: null }], "end_turn") });
    const r1 = await sendAssistantMessage(cctx, { text: "How much do I owe?" });
    expect(r1).toMatchObject({ simulated: false, ticket: null });
    expect(r1.messages.map((m) => m.text)).toEqual(["How much do I owe?", "You owe KES 2,500.00."]);

    const [first, second] = recorded;
    expect(first!.path).toMatch(/^\/v1\/messages/);
    expect(first!.headers.authorization).toBe("Bearer sk-ant-test-key");
    expect(String(first!.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(first!.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, fallbacks: "default", output_config: { effort: "low" }, cache_control: { type: "ephemeral" } });
    const system = (first!.body.system as Array<{ text: string }>)[0]!.text;
    expect(system).toContain("You are Nuru, the customer support assistant for");
    expect(system).toContain(subscriber.accountNumber);
    expect(system).toContain("Mention our office hours");
    const tools = first!.body.tools as Array<{ name: string; strict: boolean; input_schema: { additionalProperties: boolean } }>;
    expect(tools.map((t) => t.name)).toEqual(["get_account_summary", "list_invoices", "list_payments", "get_connection_status", "get_payment_options", "create_support_ticket"]);
    expect(tools.every((t) => t.strict && t.input_schema.additionalProperties === false)).toBe(true);
    expect(first!.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "How much do I owe?" }] }]);

    const replay2 = second!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(replay2[1]).toEqual({ role: "assistant", content: [thinking, { type: "tool_use", id: "toolu_01", name: "get_account_summary", input: {} }] });
    const result = replay2[2]!.content[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_01" });
    expect(JSON.parse(String(result.content))).toMatchObject({ customer: { accountNumber: subscriber.accountNumber }, balance: { status: "owes", amountDue: "KES 2,500.00" } });

    // Next turn: the whole earlier exchange is sent back byte-for-byte, then the new message.
    script.push({ body: msg([{ type: "text", text: "Sawa!", citations: null }], "end_turn") });
    await sendAssistantMessage(cctx, { text: "Asante" });
    const third = recorded[2]!.body.messages as unknown[];
    expect(third.slice(0, 4)).toEqual([...replay2, { role: "assistant", content: [{ type: "text", text: "You owe KES 2,500.00.", citations: null }] }]);
    expect(third[4]).toEqual({ role: "user", content: [{ type: "text", text: "Asante" }] });
    expect((await db.assistantConversation.findFirstOrThrow({ where: { subscriberId: subscriber.id } })).inputTokens).toBe(450);

    // A refused turn is shown as a notice and left out of what is sent next time.
    script.push({ body: msg([], "refusal") });
    const refused = await sendAssistantMessage(cctx, { text: "something off-topic" });
    expect(refused.messages.map((m) => m.role)).toEqual(["customer", "notice"]);
    script.push({ body: msg([{ type: "text", text: "Karibu.", citations: null }], "end_turn") });
    await sendAssistantMessage(cctx, { text: "Thanks" });
    const fifth = recorded[4]!.body.messages as Array<{ content: Array<{ text?: string }> }>;
    expect(fifth).toHaveLength(7);
    expect(JSON.stringify(fifth)).not.toContain("something off-topic");

    // Provider errors become safe messages and store nothing.
    const before = await db.assistantMessage.count({ where: { organizationId: org.organization.id } });
    script.push({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    await expect(sendAssistantMessage(cctx, { text: "balance?" })).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE", message: "The assistant is not available right now." });
    expect(await db.assistantMessage.count({ where: { organizationId: org.organization.id } })).toBe(before);
  });

  it("closes a test-mode chat instead of sending simulated history to Claude", async () => {
    const { ctx, customer } = await setup();
    await updateAssistantSettings(ctx, { enabled: true, name: "Nuru" });
    const { cctx } = await customer("Faraji");
    const mockChat = await sendAssistantMessage(cctx, { text: "balance" });

    process.env.ASSISTANT_ADAPTER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    process.env.ASSISTANT_BASE_URL = baseURL;
    recorded.length = 0;
    script.push({ body: msg([{ type: "text", text: "Hello!", citations: null }], "end_turn") });
    const real = await sendAssistantMessage(cctx, { text: "hello" });
    expect(real.conversationId).not.toBe(mockChat.conversationId);
    expect(recorded[0]!.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect((await db.assistantConversation.findUniqueOrThrow({ where: { id: mockChat.conversationId } })).status).toBe("CLOSED");
  });
});
