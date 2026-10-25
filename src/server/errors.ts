/**
 * Application errors with stable codes. Messages are safe to show to clients;
 * internal details go to `cause`/`details` and are only logged (redacted).
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE"
  | "INTEGRATION_UNAVAILABLE"
  | "INTEGRATION_ERROR"
  | "BAD_ORIGIN"
  | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE: 409,
  INTEGRATION_UNAVAILABLE: 503,
  INTEGRATION_ERROR: 502,
  BAD_ORIGIN: 403,
  INTERNAL_ERROR: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "The request could not be processed.",
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested record was not found.",
  CONFLICT: "The request conflicts with the current state of the record.",
  RATE_LIMITED: "Too many requests. Please wait and try again.",
  IDEMPOTENCY_CONFLICT: "This idempotency key was already used with a different request.",
  INVALID_STATE: "This action is not allowed in the current state.",
  INTEGRATION_UNAVAILABLE: "The integration is not available.",
  INTEGRATION_ERROR: "The external provider returned an error.",
  BAD_ORIGIN: "The request origin is not allowed.",
  INTERNAL_ERROR: "An unexpected error occurred.",
};

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: FieldIssue[];
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: { fields?: FieldIssue[]; details?: Record<string, unknown>; cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message ?? DEFAULT_MESSAGE[code], { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.fields = opts.fields;
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export const notFound = (what = "record") => new AppError("NOT_FOUND", `The requested ${what} was not found.`);
export const forbidden = (message?: string) => new AppError("FORBIDDEN", message);
export const invalidState = (message: string) => new AppError("INVALID_STATE", message);
export const conflict = (message: string) => new AppError("CONFLICT", message);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; correlationId: string; fields?: FieldIssue[] };
}

export function toEnvelope(err: AppError, correlationId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      correlationId,
      ...(err.fields?.length ? { fields: err.fields } : {}),
    },
  };
}
