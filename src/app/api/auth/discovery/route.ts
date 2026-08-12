import { NextResponse } from "next/server";
import { discover } from "@/lib/oidc";

export const dynamic = "force-dynamic";

/**
 * Reports what the provider advertises.
 *
 * Used to record, rather than assume, that the provider supports PKCE with
 * S256 and publishes the endpoints this build relies on.
 */
export async function GET() {
  try {
    const metadata = await discover();
    return NextResponse.json({
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      jwksUri: metadata.jwks_uri,
      endSessionEndpoint: metadata.end_session_endpoint,
      codeChallengeMethodsSupported: metadata.code_challenge_methods_supported,
      claimsSupported: metadata.claims_supported,
      scopesSupported: metadata.scopes_supported,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "discovery_failed",
        message: error instanceof Error ? error.message : "Discovery failed.",
      },
      { status: 502 },
    );
  }
}
