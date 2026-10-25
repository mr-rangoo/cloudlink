/**
 * Upload validation by content (magic bytes), not by the client-supplied type or extension.
 * Allowed: PNG, JPEG, WebP, PDF and plain text. Maximum 5 MB.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type AllowedType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "text/plain";

const EXT: Record<AllowedType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt" };

export function sniffContentType(buf: Buffer): AllowedType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  // Plain text: valid UTF-8 without NUL bytes or most control characters.
  if (buf.length > 0 && !buf.includes(0)) {
    const text = buf.toString("utf8");
    if (!text.includes("�") && !/[\x01-\x08\x0E-\x1F]/.test(text)) return "text/plain";
  }
  return null;
}

export interface UploadCheck {
  ok: boolean;
  contentType?: AllowedType;
  extension?: string;
  error?: string;
}

export function validateUpload(buf: Buffer, declaredName: string): UploadCheck {
  if (buf.length === 0) return { ok: false, error: "The file is empty." };
  if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, error: "Files must be 5 MB or smaller." };
  const type = sniffContentType(buf);
  if (!type) return { ok: false, error: "Only PNG, JPEG, WebP, PDF or plain-text files are allowed." };
  if (declaredName.length > 200) return { ok: false, error: "The file name is too long." };
  return { ok: true, contentType: type, extension: EXT[type] };
}

/** Safe display name: strips paths and control characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\x00-\x1F\x7F"<>:|?*]/g, "_").trim();
  return cleaned.slice(0, 120) || "file";
}
