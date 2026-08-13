import { randomUUID } from "node:crypto";
import { api } from "../../convex/_generated/api";
import { convex } from "./convex-server";
import {
  buildChallengeHeader,
  decide,
  type Decision,
  type DecisionReason,
} from "./decision";
import {
  appConfig,
  approvalMode,
  requiredAuthMethods,
  type ApprovalMode,
} from "./env";
import { writeAuditRow } from "./audit-sink";
import { TokenVerificationError, verifyAccessToken, verifyIdToken } from "./jwt";

/**
 * The enforcement seam.
 *
 * Every agent tool call passes through `enforceToolCall`. There is exactly one
 * of these, and it is the only place a destructive action can be released.
 *
 * The shape of the check, in order:
 *
 *   verify access token  ->  destructive?  ->  auth_time within window?
 *                                          ->  allow / challenge / deny
 *
 * Two separate tokens do two separate jobs. The access token answers "who is
 * this and may they call this API at all" — it is the credential presented at
 * the boundary. The ID token answers "when did a human last authenticate" —
 * it is the only token carrying `auth_time` on this provider. The seam
 * requires both for a destructive call and binds them by subject, so an ID
 * token from one session can never vouch for an access token from another.
 */

export type EnforcementContext = {
  toolName: string;
  accessToken?: string;
  idToken?: string;
  /** Ties challenge -> re-auth -> release into one story. */
  correlationId?: string;
  recordRef?: string;
};

export type EnforcementResult = {
  decision: Decision;
  reason: DecisionReason;
  correlationId: string;
  approvalMode: ApprovalMode;
  /** Present once the access token verified. */
  subject?: string;
  destructive: boolean;
  authTime?: number;
  authAgeSeconds?: number;
  maxAuthAgeSeconds?: number;
  /** Authentication methods from the ID token, when the provider sends them. */
  amr?: string[];
  /** Where the audit row for this decision landed. */
  auditDurability?: "recorded" | "spooled" | "lost";
  /** Set on a challenge. The RFC 9470 `WWW-Authenticate` value. */
  challengeHeader?: string;
  /** Human-readable explanation. Safe to show a caller. */
  message: string;
};

export function newCorrelationId(): string {
  return randomUUID();
}

/** Prose for each reason. Kept beside the codes so they cannot drift apart. */
const MESSAGES: Record<DecisionReason, string> = {
  safe_tool: "Read-only tool. No fresh authentication is required.",
  fresh_authentication:
    "A human authenticated recently enough for this action.",
  blanket_mode_freshness_skipped:
    "Blanket approval mode is on, so the freshness check was skipped for this destructive tool.",
  auth_time_stale:
    "The last human authentication is older than this action allows. Re-authenticate to continue.",
  auth_time_missing:
    "The token carries no auth_time, so freshness cannot be proved. Re-authenticate to continue.",
  id_token_missing:
    "No ID token was presented, so freshness cannot be proved. Re-authenticate to continue.",
  id_token_invalid:
    "The ID token did not verify, so freshness cannot be proved. Re-authenticate to continue.",
  subject_mismatch:
    "The ID token and the access token describe different people. Refused.",
  token_invalid: "The access token did not verify.",
  unknown_tool: "No such tool is registered.",
  tool_disabled: "This tool is registered but disabled.",
  registry_defect:
    "This destructive tool declares no freshness window. Refused rather than treated as unlimited.",
  mfa_required:
    "This action requires a stronger authentication method than the one used.",
  amr_unprovable:
    "The token carries no record of how the person authenticated, so the required method cannot be proved.",
  audit_unavailable:
    "The decision could not be recorded, so it was refused. An action that cannot be audited must not run.",
  registry_unavailable:
    "The tool registry could not be read, so the policy for this tool is unknown and the call was refused.",
};

/**
 * Runs the seam and writes exactly one audit row.
 *
 * Every path through this function — allow, challenge, deny, and every error
 * — ends in an audit row carrying the correlationId. There is no early return
 * that skips the trail.
 */
