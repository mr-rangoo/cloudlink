import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Money handling: decimal.js only, never JS floats. Amounts cross the API as strings ("1500.00").
 * Rounding is half-up to 2 decimal places (KES cents), applied per line.
 */
export const D = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP });
export type DecimalValue = InstanceType<typeof D>;

export const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
export const PERCENT_RE = /^\d{1,3}(\.\d{1,2})?$/;

/** Non-negative money amount as a string with at most 2 decimals. */
export const moneyInput = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v.toString() : v.trim()))
  .refine((v) => MONEY_RE.test(v), { message: "Enter an amount with at most 2 decimal places." });

/** Strictly positive money amount. */
export const positiveMoneyInput = moneyInput.refine((v) => new D(v).gt(0), { message: "Amount must be greater than zero." });

export const percentInput = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v.toString() : v.trim()))
  .refine((v) => PERCENT_RE.test(v) && new D(v).lte(100), { message: "Enter a percentage between 0 and 100." });

export function toMoney(value: Decimal.Value | { toString(): string }): DecimalValue {
  return new D(value.toString()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function moneyString(value: Decimal.Value | { toString(): string }): string {
  return toMoney(value).toFixed(2);
}

export function sumMoney(values: Array<Decimal.Value | { toString(): string }>): DecimalValue {
  return values.reduce<DecimalValue>((acc, v) => acc.plus(new D(v.toString())), new D(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function isCurrencyCode(v: string): boolean {
  return /^[A-Z]{3}$/.test(v);
}
