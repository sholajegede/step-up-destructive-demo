/**
 * Server-side environment configuration.
 *
 * Nothing in this module may be imported into a client component. Every value
 * here is read from the deploy environment at request time. No identifiers,
 * endpoints, model ids, or policy switches are hardcoded.
 */

export type ApprovalMode = "blanket" | "step-up";

class MissingEnvError extends Error {
  constructor(name: string) {
    super(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
    this.name = "MissingEnvError";
  }
}

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "src/lib/env.ts was imported into client code. Server configuration " +
        "must never reach the browser.",
    );
  }
}

function required(name: string): string {
  assertServer();
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new MissingEnvError(name);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  assertServer();
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}

function optionalNumber(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Environment variable ${name} must be a non-negative number, got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * The approval mode is decided by the deploy environment and by nothing else.
 *
 * It is deliberately NOT prefixed with NEXT_PUBLIC_, is never accepted from a
 * request header, query string, cookie, or tool argument, and is never echoed
 * back to a caller in a form that a caller could replay. The agent cannot set
 * it. The browser cannot set it.
 *
 * Resolution is fail-safe: only the exact string "blanket" selects the
 * permissive mode. Anything else — a typo, an empty string, an unset
 * variable, a hostile value — resolves to "step-up".
 */
export function approvalMode(): ApprovalMode {
  assertServer();
  const raw = process.env.APPROVAL_MODE;
  if (typeof raw !== "string") {
    return "step-up";
  }
  return raw.trim().toLowerCase() === "blanket" ? "blanket" : "step-up";
}

/** OIDC / identity provider configuration. */
export function authConfig() {
  assertServer();
  return {
    /** Issuer origin, e.g. https://<tenant>.kinde.com — no trailing slash. */
    issuerUrl: required("KINDE_ISSUER_URL").replace(/\/+$/, ""),
    clientId: required("KINDE_CLIENT_ID"),
    clientSecret: required("KINDE_CLIENT_SECRET"),
    redirectUri: required("KINDE_REDIRECT_URI"),
    postLogoutRedirectUri: optional(
      "KINDE_POST_LOGOUT_REDIRECT_URI",
      appConfig().siteUrl,
    ),
    /** Resource server audience for the demo API. */
    audience: optional("KINDE_AUDIENCE", ""),
    scopes: optional("KINDE_SCOPES", "openid profile email offline"),
  };
}

/** Anthropic configuration. The model id is never hardcoded. */
export function anthropicConfig() {
  assertServer();
  return {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: required("ANTHROPIC_MODEL"),
    maxTokens: optionalNumber("ANTHROPIC_MAX_TOKENS", 4096),
  };
}

/** General application configuration. */
export function appConfig() {
  assertServer();
  return {
    siteUrl: optional("APP_SITE_URL", "http://localhost:3000").replace(
      /\/+$/,
      "",
    ),
    /**
     * Default freshness window applied to a destructive tool that does not
     * declare its own. Per-tool windows always win.
     */
    defaultMaxAuthAgeSeconds: optionalNumber("DEFAULT_MAX_AUTH_AGE_SECONDS", 300),
    /** Tolerance for clock skew when comparing auth_time against now. */
    clockSkewSeconds: optionalNumber("CLOCK_SKEW_SECONDS", 30),
  };
}

/** Convex deployment URL, safe to expose to the browser. */
export function convexUrl(): string {
  return required("NEXT_PUBLIC_CONVEX_URL");
}

/**
 * Reports which configuration groups are present without revealing any value.
 * Used by the health route.
 */
export function configPresence(): Record<string, boolean> {
  assertServer();
  const has = (name: string) => {
    const v = process.env[name];
    return typeof v === "string" && v.trim() !== "";
  };
  return {
    kinde:
      has("KINDE_ISSUER_URL") &&
      has("KINDE_CLIENT_ID") &&
      has("KINDE_CLIENT_SECRET") &&
      has("KINDE_REDIRECT_URI"),
    anthropic: has("ANTHROPIC_API_KEY") && has("ANTHROPIC_MODEL"),
    convex: has("NEXT_PUBLIC_CONVEX_URL"),
  };
}
