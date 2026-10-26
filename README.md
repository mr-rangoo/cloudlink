# Cloudlink

ISP billing, subscriber management, payments (M-Pesa) and MikroTik/RADIUS network operations for Kenya.
This repository contains the application built from the kit below.

- **Start here:** `docs/HANDOVER.md`, which covers what is built, what is verified, and what you need to provide next.
- **Run locally:** `docs/LOCAL_SETUP.md`.
- **Deploy and operate:** `docs/DEPLOYMENT_GUIDE.md` and `docs/OPERATIONS.md`.
- **Progress and evidence:** `IMPLEMENTATION_PLAN.md`.

---

# Cloudlink — Agent Implementation Kit

This kit guides Claude Code or OpenAI Codex through building **Cloudlink**, a full ISP billing, customer management, payments, and network operations platform.

## How to use

1. Extract `CLOUDLINK_AGENT_KIT.zip` into a new project folder or copy these files into your existing Cloudlink repository.
2. Open the project root in Claude Code or Codex.
3. Start with `AGENTS.md` and ask the agent to execute Phase 1 from `IMPLEMENTATION_PLAN.md`.
4. Continue phase by phase. Require the agent to run tests and update `IMPLEMENTATION_PLAN.md` after each phase.
5. Configure secrets only in local environment files or your cloud secret manager. Never paste production secrets into source files or commit them.

## File guide

- `AGENTS.md` — always-on instructions for the coding agent.
- `MASTER_BUILD_PROMPT.md` — complete implementation directive and definition of done.
- `PRD.md` — product requirements and user roles.
- `TRD.md` — architecture and technology decisions.
- `DATABASE.md` — domain model, relationships, and financial invariants.
- `API_SPEC.md` — API conventions and initial endpoint inventory.
- `APP_FLOW.md` — admin, customer, billing, payment, and network flows.
- `UI_UX_GUIDE.md` — Cloudlink design system and interaction requirements.
- `INTEGRATIONS.md` — M-Pesa, MikroTik, RADIUS, messaging, and storage integration rules.
- `SECURITY.md` — security and privacy baseline.
- `TESTING.md` — test strategy and acceptance checks.
- `DEPLOYMENT.md` — cloud deployment, operations, backups, and release process.
- `IMPLEMENTATION_PLAN.md` — phased execution checklist.
- `.env.example` — placeholder configuration only.

## Product scope

Cloudlink is a multi-tenant ISP operations platform for Kenya, with KES as the default currency and `Africa/Nairobi` as the default business timezone. It includes CRM, subscribers, packages, subscriptions, invoices, payment reconciliation, M-Pesa, manual/bank payments, MikroTik PPPoE/Hotspot, RADIUS integration, vouchers, customer portal, support, reporting, audit logs, and cloud deployment.

## Important implementation rule

A page is not a feature. A feature is complete only when its UI, server-side validation, authorization, database persistence, business logic, error states, audit trail where required, and tests are implemented. External integrations must be clearly marked as mock, sandbox-tested, or production-verified.
