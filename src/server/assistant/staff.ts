import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "@/server/db/client";
import { hasPermission, listWhere, requirePermission, type StaffContext } from "@/server/auth/context";
import type { PermissionKey } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { normalizePhone } from "@/server/domain/contact";
import { subscriberLedgerBalance } from "@/server/services/ledger";
import { dashboardPulse, dashboardSummary } from "@/server/services/dashboard";
import { assistantAdapterName, assistantModel, type MockRules } from "@/server/assistant/model";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";

/**
 * "Ask AI" for staff: questions about the organization answered from its own records.
 *
 * Every tool is read-only and runs as the asking staff member: their permissions and branch scope apply, so the
 * assistant can never show someone data they could not open themselves. Nothing is stored: the panel sends the
 * visible conversation (text only) with each question, and tools are run again as needed.
 */

const MAX_STEPS = 6;
export const STAFF_ASK_RATE = { name: "assistant:staff", limit: 30, windowSeconds: 10 * 60 };

export const staffAskInput = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(20)
    .refine((m) => m.at(-1)?.role === "user", "The last message must be your question."),
});

const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object" as const, properties, required, additionalProperties: false });

export const STAFF_TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "business_snapshot", description: "Today's collections, people online now, subscription counts, expiries and receivables for the organization (or the user's branches).", input_schema: object({}), strict: true },
  { name: "find_subscribers", description: "Search subscribers by name, account number or phone. Returns up to 8 matches with plan, status and paid-until date.", input_schema: object({ query: { type: "string" } }), strict: true },
  { name: "subscriber_details", description: "One subscriber by account number (e.g. A000123): services, balance, last payment and whether they are online.", input_schema: object({ accountNumber: { type: "string" } }), strict: true },
  { name: "recent_payments", description: "The latest 10 confirmed payments with amount, method, receipt and payer.", input_schema: object({}), strict: true },
  { name: "expiring_subscriptions", description: "Active subscriptions whose paid period ends within 24 hours or 7 days.", input_schema: object({ within: { type: "string", enum: ["24h", "7d"] } }), strict: true },
  { name: "router_status", description: "Routers with their status, last contact and how many sessions are open on each.", input_schema: object({}), strict: true },
];

const inputs = {
  business_snapshot: z.object({}).strict(),
  find_subscribers: z.object({ query: z.string().trim().min(2).max(80) }).strict(),
  subscriber_details: z.object({ accountNumber: z.string().trim().min(2).max(20) }).strict(),
  recent_payments: z.object({}).strict(),
  expiring_subscriptions: z.object({ within: z.enum(["24h", "7d"]) }).strict(),
  router_status: z.object({}).strict(),
} as const;
type ToolName = keyof typeof inputs;

const NEEDS: Record<ToolName, PermissionKey> = {
  business_snapshot: "dashboard.view",
  find_subscribers: "subscribers.read",
  subscriber_details: "subscribers.read",
  recent_payments: "payments.read",
  expiring_subscriptions: "subscriptions.read",
  router_status: "routers.read",
};

async function runTool(ctx: StaffContext, name: string, raw: unknown): Promise<{ content: string; isError: boolean }> {
  if (!(name in inputs)) return { content: `Unknown tool: ${name}`, isError: true };
  const tool = name as ToolName;
  if (!hasPermission(ctx, NEEDS[tool])) return { content: "You do not have access to this information.", isError: true };
  const parsed = inputs[tool].safeParse(raw ?? {});
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
  try {
    return { content: JSON.stringify(await run(ctx, tool, parsed.data as Record<string, unknown>)), isError: false };
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return { content: err.message, isError: true };
    logger.error({ tool: name, err: (err as Error).message }, "staff assistant tool failed");
    return { content: "This information is temporarily unavailable.", isError: true };
  }
}

