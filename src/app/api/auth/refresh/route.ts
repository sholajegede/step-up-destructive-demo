import { NextResponse } from "next/server";
import { toClaimsView } from "@/lib/claims-view";
import {
  decodeWithoutVerification,
  verifyAccessToken,
  verifyIdToken,
} from "@/lib/jwt";
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

  /**
   * The "before" snapshot is decoded without re-verifying.
   *
   * This is deliberate and is the only place in the build that reads a token
   * unverified. The whole point of this route is to observe what a refresh
   * does once the stored ID token has expired, and re-verifying an expired
   * token throws — which would make exactly the case worth measuring
   * impossible to measure.
   *
   * It is safe here because the snapshot is a diagnostic baseline, never an
   * authorisation decision: these tokens were fully verified when they were
   * stored, and the "after" tokens below are fully verified before any of
   * this is reported. Nothing downstream trusts the "before" values.
   */
  const before = {
    accessToken: decodeWithoutVerification(session.accessToken),
    idToken:
      session.idToken === undefined
        ? null
        : decodeWithoutVerification(session.idToken),
  };
  const beforeView = {
    accessToken:
      before.accessToken === null ? undefined : toClaimsView(before.accessToken),
    idToken:
      before.idToken === null ? undefined : toClaimsView(before.idToken),
  };
  const now = Math.floor(Date.now() / 1000);
  const idTokenWasExpired =
    before.idToken?.exp !== undefined && before.idToken.exp < now;

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

  // Whether the provider minted anything new, decided on the token strings
  // themselves rather than on their claims.
  //
  // This separates two very different outcomes that look identical from the
  // claims alone: a provider that mints a fresh token carrying the original
  // auth_time (the behaviour the design needs), and a provider that simply
  // hands back the token it already issued (which says nothing either way).
  const accessTokenChanged = tokens.access_token !== session.accessToken;
  const idTokenChanged =
    tokens.id_token !== undefined && tokens.id_token !== session.idToken;

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
    // Freshness is carried by the ID token, so that is where it is read from.
    authTime: after.idToken?.authTime ?? session.authTime,
  });

  // `auth_time` lives on the ID token, not the access token, so the
  // comparison must be made there. Comparing access tokens would compare
  // undefined with undefined and report "unchanged" while proving nothing.
  const authTimeBefore = beforeView.idToken?.authTime;
  const authTimeAfter = after.idToken?.authTime;
  const idTokenReturned = tokens.id_token !== undefined;

  return NextResponse.json({
    before: beforeView,
    after,
    comparison: {
      authTimeBefore,
      authTimeAfter,
      authTimeMoved: idTokenChanged && authTimeBefore !== authTimeAfter,
      idTokenReturned,
      accessTokenChanged,
      idTokenChanged,
      /** Whether the stored ID token had already expired when this ran. */
      idTokenWasExpired,
      issuedAtMoved:
        beforeView.accessToken?.issuedAt !== after.accessToken.issuedAt,
      tokenIdMoved: beforeView.accessToken?.jti !== after.accessToken.jti,
      refreshTokenRotated: tokens.refresh_token !== undefined,
      /**
       * The finding in one line.
       *
       * A pass requires the provider to have actually minted a new ID token
       * and for that new token to carry the original `auth_time`. An
       * unchanged `auth_time` on an unchanged token is not evidence, and is
       * reported as inconclusive rather than dressed up as a pass.
       */
      verdict: !idTokenReturned
        ? "INCONCLUSIVE — the refresh returned no ID token, so there is no auth_time to compare"
        : !idTokenChanged
          ? "INCONCLUSIVE — the refresh returned the same ID token, so nothing was minted to compare"
          : authTimeBefore !== authTimeAfter
            ? "auth_time MOVED on refresh — it does not represent human presence"
            : "auth_time held steady across a newly minted ID token — it represents human presence",
    },
  });
}
