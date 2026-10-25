import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const DEFAULT_TZ = "Africa/Nairobi";

export function formatDateTime(value: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value));
}

export function formatDate(value: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone }).format(new Date(value));
}

/** Format a decimal string/number as money. Accepts strings to avoid float conversion of stored decimals. */
export function formatMoney(amount: string | number | { toString(): string } | null | undefined, currency = "KES"): string {
  if (amount === null || amount === undefined) return "—";
  const str = typeof amount === "string" ? amount : amount.toString();
  const negative = str.startsWith("-");
  const [intPart = "0", frac = ""] = str.replace("-", "").split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${(frac + "00").slice(0, 2)}`;
}