async function run(ctx: StaffContext, tool: ToolName, input: Record<string, unknown>): Promise<unknown> {
  const tz = ctx.organization.timezone;
  const cur = ctx.organization.currency;
  const scope = listWhere(ctx);
  switch (tool) {
    case "business_snapshot": {
      const [summary, pulse] = await Promise.all([dashboardSummary(ctx), dashboardPulse(ctx)]);
      return {
        asOf: formatDateTime(new Date(), tz),
        collectedToday: pulse.collections ? formatMoney(pulse.collections.today, cur) : null,
        collectedYesterdayBySameTime: pulse.collections ? formatMoney(pulse.collections.yesterdayByNow, cur) : null,
        onlineNow: pulse.subscriberHealth ? `${pulse.subscriberHealth.online} of ${pulse.subscriberHealth.provisioned} with network access` : null,
        subscriptions: summary.subscriptions ?? null,
        expiringIn24h: pulse.expiring?.count ?? null,
        receivables: summary.billing ? formatMoney(summary.billing.receivables, cur) : null,
        overdue: summary.billing ? formatMoney(summary.billing.overdue, cur) : null,
      };
    }
    case "find_subscribers": {
      const q = String(input.query);
      const phone = normalizePhone(q);
      const rows = await db.subscriber.findMany({
        where: { ...scope, status: { not: "ARCHIVED" }, OR: [{ displayName: { contains: q, mode: "insensitive" } }, { accountNumber: { equals: q.toUpperCase() } }, ...(phone ? [{ phone }] : [])] },
        take: 8,
        orderBy: { createdAt: "desc" },
        select: { displayName: true, accountNumber: true, phone: true, status: true, subscriptions: { where: { status: { not: "CANCELLED" } }, select: { packageName: true, status: true, currentPeriodEnd: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      });
      return { matches: rows.map((r) => ({ name: r.displayName, account: r.accountNumber, phone: r.phone, status: r.status, plan: r.subscriptions[0]?.packageName ?? null, planStatus: r.subscriptions[0]?.status ?? null, paidUntil: r.subscriptions[0]?.currentPeriodEnd ? formatDate(r.subscriptions[0].currentPeriodEnd, tz) : null })) };
    }
    case "subscriber_details": {
      const s = await db.subscriber.findFirst({
        where: { ...scope, accountNumber: String(input.accountNumber).toUpperCase() },
        select: { id: true, displayName: true, accountNumber: true, phone: true, status: true, vip: true, subscriptions: { where: { status: { not: "CANCELLED" } }, select: { packageName: true, status: true, currentPeriodEnd: true, price: true, currency: true }, orderBy: { createdAt: "desc" } } },
      });
      if (!s) throw new AppError("NOT_FOUND", "No subscriber with that account number in your scope.");
      const [balance, lastPayment, online] = await Promise.all([
        subscriberLedgerBalance(db, ctx.organizationId, s.id),
        db.payment.findFirst({ where: { organizationId: ctx.organizationId, subscriberId: s.id, status: "CONFIRMED" }, orderBy: { receivedAt: "desc" }, select: { amount: true, currency: true, receivedAt: true, method: true, receiptNumber: true } }),
        db.networkSession.count({ where: { organizationId: ctx.organizationId, subscriberId: s.id, endedAt: null } }),
      ]);
      const net = Number(balance.net.toFixed(2));
      return {
        name: s.displayName,
        account: s.accountNumber,
        phone: s.phone,
        status: s.status,
        vip: s.vip,
        balance: net > 0 ? `owes ${formatMoney(net.toFixed(2), cur)}` : net < 0 ? `credit ${formatMoney((-net).toFixed(2), cur)}` : "paid up",
        services: s.subscriptions.map((x) => ({ plan: x.packageName, status: x.status, price: formatMoney(x.price.toString(), x.currency), paidUntil: x.currentPeriodEnd ? formatDate(x.currentPeriodEnd, tz) : null })),
        lastPayment: lastPayment ? { amount: formatMoney(lastPayment.amount.toString(), lastPayment.currency), method: lastPayment.method, receipt: lastPayment.receiptNumber, at: lastPayment.receivedAt ? formatDateTime(lastPayment.receivedAt, tz) : null } : null,
        onlineNow: online > 0,
      };
    }
    case "recent_payments": {
      const rows = await db.payment.findMany({ where: { ...scope, status: "CONFIRMED" }, orderBy: { receivedAt: "desc" }, take: 10, select: { amount: true, currency: true, method: true, receiptNumber: true, receivedAt: true, payerPhone: true, subscriberId: true } });
      const subs = await db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((v): v is string => Boolean(v)) } }, select: { id: true, displayName: true, accountNumber: true } });
      return {
        payments: rows.map((r) => {
          const sub = subs.find((x) => x.id === r.subscriberId);
          return { amount: formatMoney(r.amount.toString(), r.currency), method: r.method, receipt: r.receiptNumber, at: r.receivedAt ? formatDateTime(r.receivedAt, tz) : null, from: sub ? `${sub.displayName} (${sub.accountNumber})` : "not matched to a subscriber" };
        }),
      };
    }
    case "expiring_subscriptions": {
      const now = new Date();
      const until = new Date(now.getTime() + (input.within === "7d" ? 7 * 24 : 24) * 3600_000);
      const rows = await db.subscription.findMany({
        where: { ...scope, status: "ACTIVE", currentPeriodEnd: { gte: now, lte: until } },
        orderBy: { currentPeriodEnd: "asc" },
        take: 25,
        select: { packageName: true, currentPeriodEnd: true, subscriber: { select: { displayName: true, accountNumber: true, phone: true } } },
      });
      return { within: input.within, count: rows.length, subscriptions: rows.map((r) => ({ subscriber: `${r.subscriber.displayName} (${r.subscriber.accountNumber})`, phone: r.subscriber.phone, plan: r.packageName, ends: r.currentPeriodEnd ? formatDateTime(r.currentPeriodEnd, tz) : null })) };
    }
    case "router_status": {
      const routers = await db.router.findMany({ where: { ...scope, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, status: true, lastSeenAt: true } });
      const sessions = await db.networkSession.groupBy({ by: ["routerId"], where: { organizationId: ctx.organizationId, routerId: { in: routers.map((r) => r.id) }, endedAt: null }, _count: { _all: true } });
      return { routers: routers.map((r) => ({ name: r.name, status: r.status, lastContact: r.lastSeenAt ? formatDateTime(r.lastSeenAt, tz) : "never", openSessions: sessions.find((x) => x.routerId === r.id)?._count._all ?? 0 })) };
    }
  }
}

