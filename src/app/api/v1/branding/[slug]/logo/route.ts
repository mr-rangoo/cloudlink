import { type NextRequest } from "next/server";
import { logoForSlug } from "@/server/services/branding";

/** Public: an organization's logo for its customer portal and hotspot pages. Image bytes only, sniffed on upload. */
export async function GET(_req: NextRequest, routeCtx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await routeCtx.params;
  const logo = await logoForSlug(slug).catch(() => null);
  if (!logo) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  return new Response(new Uint8Array(logo.data), {
    status: 200,
    headers: { "content-type": logo.contentType, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
  });
}
