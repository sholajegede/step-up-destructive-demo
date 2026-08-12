import { NextResponse, type NextRequest } from "next/server";
import { parseMaxAge, parsePrompt, safeReturnTo } from "@/lib/auth-params";
import { buildAuthorizationUrl, createAuthorizationSecrets } from "@/lib/oidc";
import { saveTransaction } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Starts an authorization-code + PKCE login.
 *
 * Query parameters:
 * - `max_age`  seconds; `0` demands an interactive authentication now.
 * - `prompt`   `login` asks the provider to re-prompt.
 * - `returnTo` where to land after the callback. Same-origin paths only.
 *
 * These are hints carried to the provider. They are not proof of anything.
 * Whatever comes back is verified server-side, and every destructive call
 * re-reads `auth_time` from the verified token before it runs. A caller who
 * asks for `max_age=0` and then skips the actual re-authentication gains
 * nothing by having asked.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const secrets = createAuthorizationSecrets();
  const maxAge = parseMaxAge(params.get("max_age"));

  await saveTransaction({
    codeVerifier: secrets.codeVerifier,
    state: secrets.state,
    nonce: secrets.nonce,
    returnTo: safeReturnTo(params.get("returnTo")),
    maxAge,
    stepUp: params.get("stepUp") === "1",
  });

  const url = await buildAuthorizationUrl({
    codeChallenge: secrets.codeChallenge,
    state: secrets.state,
    nonce: secrets.nonce,
    maxAge,
    prompt: parsePrompt(params.get("prompt")),
  });

  return NextResponse.redirect(url);
}
