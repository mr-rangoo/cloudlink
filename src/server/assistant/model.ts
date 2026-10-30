import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";

/**
 * Model boundary for the customer-portal assistant (server only; the API key never reaches a browser).
 *
 * - anthropic: Claude via the official SDK (Messages API, beta namespace for server-side refusal fallbacks).
 * - mock: deterministic, rule-based replies that still go through the real tools, so the feature can be developed
 *   and tested without credentials. It never invents data: every fact it states comes from a tool result.
 * - disabled: the assistant is unavailable.
 */
export type AssistantAdapterName = "anthropic" | "mock" | "disabled";

export function assistantAdapterName(): AssistantAdapterName {
  const v = process.env.ASSISTANT_ADAPTER || "disabled";
  return v === "anthropic" || v === "mock" ? v : "disabled";
}

export interface ModelRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface AssistantModel {
  name: "anthropic" | "mock";
  model: string;
  reply(req: ModelRequest): Promise<Anthropic.Beta.BetaMessage>;
}

export function assistantModelId(): string {
  return process.env.ASSISTANT_MODEL || "claude-opus-5-5";
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
}

class ClaudeModel implements AssistantModel {
  readonly name = "anthropic" as const;
  readonly model = assistantModelId();
  private readonly client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    baseURL: process.env.APP_ENV !== "production" && process.env.ASSISTANT_BASE_URL ? process.env.ASSISTANT_BASE_URL : undefined,
    timeout: 90_000,
    maxRetries: 2,
  });

  async reply(req: ModelRequest): Promise<Anthropic.Beta.BetaMessage> {
    const effort = (["low", "medium", "high"] as const).find((e) => e === process.env.ASSISTANT_EFFORT) ?? "low";
    try {
      return await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        ...(supportsFallbacks(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort },
        // The system prompt and tools are stable for a conversation, so each turn re-reads the cached prefix.
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: req.system }],
        tools: req.tools,
        messages: req.messages,
      });
    } catch (err) {
      throw modelError(err);
    }
  }
}

