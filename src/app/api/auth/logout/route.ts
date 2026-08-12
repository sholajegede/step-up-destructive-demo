import { NextResponse } from "next/server";
import { buildLogoutUrl } from "@/lib/oidc";
import { clearSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Clears the local session, then hands off to the provider's end-session
 * endpoint so the provider's own session goes too. Clearing only the local
 * cookie would leave the provider willing to sign the person straight back in
 * without a prompt, which would make a re-authentication test meaningless.
 */
export async function GET() {
  await clearSession();
  return NextResponse.redirect(await buildLogoutUrl());
}
