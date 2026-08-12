import { NextResponse, type NextRequest } from "next/server";
import { appConfig } from "@/lib/env";
import { verifyIdToken } from "@/lib/jwt";
import { exchangeCodeForTokens } from "@/lib/oidc";
import { consumeTransaction, saveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Completes the login.
 *
 * Order matters. The transaction cookie is consumed first and compared to the
 * returned `state` before the code is spent, so a replayed or forged callback
 * is rejected without touching the token endpoint. The ID token is then
 * verified against the JWKS with RS256 pinned and the nonce checked.
 */
export async function GET(request: NextRequest) {
  const { siteUrl } = appConfig();
  const params = request.nextUrl.searchParams;

  const providerError = params.get("error");
  if (providerError !== null) {
    return failure(
      siteUrl,
      providerError,
      params.get("error_description") ?? "The provider refused the request.",
    );
  }

  const transaction = await consumeTransaction();
  if (transaction === null) {
    return failure(
      siteUrl,
      "no_transaction",
      "No in-flight login was found. Start the sign-in again.",
    );
  }

  const state = params.get("state");
  if (state === null || state !== transaction.state) {
    return failure(
      siteUrl,
      "state_mismatch",
      "The state returned does not match the state sent.",
    );
  }

  const code = params.get("code");
  if (code === null || code === "") {
    return failure(siteUrl, "code_missing", "No authorization code returned.");
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, transaction.codeVerifier);
  } catch (error) {
    return failure(
      siteUrl,
      "token_exchange_failed",
      error instanceof Error ? error.message : "Token exchange failed.",
    );
  }

  if (tokens.id_token === undefined) {
    return failure(
      siteUrl,
      "id_token_missing",
      "The token response carried no ID token.",
    );
  }

  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token, { nonce: transaction.nonce });
  } catch (error) {
    return failure(
      siteUrl,
      "id_token_invalid",
      error instanceof Error ? error.message : "ID token verification failed.",
    );
  }

  await saveSession({
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresAt:
      tokens.expires_in === undefined
        ? undefined
        : Math.floor(Date.now() / 1000) + tokens.expires_in,
    subject: claims.sub!,
    authTime: claims.auth_time,
  });

  return NextResponse.redirect(new URL(transaction.returnTo, siteUrl));
}

/**
 * Sends the person back with a readable reason.
 *
 * The reason is a short code plus a description of what went wrong in the
 * protocol. No token, code, or verifier is ever put in a URL.
 */
function failure(siteUrl: string, code: string, description: string) {
  const url = new URL("/auth-probe", siteUrl);
  url.searchParams.set("auth_error", code);
  url.searchParams.set("auth_error_description", description.slice(0, 300));
  return NextResponse.redirect(url);
}