export async function enforceToolCall(
  context: EnforcementContext,
): Promise<EnforcementResult> {
  const correlationId = context.correlationId ?? newCorrelationId();
  const mode = approvalMode();
  const { clockSkewSeconds } = appConfig();

  // Filled in as far as each step gets, so the audit row stays as informative
  // as the point of failure allows.
  const observed: {
    subject?: string;
    destructive: boolean;
    maxAuthAgeSeconds?: number;
    authTime?: number;
    amr?: string[];
    tokenId?: string;
  } = { destructive: false };

  const finish = async (
    decision: Decision,
    reason: DecisionReason,
    extra: { authAgeSeconds?: number; requiredMaxAge?: number } = {},
  ): Promise<EnforcementResult> => {
    // The row is written before the answer is returned, and the outcome of
    // that write can change the answer: an action that cannot be recorded at
    // all must not run. A refusal is downgraded rather than upgraded — the
    // audit outcome can only ever make the decision stricter.
    let effectiveDecision = decision;
    let effectiveReason = reason;

    const written = await writeAuditRow({
      correlationId,
      userId: observed.subject ?? "unknown",
      toolName: context.toolName,
      destructive: observed.destructive,
      decision,
      reason,
      approvalMode: mode,
      authTime: observed.authTime,
      authAgeSeconds: extra.authAgeSeconds,
      maxAuthAgeSeconds: observed.maxAuthAgeSeconds,
      amr: observed.amr,
      tokenId: observed.tokenId,
      recordRef: context.recordRef,
    });

    if (written.durability === "lost" && decision === "allow") {
      // Neither the store nor the spool took it. Allowing now would mean an
      // action ran with no evidence anywhere that it was permitted.
      effectiveDecision = "deny";
      effectiveReason = "audit_unavailable";
      await writeAuditRow({
        correlationId,
        userId: observed.subject ?? "unknown",
        toolName: context.toolName,
        destructive: observed.destructive,
        decision: "deny",
        reason: "audit_unavailable",
        approvalMode: mode,
        tokenId: observed.tokenId,
        recordRef: context.recordRef,
      }).catch(() => undefined);
    }

    return {
      decision: effectiveDecision,
      reason: effectiveReason,
      auditDurability: written.durability,
      correlationId,
      approvalMode: mode,
      subject: observed.subject,
      destructive: observed.destructive,
      authTime: observed.authTime,
      authAgeSeconds: extra.authAgeSeconds,
      maxAuthAgeSeconds: observed.maxAuthAgeSeconds,
      amr: observed.amr,
      message: MESSAGES[effectiveReason],
      challengeHeader:
        effectiveDecision === "challenge" && extra.requiredMaxAge !== undefined
          ? buildChallengeHeader({
              requiredMaxAge: extra.requiredMaxAge,
              reason: effectiveReason,
              description: MESSAGES[effectiveReason],
            })
          : undefined,
    };
  };

  // 1. Authorisation. The access token establishes identity.
  if (context.accessToken === undefined || context.accessToken === "") {
    return await finish("deny", "token_invalid");
  }
  let accessClaims;
  try {
    accessClaims = await verifyAccessToken(context.accessToken);
  } catch (error) {
    if (error instanceof TokenVerificationError) {
      return await finish("deny", "token_invalid");
    }
    throw error;
  }
  observed.subject = accessClaims.sub;
  observed.tokenId = accessClaims.jti;

  // 2. Registry lookup. An unregistered name has no policy, so it is refused.
  //
  //    A registry that cannot be read is refused for the same reason: without
  //    it there is no way to know whether this tool is destructive or what
  //    window it carries, and guessing in either direction is worse than
  //    stopping. The refusal still writes an audit row — through the spool if
  //    the store is what is down — so the outage leaves a record instead of a
  //    hole.
  let tool;
  try {
    tool = await convex().query(api.tools.getByName, {
      name: context.toolName,
    });
  } catch {
    return await finish("deny", "registry_unavailable");
  }
  if (tool === null) {
    return await finish("deny", "unknown_tool");
  }
  observed.destructive = tool.destructive;
  observed.maxAuthAgeSeconds = tool.maxAuthAgeSeconds;
  if (!tool.enabled) {
    return await finish("deny", "tool_disabled");
  }

  // 3. Safe tools need nothing further, in either mode.
  if (!tool.destructive) {
    return await finish("allow", "safe_tool");
  }

  // 4. Destructive. Freshness is read from the ID token, never the access
  //    token — on this provider `auth_time` appears only there.
  //
  //    In blanket mode the ID token is still read when present, so the audit
  //    row records how stale the authentication actually was at the moment
  //    the call was let through.
  if (context.idToken !== undefined && context.idToken !== "") {
    try {
      const idClaims = await verifyIdToken(context.idToken);

      // Binding. Without this, an ID token from any session of any person
      // could vouch for freshness on someone else's access token.
      if (idClaims.sub !== accessClaims.sub) {
        return await finish("deny", "subject_mismatch");
      }

      observed.authTime = idClaims.auth_time;
      observed.amr = idClaims.amr;
    } catch (error) {
      if (!(error instanceof TokenVerificationError)) throw error;
      // An unverifiable ID token proves nothing — most often it has simply
      // expired, since the ID token lives an hour and the access token a day.
      // Reported distinctly from a genuinely absent claim so the audit trail
      // says which of the two actually happened.
      observed.authTime = undefined;
      if (mode === "step-up") {
        return await finish("challenge", "id_token_invalid", {
          requiredMaxAge: tool.maxAuthAgeSeconds,
        });
      }
    }
  } else if (mode === "step-up") {
    return await finish("challenge", "id_token_missing", {
      requiredMaxAge: tool.maxAuthAgeSeconds,
    });
  }

  const outcome = decide({
    destructive: true,
    maxAuthAgeSeconds: tool.maxAuthAgeSeconds,
    authTime: observed.authTime,
    now: Math.floor(Date.now() / 1000),
    clockSkewSeconds,
    approvalMode: mode,
  });

  // 5. Method, when the deployment demands one.
  //
  //    Only checked on a release, and only in step-up mode: it strengthens an
  //    allow, it never rescues a challenge. Configured empty by default —
  //    this provider emits no `amr`, so requiring one would refuse every
  //    destructive call. That refusal would be correct (a demand that cannot
  //    be evidenced must not be waved through) but it is not a control this
  //    tenant can satisfy, so it stays off rather than pretended.
  if (outcome.decision === "allow" && mode === "step-up") {
    const required = requiredAuthMethods();
    if (required.length > 0) {
      if (observed.amr === undefined || observed.amr.length === 0) {
        return await finish("challenge", "amr_unprovable", {
          authAgeSeconds: outcome.authAgeSeconds,
          requiredMaxAge: tool.maxAuthAgeSeconds,
        });
      }
      const used = observed.amr.map((method) => method.toLowerCase());
      if (!required.some((method) => used.includes(method))) {
        return await finish("challenge", "mfa_required", {
          authAgeSeconds: outcome.authAgeSeconds,
          requiredMaxAge: tool.maxAuthAgeSeconds,
        });
      }
    }
  }

  return await finish(outcome.decision, outcome.reason, {
    authAgeSeconds: outcome.authAgeSeconds,
    requiredMaxAge: outcome.requiredMaxAge,
  });
}
