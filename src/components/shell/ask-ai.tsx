"use client";

import * as React from "react";
import { Dialog } from "radix-ui";
import { SendHorizontal, Sparkles, X } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface Turn {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
}

const SUGGESTIONS = ["How much have we collected today?", "Who expires in the next 24 hours?", "Which routers are offline?", "Show the latest payments"];
const TOOL_LABEL: Record<string, string> = {
  business_snapshot: "Business snapshot",
  find_subscribers: "Subscriber search",
  subscriber_details: "Subscriber account",
  recent_payments: "Payments",
  expiring_subscriptions: "Expiring plans",
  router_status: "Routers",
};

/** "Ask AI" button for the top bar and the side panel it opens. Answers come from the server, scoped to this staff member. */
export function AskAi({ simulated }: { simulated: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, pending]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const history: Turn[] = [...turns, { role: "user", text: q }];
    setTurns(history);
    setDraft("");
    setPending(true);
    setError(null);
    try {
      const res = await api<{ data: { reply: string; tools: string[] } }>("/assistant/ask", { body: { messages: history.slice(-12).map(({ role, text }) => ({ role, text })) } });
      setTurns([...history, { role: "assistant", text: res.data.reply, tools: res.data.tools }]);
    } catch (err) {
      setTurns(turns);
      setDraft(q);
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] font-medium hover:bg-surface-muted">
        <Sparkles className="size-4 text-accent" aria-hidden />
        <span className="hidden sm:inline">Ask AI</span>
        <span className="sr-only sm:hidden">Ask AI</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-(--shadow-pop) sm:inset-y-3 sm:right-3 sm:rounded-2xl sm:border" aria-describedby="ask-ai-note">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Sparkles className="size-4 text-accent" aria-hidden />
            <Dialog.Title className="text-[15px] font-semibold">Ask AI</Dialog.Title>
            {simulated ? <span className="rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">Test mode</span> : null}
            <Dialog.Close className="ml-auto rounded-full p-1.5 text-muted-foreground hover:bg-surface-muted hover:text-foreground" aria-label="Close Ask AI">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <p id="ask-ai-note" className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            Answers come from your Cloudlink records, limited to what your role can see. Check important figures before acting on them.{simulated ? " Test mode: replies use simple rules, not an AI service." : ""}
          </p>
          <div role="log" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {turns.length === 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Try:</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => void ask(s)} className="block w-full rounded-xl border border-border px-3 py-2 text-left text-sm hover:bg-surface-muted">
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            {turns.map((t, i) => (
              <div key={i} className={cn("flex flex-col gap-1", t.role === "user" ? "items-end" : "items-start")}>
                <div className={cn("max-w-[90%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm", t.role === "user" ? "rounded-br-sm bg-accent text-accent-foreground" : "rounded-bl-sm bg-surface-muted")}>{t.text}</div>
                {t.tools?.length ? <p className="text-[11px] text-muted-foreground">Looked at: {t.tools.map((x) => TOOL_LABEL[x] ?? x).join(", ")}</p> : null}
              </div>
            ))}
            {pending ? <p className="text-xs text-muted-foreground">Looking it up…</p> : null}
            <div ref={endRef} />
          </div>
          <form
            className="space-y-2 border-t border-border px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="flex items-end gap-2">
              <label htmlFor="ask-ai-input" className="sr-only">
                Ask about your business
              </label>
              <textarea
                id="ask-ai-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void ask(draft);
                  }
                }}
                rows={1}
                maxLength={2000}
                placeholder="Ask about payments, subscribers, routers…"
                className="max-h-32 min-h-10 flex-1 resize-y rounded-xl border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
              />
              <button type="submit" disabled={!draft.trim() || pending} className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground disabled:opacity-50" aria-label="Send">
                <SendHorizontal className="size-4" />
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