// ───────── Test mode ─────────

type Json = Record<string, unknown>;
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const STAFF_HELP = "I can summarise today's business, find a subscriber, show someone's account, list recent payments, show who expires soon, or check your routers. What would you like to know?";

export const STAFF_MOCK_RULES: MockRules = {
  help: STAFF_HELP,
  intent(text) {
    const account = /\b([A-Z]\d{5,7})\b/i.exec(text)?.[1];
    if (account) return { tool: "subscriber_details", input: { accountNumber: account.toUpperCase() } };
    const phone = /(\+?254|0)[17]\d{8}/.exec(text.replace(/\s/g, ""))?.[0];
    if (phone) return { tool: "find_subscribers", input: { query: phone } };
    const find = /\b(?:find|search|look ?up|who is)\s+(.{2,60})$/i.exec(text.trim());
    if (find) return { tool: "find_subscribers", input: { query: find[1]!.replace(/[?.!]+$/, "") } };
    if (/\b(expir\w*|renew\w*|ending)\b/i.test(text)) return { tool: "expiring_subscriptions", input: { within: /\b(week|7)\b/i.test(text) ? "7d" : "24h" } };
    if (/\b(router|routers|nas|mikrotik|offline)\b/i.test(text)) return { tool: "router_status", input: {} };
    if (/\b(payments?|paid|receipts?|m-?pesa)\b/i.test(text) && !/\btoday\b/i.test(text)) return { tool: "recent_payments", input: {} };
    if (/\b(today|collected|collections|revenue|summary|how are we|online|business)\b/i.test(text)) return { tool: "business_snapshot", input: {} };
    return null;
  },
  describe(tool, r) {
    switch (tool) {
      case "business_snapshot":
        return [
          r.collectedToday ? `Collected today: ${r.collectedToday} (yesterday by this time: ${r.collectedYesterdayBySameTime}).` : null,
          r.onlineNow ? `Online now: ${r.onlineNow}.` : null,
          r.expiringIn24h !== null && r.expiringIn24h !== undefined ? `${r.expiringIn24h} subscriptions expire in the next 24 hours.` : null,
          r.receivables ? `Receivables: ${r.receivables} (${r.overdue} overdue).` : null,
        ]
          .filter(Boolean)
          .join(" ");
      case "find_subscribers": {
        const m = list(r.matches);
        if (!m.length) return "No subscriber matches that.";
        return m.map((x) => `${x.name} (${x.account}, ${x.phone}): ${x.plan ? `${x.plan}, ${String(x.planStatus).toLowerCase()}${x.paidUntil ? `, paid until ${x.paidUntil}` : ""}` : "no plan"}.`).join("\n");
      }
      case "subscriber_details": {
        const s = list(r.services).map((x) => `${x.plan} (${String(x.status).toLowerCase()}${x.paidUntil ? `, paid until ${x.paidUntil}` : ""})`);
        const lp = r.lastPayment as Json | null;
        return `${r.name} (${r.account}) ${r.balance}. ${s.length ? `Services: ${s.join("; ")}.` : "No active service."} ${lp ? `Last payment ${lp.amount} by ${lp.method} on ${lp.at}.` : "No payments yet."} ${r.onlineNow ? "Online now." : "Not online now."}`;
      }
      case "recent_payments": {
        const p = list(r.payments);
        if (!p.length) return "No confirmed payments yet.";
        return p.slice(0, 5).map((x) => `${x.amount} ${x.method} from ${x.from} on ${x.at}`).join("\n");
      }
      case "expiring_subscriptions": {
        const s = list(r.subscriptions);
        if (!s.length) return `Nobody expires in the next ${r.within === "7d" ? "7 days" : "24 hours"}.`;
        return `${r.count} expire in the next ${r.within === "7d" ? "7 days" : "24 hours"}:\n` + s.slice(0, 8).map((x) => `${x.subscriber}, ${x.plan}, ends ${x.ends}`).join("\n");
      }
      case "router_status": {
        const rt = list(r.routers);
        if (!rt.length) return "No routers are registered yet.";
        return rt.map((x) => `${x.name}: ${String(x.status).toLowerCase()}, ${x.openSessions} online, last contact ${x.lastContact}`).join("\n");
      }
      default:
        return STAFF_HELP;
    }
  },
};

