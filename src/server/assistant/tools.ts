import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "@/server/db/client";
import type { CustomerContext } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import { customerConnection, customerOverview, listCustomerPayments } from "@/server/portal/services";
import { activePaymentInstructions } from "@/server/services/payment-methods";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { createCustomerTicket } from "@/server/services/tickets";
import { formatBytes, formatDuration } from "@/lib/format";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";

/**
 * Tools the assistant may call. Every tool reads or writes only the signed-in customer's own records: the scope
 * comes from the customer session, never from the model's input. Results are compact JSON with amounts and dates
 * already formatted, so the model restates them rather than computing them.
 */

const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

// Fixed order and wording: the tool list is part of the cached prompt prefix.
export const ASSISTANT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_account_summary",
    description: "The customer's balance (amount due or credit), services with status and paid-until date, and today's date. Use for balance, due amount, package or expiry questions.",
    input_schema: object({}),
    strict: true,
  },
  {
    name: "list_invoices",
    description: "The customer's invoices with number, status, total, balance due and due date. 'open' = unpaid or partly paid; 'recent' = the latest ten of any status.",
    input_schema: object({ which: { type: "string", enum: ["open", "recent"] } }),
    strict: true,
  },
  {
    name: "list_payments",
    description: "The customer's latest ten payments with amount, method, date, receipt and M-Pesa reference. A payment that is not listed has not been recorded yet.",
    input_schema: object({}),
    strict: true,
  },
  {
    name: "get_connection_status",
    description: "Whether the customer's internet connection is online, from the last network sync: time online, IP address, data used this session, when it was last online, and whether the reading is stale or test data.",
    input_schema: object({}),
    strict: true,
  },
  {
    name: "get_payment_options",
    description: "How this customer can pay (M-Pesa paybill/till, bank, cash, other) with their own account number filled in, and whether paying from the portal is available.",
    input_schema: object({}),
    strict: true,
  },
  {
    name: "create_support_ticket",
    description:
      "Open a support ticket so staff follow up. Only call this after the customer asks for a person or a ticket, or agrees when you offer one. At most one ticket per chat. Write the subject and description from the customer's point of view and include the details they gave.",
    input_schema: object({
      subject: { type: "string", description: "Short summary, 3-160 characters" },
      description: { type: "string", description: "What the customer needs, with relevant details from the chat" },
      category: { type: "string", enum: ["CONNECTIVITY", "BILLING", "INSTALLATION", "EQUIPMENT", "ACCOUNT", "OTHER"] },
    }),
    strict: true,
  },
];

const inputs = {
  get_account_summary: z.object({}).strict(),
  list_invoices: z.object({ which: z.enum(["open", "recent"]) }).strict(),
  list_payments: z.object({}).strict(),
  get_connection_status: z.object({}).strict(),
  get_payment_options: z.object({}).strict(),
  create_support_ticket: z
    .object({
      subject: z.string().trim().min(3).max(160),
      description: z.string().trim().min(3).max(4000),
      category: z.enum(["CONNECTIVITY", "BILLING", "INSTALLATION", "EQUIPMENT", "ACCOUNT", "OTHER"]),
    })
    .strict(),
} as const;
type ToolName = keyof typeof inputs;

export interface ToolScope {
  customer: CustomerContext;
  assistantName: string;
  /** Ticket already opened from this chat, if any (one per chat). */
  ticket: { id: string; ticketNumber: string } | null;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  ticket?: { id: string; ticketNumber: string };
}

const MONTHS: Record<string, string> = { DAY: "day", WEEK: "week", MONTH: "month", YEAR: "year" };

