import type { ApprovalMode } from "./env";

/**
 * The enforcement decision, as pure logic.
 *
 * Kept free of tokens, network, and database so the decision table can be
 * driven directly by tests. Everything that talks to the outside world lives
 * in `enforcement.ts` and calls into here.
 */

export type Decision = "allow" | "challenge" | "deny";

/**
 * Machine-readable reasons. These are written to the audit row and, for a
 * challenge, sent to the caller. They are stable identifiers, not prose.
 */
export type DecisionReason =
  | "safe_tool"
  | "fresh_authentication"
  | "blanket_mode_freshness_skipped"
  | "auth_time_stale"
  | "auth_time_missing"
  | "id_token_missing"
  | "id_token_invalid"
  | "subject_mismatch"
  | "token_invalid"
  | "unknown_tool"
  | "tool_disabled"
  | "registry_defect"
  | "mfa_required"
  | "amr_unprovable"
  | "audit_unavailable"
  | "registry_unavailable";

export type DecisionInput = {
  destructive: boolean;
  /** The tool's freshness window. Absent on safe tools. */
  maxAuthAgeSeconds?: number;
  /** `auth_time` from the verified ID token, seconds since epoch. */
  authTime?: number;
  /** Current time, seconds since epoch. Injected so tests are deterministic. */
  now: number;
  /** Tolerance for clock drift between this server and the provider. */
  clockSkewSeconds: number;
  /** Resolved server-side. Never supplied by a caller. */
  approvalMode: ApprovalMode;
};

export type DecisionOutput = {
  decision: Decision;
  reason: DecisionReason;
  authAgeSeconds?: number;
  maxAuthAgeSeconds?: number;
  /** The `max_age` to put on a step-up challenge, in seconds. */
  requiredMaxAge?: number;
};

/**
 * Decides whether a tool call may proceed.
 *
 * The order is deliberate:
 *
 * 1. Safe tools are allowed without reference to freshness, in either mode.
 *    A read-only tool must never produce a prompt — that is where approval
 *    fatigue starts.
 * 2. A destructive tool with no window is a registry defect and is denied.
 *    Treating a missing window as "no limit" is the exact hole this build
 *    closes, so it fails closed and loudly instead.
 * 3. Blanket mode skips the freshness check on destructive tools. This is the
 *    reproduction of the failure, not a feature.
 * 4. Step-up mode requires a provable, in-window `auth_time`.
 *
 * `iat` and `exp` are deliberately absent from this function. Both move when
 * a token is refreshed while no human is present, so neither can stand in for
 * human presence. Only `auth_time` survives the minting of a new token.
 */
export function decide(input: DecisionInput): DecisionOutput {
  if (!input.destructive) {
    return { decision: "allow", reason: "safe_tool" };
  }

  if (
    input.maxAuthAgeSeconds === undefined ||
    !Number.isFinite(input.maxAuthAgeSeconds) ||
    input.maxAuthAgeSeconds <= 0
  ) {
    // A destructive tool that declares no window cannot be checked. Allowing
    // it would mean "no limit"; that reading is the failure being fixed.
    return {
      decision: "deny",
      reason: "registry_defect",
      maxAuthAgeSeconds: input.maxAuthAgeSeconds,
    };
  }

  const authAgeSeconds =
    input.authTime === undefined ? undefined : input.now - input.authTime;

  if (input.approvalMode === "blanket") {
    // The hole, reproduced exactly: the freshness check is skipped and the
    // destructive call proceeds. The age is still measured and audited, so
    // the trail shows precisely what was let through.
    return {
      decision: "allow",
      reason: "blanket_mode_freshness_skipped",
      authAgeSeconds,
      maxAuthAgeSeconds: input.maxAuthAgeSeconds,
    };
  }

  if (input.authTime === undefined) {
    // Freshness that cannot be proved is not freshness.
    return {
      decision: "challenge",
      reason: "auth_time_missing",
      maxAuthAgeSeconds: input.maxAuthAgeSeconds,
      requiredMaxAge: input.maxAuthAgeSeconds,
    };
  }

  // Clock skew widens the window, never narrows it: a provider clock slightly
  // ahead of ours must not turn a genuinely fresh authentication into a
  // challenge. A negative age (auth_time in the future beyond skew) is
  // rejected upstream during token verification.
  const withinWindow =
    authAgeSeconds! <= input.maxAuthAgeSeconds + input.clockSkewSeconds;

  return withinWindow
    ? {
        decision: "allow",
        reason: "fresh_authentication",
        authAgeSeconds,
        maxAuthAgeSeconds: input.maxAuthAgeSeconds,
      }
    : {
        decision: "challenge",
        reason: "auth_time_stale",
        authAgeSeconds,
        maxAuthAgeSeconds: input.maxAuthAgeSeconds,
        requiredMaxAge: input.maxAuthAgeSeconds,
      };
}

/**
 * Builds the `WWW-Authenticate` value for a step-up challenge.
 *
 * RFC 9470 shape: the `insufficient_user_authentication` error on a Bearer
 * challenge, carrying the `max_age` the resource server needs satisfied.
 *
 * `acr_values` is deliberately not sent. The tenant has no MFA enabled, so no
 * `amr` or `acr` appears on either token, and demanding an authentication
 * context that cannot be proved would be a promise this build cannot keep.
 * Freshness proves when someone authenticated, not how.
 */
export function buildChallengeHeader(options: {
  requiredMaxAge: number;
  reason: DecisionReason;
  description: string;
}): string {
  // Quoted-string values may not contain a bare quote or backslash, and the
  // description is built from a reason code plus numbers, so stripping is
  // enough and there is nothing to escape back.
  const quoted = options.description.replace(/["\\]/g, "");
  const params = [
    `error="insufficient_user_authentication"`,
    `error_description="${quoted}"`,
    `max_age=${Math.max(0, Math.floor(options.requiredMaxAge))}`,
  ];
  return `Bearer ${params.join(", ")}`;
}