// ───────── Ask ─────────

/** Whether Ask AI can be offered (the deployment has an assistant adapter) and whether it is simulated. */
export function staffAssistantStatus() {
  const adapter = assistantAdapterName();
  return { available: adapter !== "disabled", simulated: adapter === "mock" };
}

function systemPrompt(ctx: StaffContext) {
  return [
    `You are Cloudlink's assistant for staff of ${ctx.organization.name}, an internet service provider in Kenya. You are helping ${ctx.userName}.`,
    "Answer questions about the organization using your tools. State only facts from tool results; if the tools cannot answer, say so. Never invent figures.",
    "If a tool says the user has no access, tell them they do not have permission for that information.",
    "You cannot change anything: point the user to the right page (Subscribers, Payments, Live sessions, Routers, Plans, Billing) for actions.",
    `Amounts are in ${ctx.organization.currency}; times are in ${ctx.organization.timezone}. Be brief: short sentences or a compact list, no headings.`,
  ].join("\n");
}

export async function askStaff(ctx: StaffContext, raw: z.input<typeof staffAskInput>) {
  requirePermission(ctx, "dashboard.view");
  const input = staffAskInput.parse(raw);
  const model = assistantModel(STAFF_MOCK_RULES);
  if (!model) throw new AppError("INTEGRATION_UNAVAILABLE", "Ask AI is not set up on this server.");
  await consumeRateLimit(STAFF_ASK_RATE, ctx.userId);

  // Earlier turns are replayed as plain text; this turn's tool calls stay within this request.
  const messages: Anthropic.Beta.BetaMessageParam[] = input.messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] }));
  const used: string[] = [];
  let reply = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await model.reply({ system: systemPrompt(ctx), tools: STAFF_TOOLS, messages });
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (res.stop_reason === "refusal") {
      reply = "Sorry, I can't help with that.";
      break;
    }
    if (res.stop_reason !== "tool_use" || !calls.length) {
      reply = text;
      break;
    }
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      used.push(call.name);
      const out = await runTool(ctx, call.name, call.input);
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: reply || "Sorry, I couldn't finish that. Please try asking another way.", tools: [...new Set(used)], simulated: model.name === "mock" };
}
