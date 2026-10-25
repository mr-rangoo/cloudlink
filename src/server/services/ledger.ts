import "server-only";
import { db, type Tx } from "@/server/db/client";
import { requirePermission, type ActorContext } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { D, type DecimalValue } from "@/server/domain/money";
import { actorType, actorUserId } from "@/server/services/common";
import type { LedgerAccountType, PaymentMethod, Prisma } from "@/generated/prisma/client";

/**
 * Double-entry ledger. Chart of accounts (per organization, created on demand):
 *
 * | Code | Account                           | Type      |
 * |------|-----------------------------------|-----------|
 * | 1000 | Cash on hand                      | ASSET     |
 * | 1010 | Bank                              | ASSET     |
 * | 1020 | M-Pesa                            | ASSET     |
 * | 1090 | Other receipts                    | ASSET     |
 * | 1100 | Accounts receivable               | ASSET     |
 * | 2100 | Customer credit (prepayments)     | LIABILITY |
 * | 2150 | Unidentified receipts             | LIABILITY |
 * | 2200 | Tax payable                       | LIABILITY |
 * | 3100 | Owner drawings                    | EQUITY    |
 * | 4000 | Service revenue                   | INCOME    |
 * | 4100 | Credit notes and allowances       | INCOME (contra) |
 * | 5000 | Operating expenses                | EXPENSE   |
 *
 * Postings:
 * - Invoice issued:      Dr AR total / Cr Revenue (net of discount) / Cr Tax payable
 * - Invoice voided:      exact reverse of the issue posting
 * - Payment received:    Dr Cash|Bank|M-Pesa / Cr Customer credit (or Unidentified receipts when unmatched)
 * - Payment matched:     Dr Unidentified receipts / Cr Customer credit
 * - Allocation:          Dr Customer credit / Cr AR
 * - Allocation reversed: Dr AR / Cr Customer credit
 * - Credit note:         Dr Allowances (net) / Dr Tax payable / Cr AR (applied part) / Cr Customer credit (remainder)
 * - Refund:              Dr Customer credit / Cr Cash|Bank|M-Pesa
 * - Payment reversed:    Dr Customer credit (or Unidentified) / Cr Cash|Bank|M-Pesa
 * - Expense:             Dr Operating expenses / Cr Cash|Bank|M-Pesa (reversal swaps sides)
 * - Owner drawing:       Dr Owner drawings / Cr Cash|Bank|M-Pesa;  Bank deposit: Dr Bank / Cr Cash|M-Pesa
 *
 * Entries are append-only (database trigger) and every transaction must balance (deferred constraint trigger).
 * A subscriber's balance = AR (subscriber lines) − Customer credit (subscriber lines).
 */
export const ACCOUNTS = {
  CASH: { code: "1000", name: "Cash on hand", type: "ASSET" },
  BANK: { code: "1010", name: "Bank", type: "ASSET" },
  MPESA: { code: "1020", name: "M-Pesa", type: "ASSET" },
  OTHER_RECEIPTS: { code: "1090", name: "Other receipts", type: "ASSET" },
  AR: { code: "1100", name: "Accounts receivable", type: "ASSET" },
  CUSTOMER_CREDIT: { code: "2100", name: "Customer credit (prepayments)", type: "LIABILITY" },
  UNIDENTIFIED: { code: "2150", name: "Unidentified receipts", type: "LIABILITY" },
  TAX_PAYABLE: { code: "2200", name: "Tax payable", type: "LIABILITY" },
  OWNER_DRAWINGS: { code: "3100", name: "Owner drawings", type: "EQUITY" },
  REVENUE: { code: "4000", name: "Service revenue", type: "INCOME" },
  ALLOWANCES: { code: "4100", name: "Credit notes and allowances", type: "INCOME" },
  EXPENSES: { code: "5000", name: "Operating expenses", type: "EXPENSE" },
} as const satisfies Record<string, { code: string; name: string; type: LedgerAccountType }>;

export type AccountKey = keyof typeof ACCOUNTS;

export function cashAccountFor(method: PaymentMethod): AccountKey {
  switch (method) {
    case "CASH":
      return "CASH";
    case "MPESA":
      return "MPESA";
    case "BANK_TRANSFER":
    case "CHEQUE":
    case "CARD":
      return "BANK";
    default:
      return "OTHER_RECEIPTS";
  }
}

export async function ensureLedgerAccounts(tx: Tx | typeof db, organizationId: string): Promise<Record<AccountKey, string>> {
  const existing = await tx.ledgerAccount.findMany({ where: { organizationId } });
  const byCode = new Map(existing.map((a) => [a.code, a.id]));
  const out = {} as Record<AccountKey, string>;
  for (const [key, def] of Object.entries(ACCOUNTS) as Array<[AccountKey, (typeof ACCOUNTS)[AccountKey]]>) {
    let id = byCode.get(def.code);
    if (!id) {
      const created = await tx.ledgerAccount.upsert({
        where: { organizationId_code: { organizationId, code: def.code } },
        update: {},
        create: { organizationId, code: def.code, name: def.name, type: def.type },
      });
      id = created.id;
    }
    out[key] = id;
  }
  return out;
}

export interface PostingLine {
  account: AccountKey;
  debit?: DecimalValue;
  credit?: DecimalValue;
  subscriberId?: string | null;
}

