# Customer-portal AI assistant

The assistant is a chat in the customer portal. It answers each customer's questions about their own account, explains how to pay, and opens a support ticket when a person is needed. It uses Claude through the official Anthropic SDK (`@anthropic-ai/sdk`).

## What it can and cannot do
The assistant works only through six server-side tools. Each tool takes its scope from the customer's session, never from the model.

| Tool | What it returns |
| --- | --- |
| `get_account_summary` | Balance (amount due or credit), services with status and paid-until date, today's date |
| `list_invoices` | Open invoices, or the latest ten |
| `list_payments` | Latest ten payments, with M-Pesa reference |
| `get_connection_status` | Online or offline from the last session sync, with a stale or test-data flag |
| `get_payment_options` | The organization's payment methods with the customer's account number filled in, and whether portal M-Pesa is available |
| `create_support_ticket` | Opens a ticket on channel `ai_assistant`, at most one per chat |

It cannot take payments, change packages, restart equipment, or grant refunds, credits or extensions. The system prompt tells it to state only facts that come from tool results, and to offer a ticket otherwise.

## Turning it on
1. **Deployment (server environment):**
   ```
   ASSISTANT_ADAPTER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...      # server only; never sent to browsers, redacted from logs
   ASSISTANT_MODEL=claude-opus-5-5   # default
   ASSISTANT_EFFORT=low              # low | medium | high; low suits short support chats
   ```
   - `ASSISTANT_ADAPTER=mock` is test mode. Replies come from simple rules over the same tools, with no AI service called. Production rejects it.
   - `disabled` is the default.
2. **Organization:** go to **Settings → AI assistant**, switch it on, name it (for example "Nuru"), and optionally add guidance such as office hours or outage notices. Customers then see a link in the portal navigation and on the home page.

## How a message is handled
The flow is in `src/server/assistant/service.ts`:
1. Rate limits apply: 20 messages per customer per 10 minutes, and 2,000 per organization per day.
2. The chat's stored history is replayed to the model unchanged, followed by the new message. Replayed content includes thinking, tool and fallback blocks.
3. A bounded tool loop runs: at most 6 model calls per message. Each tool input is validated with zod, and tools are declared with `strict: true`.
4. Stop reasons are handled as follows:
   - `refusal`: the customer sees a polite notice, and the refused turn is kept for staff but not replayed.
   - Cut off or out of steps: any unanswered tool call gets an error result so the history stays valid, and the customer sees "please try again".
5. The whole turn is saved in one transaction that checks no other message landed meanwhile. If the model call fails, nothing is stored and the customer's text stays in the box.

Request settings:
- `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) re-runs a declined request on Anthropic's recommended fallback model.
- Top-level `cache_control` caches the stable system prompt, tools and history, so each turn re-reads them at cache rates.

## Privacy and records
- **Disclosure.** The chat page says the customer is talking to an AI, that it can make mistakes, and that staff can read the chat.
- **What goes to Anthropic.** Each question, plus the account details needed to answer it, is sent to Anthropic. The settings page states this.
- **Staff transcripts.** Staff with `support.read` see transcripts under **Support → Assistant chats**, scoped by branch. Transcripts show what the customer saw and which lookups ran with what input. Lookup results are not shown.
- **Retention.** Chats are deleted after 180 days without activity by the daily `maintenance.prune` job.
- **Audit.** Settings changes are written to the audit log as `settings.assistant.update`.

## Testing
- `tests/integration/assistant.test.ts` covers test mode and the Claude adapter:
  - Test mode: the off-by-default switch and permissions, answers from real records, one ticket per chat, customer isolation, rate limit, staff scope, retention.
  - Claude adapter, against a local fake of the Messages API: request headers and body, strict tools, byte-for-byte replay, the refused-turn exclusion, safe error mapping, and never mixing test-mode history into a Claude chat.
- `tests/e2e/assistant.spec.ts` drives the full flow in a browser in test mode.
- **Not verified with a real Anthropic API key.** To verify, set the variables above on a staging server, enable the assistant for a test organization, and ask a balance question, a payment question and a ticket request.

## API
| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/customer/assistant` | customer | Availability, name, open chat |
| `POST /api/v1/customer/assistant/messages` | customer | Send a message (`{ text, conversationId? }`) |
| `POST /api/v1/customer/assistant/end` | customer | End the chat |
| `GET`/`PUT /api/v1/settings/assistant` | `settings.write` | Settings and deployment status (no secrets) |
| `GET /api/v1/assistant/conversations[/:id]` | `support.read` | Chat list and transcript |
