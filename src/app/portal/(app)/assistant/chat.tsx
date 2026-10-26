"use client";

import * as React from "react";
import Link from "next/link";
import { RotateCcw, SendHorizontal, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  id: string;
  role: "customer" | "assistant" | "notice";
  text: string;
  tools: string[];
}

const TOOL_LABEL: Record<string, string> = {
  get_account_summary: "Checked your account",
  list_invoices: "Checked your invoices",
  list_payments: "Checked your payments",
  get_connection_status: "Checked your connection",
  get_payment_options: "Looked up ways to pay",
  create_support_ticket: "Opened a support ticket",
};

const SUGGESTIONS = ["What is my balance?", "Is my internet online?", "How do I pay?", "Show my open invoices"];

/** Chat with the organization's assistant. Replies come from the server; nothing is generated in the browser. */
export function AssistantChat({ name, initial, conversationId: initialId }: { name: string; initial: ChatMessage[]; conversationId: string | null }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>(initial);
  const [conversationId, setConversationId] = React.useState(initialId);
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ticket, setTicket] = React.useState<{ id: string; ticketNumber: string } | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || pending) return;
    setPending(true);
    setError(null);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "customer", text: body, tools: [] }]);
    setDraft("");
    try {
      const res = await api<{ data: { conversationId: string; messages: ChatMessage[]; ticket: { id: string; ticketNumber: string } | null } }>("/customer/assistant/messages", {
        body: { text: body, ...(conversationId ? { conversationId } : {}) },
      });
      setConversationId(res.data.conversationId);
      // Replace the optimistic copy of the customer's message with the stored one.
      setMessages((m) => [...m.filter((x) => !x.id.startsWith("local-")), ...res.data.messages]);
      if (res.data.ticket) setTicket(res.data.ticket);
    } catch (err) {
      setMessages((m) => m.filter((x) => !x.id.startsWith("local-")));
      setDraft(body);
      if (err instanceof ApiError && err.code === "INVALID_STATE") setConversationId(null);
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const restart = async () => {
    setError(null);
    try {
      await api("/customer/assistant/end", { method: "POST" });
      setMessages([]);
      setConversationId(null);
      setTicket(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a new chat.");
    }
  };

  return (
    <div className="flex min-h-[60dvh] flex-col">
      <div role="log" aria-live="polite" aria-label={`Chat with ${name}`} className="flex-1 space-y-3 px-4 py-4 sm:px-5">
        {messages.length === 0 && !pending ? (
          <div className="space-y-3 py-6 text-center">
            <Sparkles className="mx-auto size-6 text-accent" aria-hidden />
            <p className="text-sm text-muted-foreground">Ask about your balance, invoices, payments or connection.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m) =>
          m.role === "notice" ? (
            <p key={m.id} className="mx-auto max-w-prose rounded-md bg-surface-muted px-3 py-2 text-center text-xs text-muted-foreground">
              {m.text}
            </p>
          ) : (
            <div key={m.id} className={cn("flex flex-col gap-1", m.role === "customer" ? "items-end" : "items-start")}>
              <p className="sr-only">{m.role === "customer" ? "You said:" : `${name} said:`}</p>
              <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm", m.role === "customer" ? "rounded-br-sm bg-accent text-accent-foreground" : "rounded-bl-sm bg-surface-muted")}>{m.text}</div>
              {m.tools.length ? <p className="text-xs text-muted-foreground">{[...new Set(m.tools)].map((t) => TOOL_LABEL[t] ?? t).join(" · ")}</p> : null}
            </div>
          ),
        )}
        {pending ? (
          <div className="flex items-start" aria-label={`${name} is replying`}>
            <div className="rounded-2xl rounded-bl-sm bg-surface-muted px-3.5 py-2.5">
              <span className="flex gap-1" aria-hidden>
                {[0, 150, 300].map((d) => (
                  <span key={d} className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
            </div>
          </div>
        ) : null}
        {ticket ? (
          <Alert tone="success">
            Ticket {ticket.ticketNumber} was opened.{" "}
            <Link href={`/portal/tickets/${ticket.id}`} className="font-medium underline">
              View ticket
            </Link>
          </Alert>
        ) : null}
        <div ref={endRef} />
      </div>
      <form
        className="sticky bottom-0 space-y-2 border-t border-border bg-surface px-4 py-3 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex items-end gap-2">
          <label htmlFor="assistant-input" className="sr-only">
            Message {name}
          </label>
          <textarea
            id="assistant-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={1}
            maxLength={1000}
            placeholder={`Message ${name}…`}
            className="max-h-32 min-h-10 flex-1 resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" loading={pending} disabled={!draft.trim()} aria-label="Send">
            <SendHorizontal />
          </Button>
        </div>
        {messages.length ? (
          <button type="button" onClick={restart} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <RotateCcw className="size-3" aria-hidden /> New chat
          </button>
        ) : null}
      </form>
    </div>
  );
}