export interface PostingInput {
  type: string;
  sourceType: string;
  sourceId: string;
  description: string;
  currency: string;
  occurredAt?: Date;
  lines: PostingLine[];
}

/** Post a balanced transaction. Zero-amount lines are dropped; the whole posting is skipped if nothing remains. */
export async function postLedger(tx: Tx, ctx: ActorContext, input: PostingInput): Promise<string | null> {
  const lines = input.lines
    .map((l) => ({ ...l, debit: l.debit ?? new D(0), credit: l.credit ?? new D(0) }))
    .filter((l) => l.debit.gt(0) || l.credit.gt(0));
  if (lines.length === 0) return null;
  for (const l of lines) {
    if (l.debit.lt(0) || l.credit.lt(0) || (l.debit.gt(0) && l.credit.gt(0))) throw new AppError("INTERNAL_ERROR", "Invalid ledger line.");
  }
  const debits = lines.reduce((a, l) => a.plus(l.debit), new D(0));
  const credits = lines.reduce((a, l) => a.plus(l.credit), new D(0));
  if (!debits.eq(credits)) throw new AppError("INTERNAL_ERROR", "Unbalanced ledger posting.", { details: { debits: debits.toFixed(2), credits: credits.toFixed(2), type: input.type } });

  const accounts = await ensureLedgerAccounts(tx, ctx.organizationId);
  const txn = await tx.ledgerTransaction.create({
    data: {
      organizationId: ctx.organizationId,
      type: input.type,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description.slice(0, 300),
      currency: input.currency,
      occurredAt: input.occurredAt ?? new Date(),
      actorUserId: actorUserId(ctx),
      actorType: actorType(ctx),
    },
  });
  await tx.ledgerEntry.createMany({
    data: lines.map((l) => ({
      organizationId: ctx.organizationId,
      transactionId: txn.id,
      accountId: accounts[l.account],
      subscriberId: l.subscriberId ?? null,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
    })),
  });
  return txn.id;
}

/** Sum of (debit − credit) for an account, optionally for one subscriber. */
export async function accountBalance(client: Tx | typeof db, organizationId: string, account: AccountKey, subscriberId?: string): Promise<DecimalValue> {
  const rows = await client.$queryRaw<Array<{ bal: string | null }>>`
    SELECT COALESCE(SUM(e."debit" - e."credit"), 0)::text AS bal
    FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a."id" = e."accountId"
    WHERE e."organizationId" = ${organizationId}::uuid AND a."code" = ${ACCOUNTS[account].code}
      AND (${subscriberId ?? null}::uuid IS NULL OR e."subscriberId" = ${subscriberId ?? null}::uuid)`;
  return new D(rows[0]?.bal ?? "0");
}

/** Customer balance: positive = owes money; negative = has credit. */
export async function subscriberLedgerBalance(client: Tx | typeof db, organizationId: string, subscriberId: string) {
  const [ar, credit] = await Promise.all([accountBalance(client, organizationId, "AR", subscriberId), accountBalance(client, organizationId, "CUSTOMER_CREDIT", subscriberId)]);
  // Customer credit is a liability (credit-normal), so its debit−credit sum is ≤ 0 when the customer has credit.
  return { receivable: ar, credit: credit.neg(), net: ar.plus(credit) };
}

export async function listLedgerEntries(ctx: ActorContext, query: { page: number; pageSize: number; account?: string; subscriberId?: string }) {
  requirePermission(ctx, "ledger.read");
  const where: Prisma.LedgerEntryWhereInput = {
    organizationId: ctx.organizationId,
    ...(query.account ? { account: { code: query.account } } : {}),
    ...(query.subscriberId ? { subscriberId: query.subscriberId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.ledgerEntry.findMany({
      where,
      include: { account: { select: { code: true, name: true } }, transaction: { select: { type: true, description: true, occurredAt: true, sourceType: true, sourceId: true, currency: true } } },
      orderBy: [{ transaction: { occurredAt: "desc" } }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    db.ledgerEntry.count({ where }),
  ]);
  return { rows, total };
}

export async function trialBalance(ctx: ActorContext) {
  requirePermission(ctx, "ledger.read");
  return computeTrialBalance(ctx.organizationId);
}

/** Internal: no permission check (callers must have authorised the request). */
export async function computeTrialBalance(organizationId: string) {
  await ensureLedgerAccounts(db, organizationId);
  const rows = await db.$queryRaw<Array<{ code: string; name: string; type: string; debit: string; credit: string }>>`
    SELECT a."code", a."name", a."type"::text AS type,
           COALESCE(SUM(e."debit"), 0)::text AS debit, COALESCE(SUM(e."credit"), 0)::text AS credit
    FROM "LedgerAccount" a LEFT JOIN "LedgerEntry" e ON e."accountId" = a."id"
    WHERE a."organizationId" = ${organizationId}::uuid
    GROUP BY a."code", a."name", a."type" ORDER BY a."code"`;
  const accounts = rows.map((r) => ({ ...r, balance: new D(r.debit).minus(r.credit).toFixed(2) }));
  const totalDebit = rows.reduce((a, r) => a.plus(r.debit), new D(0));
  const totalCredit = rows.reduce((a, r) => a.plus(r.credit), new D(0));
  return { accounts, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), balanced: totalDebit.eq(totalCredit) };
}
