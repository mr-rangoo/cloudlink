import { afterEach, describe, expect, it } from "vitest";
import {
  c2bConfirmationSchema,
  darajaTimestamp,
  maskMsisdn,
  normaliseBillRef,
  parseDarajaTimestamp,
  stkAmountProblem,
  stkCallbackSchema,
  stkMessage,
  stkOutcome,
  stkPassword,
  stkReference,
  stkSuccessDetails,
  toMsisdn,
} from "@/server/domain/mpesa";
import { callbackSourceAllowed } from "@/server/services/mobile-money";
import { parseEnv } from "@/server/env";

describe("Daraja request helpers", () => {
  it("formats timestamps in East Africa Time", () => {
    expect(darajaTimestamp(new Date(Date.UTC(2026, 9, 25, 9, 30, 15)))).toBe("20261025123015");
    expect(darajaTimestamp(new Date(Date.UTC(2026, 11, 31, 22, 0, 0)))).toBe("20270101010000");
    expect(parseDarajaTimestamp(20261025123015)?.toISOString()).toBe("2026-10-25T09:30:15.000Z");
    expect(parseDarajaTimestamp("2026-10-25")).toBeNull();
    expect(parseDarajaTimestamp(undefined)).toBeNull();
  });

  it("builds the STK password exactly as the Daraja documentation example", () => {
    const passkey = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
    expect(stkPassword("174379", passkey, "20160216165627")).toBe(
      "MTc0Mzc5YmZiMjc5ZjlhYTliZGJjZjE1OGU5N2RkNzFhNDY3Y2QyZTBjODkzMDU5YjEwZjc4ZTZiNzJhZGExZWQyYzkxOTIwMTYwMjE2MTY1NjI3",
    );
  });

  it("accepts only Kenyan mobile numbers that can receive a prompt", () => {
    expect(toMsisdn("0712 345 678")).toBe("254712345678");
    expect(toMsisdn("+254 110 123 456")).toBe("254110123456");
    expect(toMsisdn("712345678")).toBe("254712345678");
    expect(toMsisdn("020 123 4567")).toBeNull();
    expect(toMsisdn("+44 20 7946 0000")).toBeNull();
    expect(maskMsisdn("254712345678")).toBe("254712***678");
  });

  it("enforces whole-shilling amounts within the M-Pesa limit and short references", () => {
    expect(stkAmountProblem(1)).toBeNull();
    expect(stkAmountProblem(250_000)).toBeNull();
    expect(stkAmountProblem(0)).toMatch(/at least/);
    expect(stkAmountProblem(10.5)).toMatch(/whole shillings/);
    expect(stkAmountProblem(250_001)).toMatch(/limits/);
    expect(stkReference("A000123")).toBe("A000123");
    expect(stkReference("ACC/2026 — long reference")).toHaveLength(12);
    expect(stkReference("***")).toBe("PAYMENT");
  });

  it("maps result codes to outcomes and plain messages", () => {
    expect(stkOutcome(0)).toBe("SUCCESS");
    expect(stkOutcome("1032")).toBe("CANCELLED");
    expect(stkOutcome(1037)).toBe("EXPIRED");
    expect(stkOutcome("1019")).toBe("EXPIRED");
    expect(stkOutcome(1)).toBe("FAILED");
    expect(stkOutcome("2001")).toBe("FAILED");
    expect(stkMessage(2001)).toMatch(/PIN/);
    expect(stkMessage(9999, "Something odd")).toBe("Something odd");
  });
});

describe("callback payloads", () => {
  const success = {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 1.0 },
            { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
            { Name: "TransactionDate", Value: 20191219102115 },
            { Name: "PhoneNumber", Value: 254708374149 },
          ],
        },
      },
    },
  };

  it("parses the documented STK success callback", () => {
    const cb = stkCallbackSchema.parse(success).Body.stkCallback;
    expect(stkSuccessDetails(cb)).toEqual({ amount: 1, receipt: "NLJ7RT61SV", transactionDate: new Date("2019-12-19T07:21:15.000Z"), phone: "254708374149" });
  });

  it("parses a failure callback without metadata and rejects malformed shapes", () => {
    const cb = stkCallbackSchema.parse({ Body: { stkCallback: { MerchantRequestID: "a", CheckoutRequestID: "b", ResultCode: 1032, ResultDesc: "Request cancelled by user" } } }).Body.stkCallback;
    expect(stkSuccessDetails(cb)).toBeNull();
    expect(stkCallbackSchema.safeParse({ Body: {} }).success).toBe(false);
    const noReceipt = structuredClone(success);
    noReceipt.Body.stkCallback.CallbackMetadata.Item = noReceipt.Body.stkCallback.CallbackMetadata.Item.filter((i) => i.Name !== "MpesaReceiptNumber");
    expect(stkSuccessDetails(stkCallbackSchema.parse(noReceipt).Body.stkCallback)).toBeNull();
  });

  it("parses the documented C2B confirmation and normalises account references", () => {
    const c = c2bConfirmationSchema.parse({
      TransactionType: "Pay Bill",
      TransID: "RKTQDM7W6S",
      TransTime: "20191122063845",
      TransAmount: "10",
      BusinessShortCode: "600638",
      BillRefNumber: "a000 123",
      InvoiceNumber: "",
      OrgAccountBalance: "49197.00",
      ThirdPartyTransID: "",
      MSISDN: "2547 ***** 126",
      FirstName: "John",
    });
    expect(c.TransID).toBe("RKTQDM7W6S");
    expect(normaliseBillRef(c.BillRefNumber)).toBe("A000123");
    expect(c2bConfirmationSchema.safeParse({ TransID: "short", TransTime: "1", TransAmount: "1", BusinessShortCode: "1" }).success).toBe(false);
  });
});

describe("callback source allowlist and environment guards", () => {
  afterEach(() => {
    delete process.env.MPESA_CALLBACK_ALLOWED_IPS;
  });

  it("allows everything when unset, otherwise only listed addresses and networks", () => {
    expect(callbackSourceAllowed(null)).toBe(true);
    process.env.MPESA_CALLBACK_ALLOWED_IPS = "196.201.214.0/24, 196.201.213.114";
    expect(callbackSourceAllowed("196.201.214.200")).toBe(true);
    expect(callbackSourceAllowed("196.201.213.114")).toBe(true);
    expect(callbackSourceAllowed("41.90.1.1")).toBe(false);
    expect(callbackSourceAllowed(null)).toBe(false);
    expect(callbackSourceAllowed("not-an-ip")).toBe(false);
  });

  it("forbids test overrides and disabled verification in production", () => {
    const prod = {
      APP_ENV: "production",
      APP_URL: "https://isp.example.co.ke",
      DATABASE_URL: "postgresql://u:p@db:5432/cloudlink",
      AUTH_SECRET: "a-very-long-random-production-secret-0123456789",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      PAYMENT_ADAPTER: "daraja",
      NETWORK_ADAPTER: "disabled",
      MESSAGING_ADAPTER: "smtp",
    };
    expect(parseEnv(prod).PAYMENT_ADAPTER).toBe("daraja");
    expect(() => parseEnv({ ...prod, MPESA_BASE_URL: "http://127.0.0.1:9999" })).toThrow(/MPESA_BASE_URL/);
    expect(() => parseEnv({ ...prod, MPESA_VERIFY_CALLBACKS: "false" })).toThrow(/MPESA_VERIFY_CALLBACKS/);
    expect(() => parseEnv({ ...prod, MPESA_CALLBACK_URL: "http://isp.example.co.ke" })).toThrow(/MPESA_CALLBACK_URL/);
  });
});
