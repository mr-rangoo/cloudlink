import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { hasPermission, listWhere, tenantWhere, type StaffContext } from "@/server/auth/context";
import { formatPhone, normalizePhone } from "@/server/domain/contact";
import { searchTerm } from "@/server/services/common";

/**
 * Record search for the Ctrl+K menu. Each kind of record is searched only with its read permission and within the
 * caller's organization and branch scope; at most five hits per kind. Returns titles and links only.
 */
export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });

export interface SearchHit {
  type: "subscriber" | "invoice" | "payment" | "router" | "ticket" | "lead";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const TAKE = 5;

export async function searchRecords(ctx: StaffContext, query: z.infer<typeof searchQuery>): Promise<SearchHit[]> {
  const q = searchTerm(query.q);
  if (!q) return [];
  const phone = normalizePhone(q);
  const digits = q.replace(/\D/g, "");
  const scope = listWhere(ctx);
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(ctx, p);

  const [subscribers, invoices, payments, routers, tickets, leads] = await Promise.all([
    can("subscribers.read")
      ? db.subscriber.findMany({
          where: {
            ...scope,
            OR: [
              { displayName: { contains: q, mode: "insensitive" } },
              { accountNumber: { contains: q, mode: "insensitive" } },
              { emailNormalized: { contains: q.toLowerCase() } },
              ...(phone || digits.length >= 4 ? [{ phone: { contains: phone ?? digits } }] : []),
            ],
          },
          select: { id: true, displayName: true, accountNumber: true, phone: true, status: true },
          orderBy: { displayName: "asc" },
          take: TAKE,
        })
      : [],
    can("invoices.read")
      ? db.invoice.findMany({
          where: { ...scope, invoiceNumber: { contains: q, mode: "insensitive" } },
          select: { id: true, invoiceNumber: true, status: true, total: true, currency: true },
          orderBy: { createdAt: "desc" },
          take: TAKE,
        })
      : [],
    can("payments.read")
      ? db.payment.findMany({
          where: {
            ...scope,
            OR: [{ receiptNumber: { contains: q, mode: "insensitive" } }, { providerTransactionId: { contains: q, mode: "insensitive" } }, { payerName: { contains: q, mode: "insensitive" } }],
          },
          select: { id: true, receiptNumber: true, providerTransactionId: true, amount: true, currency: true, method: true, payerName: true },
          orderBy: { createdAt: "desc" },
          take: TAKE,
        })
      : [],
    can("routers.read")
      ? db.router.findMany({
          where: { ...tenantWhere(ctx), archivedAt: null, OR: [{ name: { contains: q, mode: "insensitive" } }, { identity: { contains: q, mode: "insensitive" } }, { host: { startsWith: q } }] },
          select: { id: true, name: true, host: true, status: true },
          orderBy: { name: "asc" },
          take: TAKE,
        })
      : [],
    can("support.read")
      ? db.supportTicket.findMany({
          where: { ...scope, OR: [{ ticketNumber: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }] },
          select: { id: true, ticketNumber: true, subject: true, status: true },
          orderBy: { createdAt: "desc" },
          take: TAKE,
        })
      : [],
    can("leads.read")
      ? db.lead.findMany({
          where: { ...scope, OR: [{ name: { contains: q, mode: "insensitive" } }, ...(phone ? [{ phone: { contains: phone } }] : [])] },
          select: { id: true, name: true, stage: true },
          orderBy: { createdAt: "desc" },
          take: TAKE,
        })
      : [],
  ]);

  const lower = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ");
  return [
    ...subscribers.map((s): SearchHit => ({ type: "subscriber", id: s.id, title: s.displayName, subtitle: `${s.accountNumber} · ${formatPhone(s.phone)}${s.status === "ACTIVE" ? "" : ` · ${lower(s.status)}`}`, href: `/subscribers/${s.id}` })),
    ...invoices.map((i): SearchHit => ({ type: "invoice", id: i.id, title: i.invoiceNumber ?? "Draft invoice", subtitle: `${i.currency} ${i.total.toFixed(2)} · ${lower(i.status)}`, href: `/invoices/${i.id}` })),
    ...payments.map((p): SearchHit => ({
      type: "payment",
      id: p.id,
      title: p.receiptNumber ?? p.providerTransactionId ?? "Payment",
      subtitle: `${p.currency} ${p.amount.toFixed(2)} · ${lower(p.method)}${p.providerTransactionId && p.receiptNumber ? ` · ${p.providerTransactionId}` : ""}${p.payerName ? ` · ${p.payerName}` : ""}`,
      href: `/payments/${p.id}`,
    })),
    ...routers.map((r): SearchHit => ({ type: "router", id: r.id, title: r.name, subtitle: `${r.host ?? "Cloudlink agent"} · ${lower(r.status)}`, href: `/routers/${r.id}` })),
    ...tickets.map((t): SearchHit => ({ type: "ticket", id: t.id, title: `${t.ticketNumber} ${t.subject}`, subtitle: lower(t.status), href: `/support/${t.id}` })),
    ...leads.map((l): SearchHit => ({ type: "lead", id: l.id, title: l.name, subtitle: `Lead · ${lower(l.stage)}`, href: `/leads/${l.id}` })),
  ];
}
