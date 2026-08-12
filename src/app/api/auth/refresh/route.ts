import { NextResponse } from "next/server";
import { toClaimsView } from "@/lib/claims-view";
import { verifyAccessToken, verifyIdToken } from "@/lib/jwt";
import { refreshTokens } from "@/lib/oidc";
import { readSession, saveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Exchanges the refresh token for a new access token, and reports what moved.
 *
 * This route exists to be run against the live provider, because the whole
 * design rests on one claim about its behaviour: a refresh is a
 * machine-to-machine exchange with no human present, so it must issue a new
 * token — new `iat`, new `exp`, new `jti` — while leaving `auth_time` exactly
 * where it was.
 *
 * If `auth_time` moved here, `auth_time` would be a proxy for "a token was
 * minted recently" rather than "a person authenticated recently", and every
 * freshness check in this build would be satisfiable by an agent holding a
 * refresh token and no human at all. So the comparison is returned rather
 * than assumed.
 */
export async function POST() {
  const session = await readSession();
  if (session === null) {
    return NextResponse.json(
      { error: "not_signed_in", message: "No session. Sign in first." },
      { status: 401 },
    );
  }
  if (session.refreshToken === undefined) {
    return NextResponse.json(
      {
        error: "no_refresh_token",
        message:
          "This session carries no refresh token. Add the `offline` scope and sign in again.",
      },
      { status: 400 },
    );
  }

  const before = {
    accessToken: toClaimsView(await verifyAccessToken(session.accessToken)),
    idToken:
      session.idToken === undefined
        ? undefined
        : toClaimsView(await verifyIdToken(session.idToken)),
  };

  let tokens;
  try {
    tokens = await refreshTokens(session.refreshToken);
  } catch (error) {
    return NextResponse.json(
      {
        error: "refresh_failed",
        message: error instanceof Error ? error.message : "Refresh failed.",
      },
      { status: 502 },
    );
  }

  const after = {
    accessToken: toClaimsView(await verifyAccessToken(tokens.access_token)),
    idToken:
      tokens.id_token === undefined
        ? undefined
        : toClaimsView(await verifyIdToken(tokens.id_token)),
  };

  await saveSession({
    accessToken: tokens.access_token,
    idToken: tokens.id_token ?? session.idToken,
    // Providers that rotate refresh tokens send a new one; keep the old one
    // only when they do not.
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt:
      tokens.expires_in === undefined
        ? undefined
        : Math.floor(Date.now() / 1000) + tokens.expires_in,
    subject: after.accessToken.sub ?? session.subject,
    authTime: after.accessToken.authTime ?? session.authTime,
  });

  const authTimeMoved =
    before.accessToken.authTime !== after.accessToken.authTime;

  return NextResponse.json({
    before,
    after,
    comparison: {
      authTimeBefore: before.accessToken.authTime,
      authTimeAfter: after.accessToken.authTime,
      authTimeMoved,
      issuedAtMoved: before.accessToken.issuedAt !== after.accessToken.issuedAt,
      tokenIdMoved: before.accessToken.jti !== after.accessToken.jti,
      refreshTokenRotated: tokens.refresh_token !== undefined,
      /**
       * The finding in one line. `auth_time` must not move on a refresh; if
       * it does, freshness cannot be built on it.
       */
      verdict: authTimeMoved
        ? "auth_time MOVED on refresh — it does not represent human presence"
        : "auth_time held steady on refresh — it represents human presence",
    },
  });
}
