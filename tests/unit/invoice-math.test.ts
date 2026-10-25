import { describe, expect, it } from "vitest";
import { allocateInOrder, computeLine, computeTotals, InvoiceMathError, settledStatus, splitCreditNote } from "@/server/domain/invoice-math";
import { D } from "@/server/domain/money";

const s = (v: { toFixed(n: number): string }) => v.toFixed(2);

describe("invoice line math", () => {
  it("rounds per line, half-up, and sums rounded lines", () => {
    const a = computeLine({ description: "A", quantity: "3", unitPrice: "333.33", taxRate: "16" });
    expect(s(a.lineSubtotal)).toBe("999.99");
    expect(s(a.taxAmount)).toBe("160.00"); // 159.9984 → 160.00
    expect(s(a.lineTotal)).toBe("1159.99");
    const b = computeLine({ description: "B", quantity: "1", unitPrice: "0.05", taxRate: "16" });
    expect(s(b.taxAmount)).toBe("0.01"); // 0.008 → 0.01
    const t = computeTotals([a, b]);
    expect(s(t.subtotal)).toBe("1000.04");
    expect(s(t.taxTotal)).toBe("160.01");
    expect(s(t.total)).toBe("1160.05");
  });

  it("avoids floating point drift", () => {
    const lines = Array.from({ length: 10 }, () => computeLine({ description: "x", quantity: "1", unitPrice: "0.10" }));
    expect(s(computeTotals(lines).total)).toBe("1.00");
  });

  it("applies discounts before tax and validates inputs", () => {
    const l = computeLine({ description: "Promo", quantity: "1", unitPrice: "2500", discount: "500", taxRate: "16" });
    expect(s(l.taxAmount)).toBe("320.00");
    expect(s(l.lineTotal)).toBe("2320.00");
    expect(() => computeLine({ description: "x", quantity: "1", unitPrice: "10", discount: "11" })).toThrow(InvoiceMathError);
    expect(() => computeLine({ description: "x", quantity: "0", unitPrice: "10" })).toThrow(InvoiceMathError);
    expect(() => computeLine({ description: "x", quantity: "1", unitPrice: "10", taxRate: "101" })).toThrow(InvoiceMathError);
  });

  it("supports fractional quantities", () => {
    expect(s(computeLine({ description: "Pro-rata", quantity: "0.5", unitPrice: "2999.99" }).lineTotal)).toBe("1500.00");
  });
});

describe("allocation and credit math", () => {
  it("allocates oldest first without exceeding balances", () => {
    const plan = allocateInOrder(new D("3000"), [
      { id: "a", balanceDue: new D("1000") },
      { id: "b", balanceDue: new D("0") },
      { id: "c", balanceDue: new D("2500") },
    ]);
    expect(plan.map((p) => [p.invoiceId, s(p.amount)])).toEqual([
      ["a", "1000.00"],
      ["c", "2000.00"],
    ]);
  });

  it("splits a credit note into net/tax and invoice/customer-credit parts", () => {
    const open = splitCreditNote(new D("1160"), { total: new D("2320"), taxTotal: new D("320"), balanceDue: new D("2320") });
    expect([s(open.net), s(open.tax), s(open.appliedToInvoice), s(open.toCustomerCredit)]).toEqual(["1000.00", "160.00", "1160.00", "0.00"]);
    const paid = splitCreditNote(new D("500"), { total: new D("2320"), taxTotal: new D("320"), balanceDue: new D("200") });
    expect([s(paid.appliedToInvoice), s(paid.toCustomerCredit)]).toEqual(["200.00", "300.00"]);
  });

  it("derives settlement status", () => {
    expect(settledStatus(new D("100"), new D("100"))).toBe("OPEN");
    expect(settledStatus(new D("100"), new D("40"))).toBe("PARTIALLY_PAID");
    expect(settledStatus(new D("100"), new D("0"))).toBe("PAID");
  });
});