/** Map SDK errors to safe application errors (most specific first). Never logs the key or message content. */
function modelError(err: unknown): AppError {
  if (err instanceof Anthropic.RateLimitError) {
    logger.warn({ status: 429 }, "assistant model rate limited");
    return new AppError("INTEGRATION_UNAVAILABLE", "The assistant is busy right now. Please try again in a minute.");
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    logger.error({ status: err.status }, "assistant model credentials rejected");
    return new AppError("INTEGRATION_UNAVAILABLE", "The assistant is not available right now.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    logger.error({ status: err.status, requestId: err.requestID }, "assistant model rejected the request");
    return new AppError("INTEGRATION_ERROR", "The assistant could not answer that. Please try again or open a support ticket.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    logger.warn({ err: err.message }, "assistant model unreachable");
    return new AppError("INTEGRATION_UNAVAILABLE", "The assistant is not reachable right now. Please try again shortly.");
  }
  if (err instanceof Anthropic.APIError) {
    logger.error({ status: err.status, requestId: err.requestID }, "assistant model error");
    return new AppError("INTEGRATION_ERROR", "The assistant could not answer that. Please try again shortly.");
  }
  return err instanceof AppError ? err : new AppError("INTERNAL_ERROR");
}

// ───────── Mock ─────────

export type Intent = { tool: string; input: Record<string, unknown> };

/** Test-mode behaviour of one assistant: which tool a message asks for, and how to word a tool's result. */
export interface MockRules {
  intent(text: string): Intent | null;
  describe(tool: string, result: Record<string, unknown>): string;
  help: string;
}

const CONNECTIVITY = /\b(internet|connection|connected|online|offline|slow|down|wi-?fi|router|no network|mtandao)\b/i;

/** Pick a tool from the customer's words. Order matters: an explicit request for a person or ticket wins. */
export function mockIntent(text: string): Intent | null {
  if (/\b(ticket|human|real person|agent|technician|escalate|complain|complaint)\b/i.test(text)) {
    const category = CONNECTIVITY.test(text) ? "CONNECTIVITY" : /\b(bill|invoice|charge|pay|payment|refund)\b/i.test(text) ? "BILLING" : "OTHER";
    const subject = text.replace(/\s+/g, " ").trim().slice(0, 80);
    return { tool: "create_support_ticket", input: { subject: subject.length >= 3 ? subject : "Help needed", description: text.trim(), category } };
  }
  if (CONNECTIVITY.test(text)) return { tool: "get_connection_status", input: {} };
  if (/\b(how (do|can|to) i pay|how to pay|paybill|pay ?bill|till|bank|lipa)\b/i.test(text)) return { tool: "get_payment_options", input: {} };
  if (/\b(paid|payment|payments|receipt|received|mpesa|m-pesa)\b/i.test(text)) return { tool: "list_payments", input: {} };
  if (/\b(invoice|invoices|bill|bills)\b/i.test(text)) return { tool: "list_invoices", input: { which: "open" } };
  if (/\b(balance|owe|due|debt|deni|salio|account|package|plan|expire|expiry)\b/i.test(text)) return { tool: "get_account_summary", input: {} };
  return null;
}

const HELP = "I can check your balance, invoices and payments, see whether your internet connection is online, explain how to pay, or open a support ticket for you. What would you like to know?";

type Json = Record<string, unknown>;
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** Turn a tool result into a reply. Only restates what the tool returned. */
export function mockDescribe(tool: string, result: Json): string {
  switch (tool) {
    case "get_account_summary": {
      const b = (result.balance ?? {}) as Json;
      const head = b.status === "owes" ? `Your balance due is ${b.amountDue}.` : b.status === "credit" ? `You have a credit of ${b.credit} on your account.` : "You are all paid up.";
      const services = list(result.services).map((s) => `${s.package}: ${String(s.status).toLowerCase()}${s.paidUntil ? `, paid until ${s.paidUntil}` : ""}.`);
      return [head, ...services].join(" ");
    }
    case "list_invoices": {
      const rows = list(result.invoices);
      if (!rows.length) return "You have no open invoices.";
      return `You have ${rows.length} open invoice${rows.length === 1 ? "" : "s"}: ${rows.map((i) => `${i.number} with ${i.balanceDue} due${i.dueDate ? ` by ${i.dueDate}` : ""}`).join("; ")}.`;
    }
    case "list_payments": {
      const rows = list(result.payments);
      if (!rows.length) return "I can't see any payments on your account yet. M-Pesa payments usually appear within a few minutes.";
      return `Your recent payments: ${rows
        .slice(0, 3)
        .map((p) => `${p.amount} by ${p.method} on ${p.date}${p.status === "REVERSED" ? " (reversed)" : ""}`)
        .join("; ")}.`;
    }
    case "get_connection_status": {
      const note = result.testData ? " (test data, not from a real router)" : "";
      const stale = result.stale ? " This status may be out of date." : "";
      if (result.status === "ONLINE") return `Your connection is online${result.onlineFor ? ` and has been for ${result.onlineFor}` : ""}${note}.${stale}`;
      if (result.status === "OFFLINE") return `Your connection is offline${result.lastOnline ? `; it was last online ${result.lastOnline}` : ""}.${stale} If your account is paid up, try restarting your router. I can open a support ticket if it stays offline.`;
      return "I can't see a network connection set up for your account yet. I can open a support ticket if you need help.";
    }
    case "get_payment_options": {
      const methods = list(result.methods).map((m) => `${m.name}: ${list(m.steps).join(", ")}`);
      const online = result.onlinePayment ? `You can also pay from the portal: ${result.onlinePayment}` : "";
      return [methods.length ? `You can pay by ${methods.join(". ")}.` : `Please pay using your account number ${result.accountNumber} as the reference.`, online].filter(Boolean).join(" ");
    }
    case "create_support_ticket":
      return `I've opened ticket ${result.ticketNumber} for you. Our team will reply under Support in the portal.`;
    default:
      return HELP;
  }
}

function fakeMessage(content: Json[], stop: "end_turn" | "tool_use"): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_mock_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: "mock",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

const CUSTOMER_RULES: MockRules = { intent: mockIntent, describe: mockDescribe, help: HELP };

class MockModel implements AssistantModel {
  readonly name = "mock" as const;
  readonly model = "mock";
  private seq = 0;

  constructor(private readonly rules: MockRules = CUSTOMER_RULES) {}

  async reply(req: ModelRequest): Promise<Anthropic.Beta.BetaMessage> {
    const last = req.messages.at(-1);
    const blocks = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : ((last?.content ?? []) as unknown as Json[]);
    const results = blocks.filter((b) => b.type === "tool_result");
    if (results.length) {
      const prev = req.messages.at(-2);
      const calls = Array.isArray(prev?.content) ? (prev.content as unknown as Json[]).filter((b) => b.type === "tool_use") : [];
      const text = results
        .map((r) => {
          const name = String(calls.find((c) => c.id === r.tool_use_id)?.name ?? "");
          const raw = typeof r.content === "string" ? r.content : "";
          if (r.is_error) return `Sorry, I couldn't do that: ${raw}`;
          try {
            return this.rules.describe(name, JSON.parse(raw) as Json);
          } catch {
            return this.rules.help;
          }
        })
        .join("\n\n");
      return fakeMessage([{ type: "text", text, citations: null }], "end_turn");
    }
    const said = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text))
      .join("\n");
    const intent = this.rules.intent(said);
    if (!intent) return fakeMessage([{ type: "text", text: this.rules.help, citations: null }], "end_turn");
    return fakeMessage([{ type: "tool_use", id: `toolu_mock_${Date.now().toString(36)}_${++this.seq}`, name: intent.tool, input: intent.input }], "tool_use");
  }
}

/** The configured model, or null when the assistant is disabled. `rules` sets the test-mode behaviour (customer by default). */
export function assistantModel(rules?: MockRules): AssistantModel | null {
  const name = assistantAdapterName();
  if (name === "anthropic") return new ClaudeModel();
  if (name === "mock") return new MockModel(rules);
  return null;
}
