import { customerRoute } from "@/server/api/handler";
import { AppError } from "@/server/errors";
import { listCustomerPayments } from "@/server/portal/services";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: await listCustomerPayments(ctx) }));

/** Online payment initiation (M-Pesa STK Push) is not available until the payments integration is enabled. */
export const POST = customerRoute({}, async () => {
  throw new AppError("INTEGRATION_UNAVAILABLE", "Online payment is not available yet. Please pay using the account number shown on your invoice.");
});
