/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, UTF-8 BOM).
 * Returns header-keyed rows. Throws on unterminated quotes or excessive size.
 */
export interface CsvResult {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export class CsvError extends Error {}

export function parseCsv(text: string, opts: { maxRows?: number; maxBytes?: number } = {}): CsvResult {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const maxRows = opts.maxRows ?? 5000;
  if (text.length > maxBytes) throw new CsvError(`File is larger than ${Math.round(maxBytes / 1_000_000)} MB.`);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      record.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (records.length > maxRows + 1) throw new CsvError(`File has more than ${maxRows} rows.`);
    } else {
      field += c;
      i++;
    }
  }
  if (inQuotes) throw new CsvError("File has an unterminated quoted field.");
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ""));
  if (nonEmpty.length === 0) throw new CsvError("File is empty.");
  const headers = nonEmpty[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (new Set(headers).size !== headers.length) throw new CsvError("File has duplicate column headers.");
  if (nonEmpty.length - 1 > maxRows) throw new CsvError(`File has more than ${maxRows} rows.`);

  const rows = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? "").trim()])));
  return { headers, rows };
}

/** Neutralise spreadsheet formula injection when exporting user-provided text to CSV. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
