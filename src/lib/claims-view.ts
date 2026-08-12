import type { VerifiedClaims } from "./jwt";

/**
 * A safe, readable projection of a verified token.
 *
 * Only claims the build reasons about are included, and no token material is
 * ever carried through. `jti` is included because it identifies a token
 * without being usable as one.
 */
export type ClaimsView = {
  sub?: string;
  email?: string;
  /** Seconds since epoch of the last interactive authentication. */
  authTime?: number;
  authTimeIso?: string;
  /** Seconds since that authentication, as of now. */
  authAgeSeconds?: number;
  issuedAt?: number;
  issuedAtIso?: string;
  expiresAt?: number;
  expiresAtIso?: string;
  amr?: string[];
  acr?: string;
  jti?: string;
  audience?: string | string[];
  issuer?: string;
};

export function toClaimsView(claims: VerifiedClaims): ClaimsView {
  const now = Math.floor(Date.now() / 1000);
  const iso = (seconds?: number) =>
    seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();

  return {
    sub: claims.sub,
    email: claims.email,
    authTime: claims.auth_time,
    authTimeIso: iso(claims.auth_time),
    authAgeSeconds:
      claims.auth_time === undefined ? undefined : now - claims.auth_time,
    issuedAt: claims.iat,
    issuedAtIso: iso(claims.iat),
    expiresAt: claims.exp,
    expiresAtIso: iso(claims.exp),
    amr: claims.amr,
    acr: claims.acr,
    jti: claims.jti,
    audience: claims.aud,
    issuer: claims.iss,
  };
}