export async function runAssistantTool(scope: ToolScope, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!(name in inputs)) return { content: `Unknown tool: ${name}`, isError: true };
  const parsed = inputs[name as ToolName].safeParse(rawInput ?? {});
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`, isError: true };
  try {
    const result = await run(scope, name as ToolName, parsed.data);
    return { content: JSON.stringify(result.data), isError: false, ticket: result.ticket };
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return { content: err.message, isError: true };
    logger.error({ tool: name, err: (err as Error).message }, "assistant tool failed");
    return { content: "This information is temporarily unavailable.", isError: true };
  }
}

async function run(scope: ToolScope, name: ToolName, input: Record<string, unknown>): Promise<{ data: unknown; ticket?: { id: string; ticketNumber: string } }> {
  const ctx = scope.customer;
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true, timezone: true } });
  const tz = org.timezone;
  switch (name) {
    case "get_account_summary": {
      const o = await customerOverview(ctx);
      const net = Number(o.balance.net);
      return {
        data: {
          today: new Intl.DateTimeFormat("en-KE", { dateStyle: "full", timeZone: tz }).format(new Date()),
          customer: { name: o.subscriber.displayName, accountNumber: o.subscriber.accountNumber },
          balance: { status: net > 0 ? "owes" : net < 0 ? "credit" : "paid_up", amountDue: formatMoney(Math.max(net, 0).toFixed(2), org.currency), credit: formatMoney(Math.max(-net, 0).toFixed(2), org.currency) },
          services: o.subscriptions.map((s) => ({
            package: s.packageName,
            status: s.status,
            price: `${formatMoney(s.price.toString(), s.currency)} ${s.billingCount === 1 ? `per ${MONTHS[s.billingUnit] ?? s.billingUnit.toLowerCase()}` : `every ${s.billingCount} ${MONTHS[s.billingUnit] ?? s.billingUnit.toLowerCase()}s`}`,
            paidUntil: s.currentPeriodEnd ? formatDate(s.currentPeriodEnd, tz) : null,
          })),
          openInvoices: o.openInvoices.length,
        },
      };
    }
    case "list_invoices": {
      const rows = await db.invoice.findMany({
        where: { organizationId: ctx.organizationId, subscriberId: ctx.subscriberId, ...(input.which === "open" ? { status: { in: ["OPEN", "PARTIALLY_PAID"] } } : { status: { not: "DRAFT" } }) },
        orderBy: input.which === "open" ? { dueAt: "asc" } : { issuedAt: "desc" },
        take: 10,
        select: { invoiceNumber: true, status: true, total: true, balanceDue: true, currency: true, issuedAt: true, dueAt: true },
      });
      return {
        data: {
          invoices: rows.map((i) => ({
            number: i.invoiceNumber,
            status: i.status,
            total: formatMoney(i.total.toString(), i.currency),
            balanceDue: formatMoney(i.balanceDue.toString(), i.currency),
            issued: i.issuedAt ? formatDate(i.issuedAt, tz) : null,
            dueDate: i.dueAt ? formatDate(i.dueAt, tz) : null,
          })),
        },
      };
    }
    case "list_payments": {
      const rows = (await listCustomerPayments(ctx)).slice(0, 10);
      return {
        data: {
          payments: rows.map((p) => ({
            receipt: p.receiptNumber,
            amount: formatMoney(p.amount.toString(), p.currency),
            method: p.method === "MPESA" ? "M-Pesa" : p.method.replace("_", " ").toLowerCase(),
            reference: p.reference,
            date: p.receivedAt ? formatDateTime(p.receivedAt, tz) : null,
            status: p.status,
          })),
        },
      };
    }
    case "get_connection_status": {
      const c = await customerConnection(ctx);
      return {
        data: {
          status: c.status,
          onlineFor: c.since ? formatDuration(Math.floor((Date.now() - c.since.getTime()) / 1000)) : null,
          ipAddress: c.address,
          downloadedThisSession: c.downloadedBytes ? formatBytes(c.downloadedBytes) : null,
          uploadedThisSession: c.uploadedBytes ? formatBytes(c.uploadedBytes) : null,
          lastOnline: c.lastOnlineAt ? formatDateTime(c.lastOnlineAt, tz) : null,
          checkedAt: c.checkedAt ? formatDateTime(c.checkedAt, tz) : null,
          stale: c.stale,
          testData: c.simulated,
        },
      };
    }
    case "get_payment_options": {
      const sub = await db.subscriber.findUniqueOrThrow({ where: { id: ctx.subscriberId }, select: { accountNumber: true } });
      const methods = await activePaymentInstructions(ctx.organizationId, sub.accountNumber);
      const mode = paymentAdapterMode();
      return {
        data: {
          accountNumber: sub.accountNumber,
          methods: methods.map((m) => ({ name: m.label, steps: m.lines, note: m.note })),
          onlinePayment: mode !== "disabled" && org.currency === "KES" ? "on the Home page, choose Pay with M-Pesa and approve the prompt on your phone." : null,
          onlinePaymentTestMode: mode === "mock",
        },
      };
    }
    case "create_support_ticket": {
      if (scope.ticket) throw new AppError("INVALID_STATE", `A ticket was already opened in this chat: ${scope.ticket.ticketNumber}.`);
      const i = input as z.infer<typeof inputs.create_support_ticket>;
      const t = await createCustomerTicket(
        ctx,
        { subject: i.subject, description: `${i.description}\n\n— Opened by ${scope.assistantName} (AI assistant) at the customer's request.`, category: i.category },
        { channel: "ai_assistant" },
      );
      return { data: { ticketNumber: t.ticketNumber, status: t.status, whereToFollowUp: "Support page in the customer portal" }, ticket: { id: t.id, ticketNumber: t.ticketNumber } };
    }
  }
}
