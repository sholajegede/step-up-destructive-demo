import { createHash, randomBytes } from "node:crypto";
import { authConfig } from "./env";

/**
 * A direct OIDC authorization-code + PKCE client.
 *
 * Written against the provider's endpoints rather than a wrapper SDK because
 * this build depends on three things a wrapper hides: the exact `max_age` and
 * `prompt` parameters that go out on the authorize request, the raw claims
 * that come back, and what a refresh does to `auth_time`.
 */

export type ProviderMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
  claims_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
};

let metadataCache: { url: string; value: ProviderMetadata } | null = null;

/** Fetches and caches the provider's discovery document. */
export async function discover(): Promise<ProviderMetadata> {
  const { issuerUrl } = authConfig();
  const url = `${issuerUrl}/.well-known/openid-configuration`;

  if (metadataCache !== null && metadataCache.url === url) {
    return metadataCache.value;
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Discovery failed: ${response.status} ${response.statusText} from ${url}`,
    );
  }
  const value = (await response.json()) as ProviderMetadata;

  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const) {
    if (typeof value[field] !== "string" || value[field] === "") {
      throw new Error(`Discovery document is missing ${field}.`);
    }
  }

  metadataCache = { url, value };
  return value;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** A PKCE verifier and its S256 challenge, plus state and nonce. */
export function createAuthorizationSecrets() {
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  return {
    codeVerifier,
    codeChallenge,
    state: base64url(randomBytes(24)),
    nonce: base64url(randomBytes(24)),
  };
}

export type AuthorizeOptions = {
  codeChallenge: string;
  state: string;
  nonce: string;
  /**
   * Maximum acceptable age, in seconds, of the human's authentication.
   *
   * `0` demands an interactive authentication right now. This is a request to
   * the provider, not proof of anything: whatever comes back is checked
   * server-side against `auth_time` before any destructive tool runs.
   */
  maxAge?: number;
  /** `login` asks the provider to re-prompt. A UX hint, never proof. */
  prompt?: "login" | "none" | "consent";
  /** Where to send the person after the callback completes. */
  returnTo?: string;
  loginHint?: string;
};

/** Builds the authorize URL. */
export async function buildAuthorizationUrl(
  options: AuthorizeOptions,
): Promise<string> {
  const config = authConfig();
  const metadata = await discover();

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (config.audience !== "") {
    url.searchParams.set("audience", config.audience);
  }
  if (options.maxAge !== undefined) {
    url.searchParams.set("max_age", String(options.maxAge));
  }
  if (options.prompt !== undefined) {
    url.searchParams.set("prompt", options.prompt);
  }
  if (options.loginHint !== undefined) {
    url.searchParams.set("login_hint", options.loginHint);
  }

  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
};

export class TokenEndpointError extends Error {
  readonly status: number;
  readonly errorCode: string;
  constructor(status: number, errorCode: string, description: string) {
    super(`Token endpoint returned ${errorCode}: ${description}`);
    this.name = "TokenEndpointError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function postToTokenEndpoint(
  body: URLSearchParams,
): Promise<TokenResponse> {
  const metadata = await discover();
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TokenEndpointError(
      response.status,
      "invalid_response",
      "Token endpoint did not return JSON.",
    );
  }

  if (!response.ok) {
    const asError = parsed as { error?: string; error_description?: string };
    throw new TokenEndpointError(
      response.status,
      asError.error ?? "unknown_error",
      asError.error_description ?? text.slice(0, 200),
    );
  }

  return parsed as TokenResponse;
}

/** Exchanges an authorization code for tokens, proving the PKCE verifier. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const config = authConfig();
  return await postToTokenEndpoint(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  );
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * A refresh is a machine-to-machine exchange. No human is present, so it must
 * not move `auth_time`. This build verifies that rather than assuming it.
 */
export async function refreshTokens(
  refreshToken: string,
): Promise<TokenResponse> {
  const config = authConfig();
  return await postToTokenEndpoint(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  );
}

/** Builds the provider's end-session URL, when it publishes one. */
export async function buildLogoutUrl(): Promise<string> {
  const config = authConfig();
  const metadata = await discover();
  if (metadata.end_session_endpoint === undefined) {
    return config.postLogoutRedirectUri;
  }
  const url = new URL(metadata.end_session_endpoint);
  url.searchParams.set("redirect", config.postLogoutRedirectUri);
  url.searchParams.set(
    "post_logout_redirect_uri",
    config.postLogoutRedirectUri,
  );
  url.searchParams.set("client_id", config.clientId);
  return url.toString();
}
