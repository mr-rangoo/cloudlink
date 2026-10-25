import { describe, expect, it } from "vitest";
import { safeFileName, sniffContentType, validateUpload } from "@/server/domain/uploads";
import { renderTemplate } from "@/server/services/notifications";

describe("upload validation", () => {
  it("identifies allowed types by magic bytes, not by name", () => {
    expect(sniffContentType(Buffer.from("89504e470d0a1a0a0000", "hex"))).toBe("image/png");
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffContentType(Buffer.from("plain notes\nline 2"))).toBe("text/plain");
    expect(sniffContentType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // Windows executable
    expect(sniffContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBeNull(); // zip (contains NUL)
  });

  it("enforces size limits and sanitises names", () => {
    expect(validateUpload(Buffer.alloc(0), "a.txt").ok).toBe(false);
    expect(validateUpload(Buffer.alloc(5 * 1024 * 1024 + 1, 97), "a.txt").ok).toBe(false);
    expect(validateUpload(Buffer.from("hello"), "a.exe")).toMatchObject({ ok: true, contentType: "text/plain", extension: "txt" });
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\photo<1>.png")).toBe("photo_1_.png");
  });
});

describe("notification templates", () => {
  it("fills known variables and leaves unknown ones visible", () => {
    expect(renderTemplate("Hi {{name}}, pay {{ amount }} by {{dueDate}} {{oops}}", { name: "Asha", amount: "KES 1,000.00", dueDate: "1 Nov 2026" })).toBe("Hi Asha, pay KES 1,000.00 by 1 Nov 2026 {{oops}}");
  });
});
