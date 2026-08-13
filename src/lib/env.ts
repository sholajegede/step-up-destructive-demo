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

/**
 * Secret used to encrypt the session cookie.
 *
 * Must be long enough to carry real entropy. It is hashed to a 256-bit key
 * before use, so the raw value never becomes the key directly.
 */
export function sessionSecret(): string {
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error(
      "SESSION_SECRET must be at least 32 characters. Generate one with " +
        "`openssl rand -base64 32`.",
    );
  }
  return secret;
}

/** Anthropic configuration. The model id is never hardcoded. */
export function anthropicConfig() {
  assertServer();
  return {
    apiKey: required("ANTHROPIC_API_KEY"),
    /**
     * The model id. Deliberately `required()` rather than defaulted, so a
     * model identifier can never drift into the source.
     */
    model: required("ANTHROPIC_MODEL"),
    /**
     * On models where thinking is on by default this caps thinking plus
     * response text together, so it is set well above what the replies need.
     */
    maxTokens: optionalNumber("ANTHROPIC_MAX_TOKENS", 16000),
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

/** Durability settings for the audit trail. */
export function auditConfig() {
  assertServer();
  return {
    /** Attempts against the audit store before falling back to the spool. */
    writeAttempts: optionalNumber("AUDIT_WRITE_ATTEMPTS", 3),
    retryBaseMs: optionalNumber("AUDIT_RETRY_BASE_MS", 120),
    /** Append-only local fallback. Never committed. */
    spoolFile: optional("AUDIT_SPOOL_FILE", ".audit-spool.jsonl"),
  };
}

/**
 * Authentication methods that a destructive release must evidence.
 *
 * Empty by default, and empty is the honest setting on this provider: Kinde
 * does not emit `amr` or `acr` on either token, so there is nothing to check
 * against. Setting it would refuse every destructive call — which is the
 * correct fail-closed behaviour for "you asked me to prove something I cannot
 * observe", but it is not a control that can be satisfied here.
 *
 * The check exists so that a provider which does emit `amr` can be asserted
 * against by configuration alone, with no code change and no pretending.
 */
export function requiredAuthMethods(): string[] {
  assertServer();
  return optional("STEP_UP_REQUIRED_AMR", "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "");
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
    session: has("SESSION_SECRET"),
  };
}
