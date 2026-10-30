import { publicRoute } from "@/server/api/handler";
import { signupInput, startSignup } from "@/server/services/signup";

/** Start a self-service sign-up: emails a confirmation link (same reply whether or not the email has an account). */
export const POST = publicRoute({ body: signupInput, checkOrigin: true }, async ({ body, meta }) => ({ data: await startSignup(body, meta), status: 202 }));
