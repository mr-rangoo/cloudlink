import { publicRoute } from "@/server/api/handler";
import { completeStaffInvite, setPasswordInput } from "@/server/services/admin";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

/** Complete a staff setup or password-reset link. */
export const POST = publicRoute({ body: setPasswordInput, checkOrigin: true }, async ({ body, meta }) => {
  await consumeRateLimit(RATE_LIMITS.loginByIp, `invite:${meta.ipAddress ?? "unknown"}`);
  await completeStaffInvite(body, meta);
  return { data: { ok: true } };
});
