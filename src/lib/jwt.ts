import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { authConfig } from "./env";
import { discover } from "./oidc";

/**
 * Token verification.
 *
 * Every rule here is fail-closed: anything unverifiable, unexpected, or
 * missing is rejected rather than treated as absent-and-therefore-fine.
 */

/** The algorithm is pinned. `none` and every HMAC variant are refused. */
const ALLOWED_ALGORITHMS = ["RS256"];

/** Claims this build reasons about, beyond the registered set. */
export type VerifiedClaims = JWTPayload & {
  /**
   * Seconds since the epoch at which the human last authenticated
   * interactively. This is the claim the whole build turns on.
   */
  auth_time?: number;
  /** Authentication methods actually used, e.g. ["pwd", "mfa"]. */
  amr?: string[];
  /** Authentication context class, when the provider sends one. */
  acr?: string;
  email?: string;
  given_name?: string;
  family_name?: string;
};

export class TokenVerificationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "TokenVerificationError";
    this.reason = reason;
  }
}

/**
 * JWKS clients, one per key set URI.
 *
 * `createRemoteJWKSet` caches keys and re-fetches on an unknown `kid`, with
 * its own cooldown, so a key rotation is picked up without a restart and
 * without hammering the provider.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(uri: string) {
  let jwks = jwksCache.get(uri);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(uri), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

/**
 * Verifies a JWT against the provider's JWKS.
 *
 * Signature, issuer, audience, and expiry are all checked by `jwtVerify`. The
 * checks after it cover the claims this build depends on and the edge cases a
 * signature check alone would let through.
 */
export async function verifyToken(
  token: string,
  options: { audience?: string; requireAuthTime?: boolean },
): Promise<VerifiedClaims> {
  if (typeof token !== "string" || token.trim() === "") {
    throw new TokenVerificationError("token_missing", "No token presented.");
  }

  const metadata = await discover();

  let payload: VerifiedClaims;
  try {
    const result = await jwtVerify(token, jwksFor(metadata.jwks_uri), {
      algorithms: ALLOWED_ALGORITHMS,
      issuer: metadata.issuer,
      // Checked only when an audience is configured. Left unset, `jwtVerify`
      // skips the comparison rather than comparing against undefined.
      ...(options.audience !== undefined && options.audience !== ""
        ? { audience: options.audience }
        : {}),
      // A token whose clock is ahead of ours by more than this is rejected.
      clockTolerance: 5,
    });
    payload = result.payload as VerifiedClaims;

    // `jwtVerify` already refuses any algorithm outside the allow-list. This
    // re-reads the header so the pin is visible at the call site and survives
    // a future change to how the options are built.
    if (result.protectedHeader.alg !== "RS256") {
      throw new TokenVerificationError(
        "algorithm_not_allowed",
        `Token algorithm ${result.protectedHeader.alg} is not RS256.`,
      );
    }
  } catch (error) {
    if (error instanceof TokenVerificationError) throw error;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    throw new TokenVerificationError(
      mapJoseError(code),
      `Token verification failed (${code}).`,
    );
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new TokenVerificationError(
      "subject_missing",
      "Token carries no subject.",
    );
  }
  if (typeof payload.exp !== "number") {
    throw new TokenVerificationError(
      "expiry_missing",
      "Token carries no expiry. A token that never expires is refused.",
    );
  }
  if (typeof payload.iat !== "number") {
    throw new TokenVerificationError(
      "issued_at_missing",
      "Token carries no iat.",
    );
  }

  if (payload.auth_time !== undefined) {
    // A non-numeric, negative, or non-finite auth_time is a malformed claim,
    // not a missing one, and is refused outright rather than ignored.
    if (
      typeof payload.auth_time !== "number" ||
      !Number.isFinite(payload.auth_time) ||
      payload.auth_time <= 0
    ) {
      throw new TokenVerificationError(
        "auth_time_malformed",
        "Token carries a malformed auth_time claim.",
      );
    }
    // An auth_time in the future would make any freshness check trivially
    // pass. Allow only clock skew.
    const now = Math.floor(Date.now() / 1000);
    if (payload.auth_time > now + 60) {
      throw new TokenVerificationError(
        "auth_time_in_future",
        "Token auth_time is in the future.",
      );
    }
  } else if (options.requireAuthTime === true) {
    throw new TokenVerificationError(
      "auth_time_missing",
      "Token carries no auth_time. Freshness cannot be proved, so the call is refused.",
    );
  }

  return payload;
}

function mapJoseError(code: string): string {
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "token_expired";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return "claim_validation_failed";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "signature_invalid";
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "no_matching_key";
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return "algorithm_not_allowed";
    default:
      return "token_invalid";
  }
}

/** Verifies an ID token. Its audience is always the client id. */
export async function verifyIdToken(
  idToken: string,
  options: { nonce?: string } = {},
): Promise<VerifiedClaims> {
  const config = authConfig();
  const claims = await verifyToken(idToken, { audience: config.clientId });

  if (options.nonce !== undefined) {
    if (claims.nonce !== options.nonce) {
      throw new TokenVerificationError(
        "nonce_mismatch",
        "ID token nonce does not match the nonce sent on the authorize request.",
      );
    }
  }

  return claims;
}

/**
 * Verifies an access token.
 *
 * The audience is checked against the registered API audience when one is
 * configured. `requireAuthTime` is passed through by the enforcement seam so
 * a destructive call refuses a token that carries no `auth_time` at all.
 */
export async function verifyAccessToken(
  accessToken: string,
  options: { requireAuthTime?: boolean } = {},
): Promise<VerifiedClaims> {
  const config = authConfig();
  return await verifyToken(accessToken, {
    audience: config.audience === "" ? undefined : config.audience,
    requireAuthTime: options.requireAuthTime,
  });
}

/**
 * Reads a JWT's claims without verifying it.
 *
 * For display and diagnostics only. Never call this on the enforcement path —
 * it proves nothing.
 */
export function decodeWithoutVerification(token: string): VerifiedClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as VerifiedClaims;
  } catch {
    return null;
  }
}
