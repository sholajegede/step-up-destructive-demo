import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The decision the enforcement seam reached for one tool call.
 *
 * - allow     — the call was permitted and executed.
 * - challenge — the call was held and a fresh authentication was demanded.
 * - deny      — the call was refused outright.
 */
export const decisionValidator = v.union(
  v.literal("allow"),
  v.literal("challenge"),
  v.literal("deny"),
);

/** Resolved server-side approval mode at the moment of the decision. */
export const approvalModeValidator = v.union(
  v.literal("blanket"),
  v.literal("step-up"),
);

export default defineSchema({
  /**
   * The tool registry.
   *
   * `destructive` drives the enforcement seam. `maxAuthAgeSeconds` is the
   * freshness window in seconds: how old the human's last interactive
   * authentication may be for this tool to run.
   *
   * The invariant, enforced on write in `convex/tools.ts` and asserted by the
   * registry test: a destructive tool MUST carry a positive
   * `maxAuthAgeSeconds`; a safe tool MUST NOT carry one at all. A destructive
   * tool with no window would sail through a freshness comparison it never
   * had to satisfy, so the absence of a window is treated as a registry
   * defect rather than as "no limit".
   */
  tools: defineTable({
    name: v.string(),
    title: v.string(),
    description: v.string(),
    destructive: v.boolean(),
    maxAuthAgeSeconds: v.optional(v.number()),
    /** Operates on this record kind, when the tool acts on a record. */
    recordKind: v.optional(v.string()),
    /** JSON Schema for the tool input, handed to the model verbatim. */
    inputSchema: v.any(),
    enabled: v.boolean(),
  }).index("by_name", ["name"]),

  /**
   * The records the tools act on. One table, discriminated by `kind`, so a
   * destructive tool and its safe read counterpart address the same rows.
   */
  records: defineTable({
    kind: v.union(
      v.literal("invoice"),
      v.literal("release"),
      v.literal("document"),
    ),
    ref: v.string(),
    title: v.string(),
    status: v.string(),
    owner: v.string(),
    amountCents: v.optional(v.number()),
    environment: v.optional(v.string()),
    summary: v.optional(v.string()),
    /** Soft-delete marker, so a slipped-through delete stays visible. */
    deletedAt: v.optional(v.number()),
    refundedAt: v.optional(v.number()),
    deployedAt: v.optional(v.number()),
  })
    .index("by_ref", ["ref"])
    .index("by_kind", ["kind"]),

  /** One agent task from prompt to conclusion. */
  runs: defineTable({
    correlationId: v.string(),
    userId: v.string(),
    prompt: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("halted"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    /** The mode the server resolved when the run started. */
    approvalMode: approvalModeValidator,
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    haltedReason: v.optional(v.string()),
    /**
     * The conversation frozen at the moment of a step-up challenge, so the
     * run resumes the same task rather than starting a new one.
     *
     * `messages` is the Anthropic message history up to and including the
     * assistant turn that requested the held tool. `toolUseId` is the block
     * the tool result must answer — without it the model's turn would be
     * malformed on resume.
     */
    pausedState: v.optional(
      v.object({
        messages: v.any(),
        toolUseId: v.string(),
        toolName: v.string(),
        toolInput: v.any(),
      }),
    ),
    /**
     * `auth_time` as it stood when the challenge was raised.
     *
     * Kept for the audit narrative only. The release decision is made by the
     * seam re-reading `auth_time` from the presented token; this value is
     * never what authorises anything.
     */
    challengeAuthTime: v.optional(v.number()),
  })
    .index("by_correlationId", ["correlationId"])
    .index("by_userId", ["userId"]),

  /** The ordered stream of what happened inside a run. */
  runEvents: defineTable({
    runId: v.id("runs"),
    correlationId: v.string(),
    seq: v.number(),
    type: v.union(
      v.literal("run_started"),
      v.literal("model_message"),
      v.literal("tool_requested"),
      v.literal("tool_allowed"),
      v.literal("tool_challenged"),
      v.literal("tool_denied"),
      v.literal("tool_result"),
      v.literal("reauth_completed"),
      v.literal("run_finished"),
    ),
    toolName: v.optional(v.string()),
    message: v.optional(v.string()),
    detail: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_runId_seq", ["runId", "seq"])
    .index("by_correlationId", ["correlationId"]),

  /**
   * The audit trail. Every allow, challenge, and deny writes exactly one row,
   * carrying the correlationId that ties challenge -> re-auth -> release into
   * one story.
   *
   * The freshness arithmetic is recorded as it was evaluated, so a decision
   * can be re-checked later without trusting the token that produced it.
   */
  auditLog: defineTable({
    correlationId: v.string(),
    runId: v.optional(v.id("runs")),
    userId: v.string(),
    toolName: v.string(),
    destructive: v.boolean(),
    decision: decisionValidator,
    /** Stable machine-readable reason, e.g. "auth_time_stale". */
    reason: v.string(),
    /** The mode the server resolved for this decision. */
    approvalMode: approvalModeValidator,
    /** `auth_time` claim, seconds since epoch, when the token carried one. */
    authTime: v.optional(v.number()),
    /** Age of the authentication in seconds at decision time. */
    authAgeSeconds: v.optional(v.number()),
    /** The window this decision was measured against. */
    maxAuthAgeSeconds: v.optional(v.number()),
    /** `amr` claim, the methods the human actually used. */
    amr: v.optional(v.array(v.string())),
    /** JWT id of the presented token, for correlation without storing it. */
    tokenId: v.optional(v.string()),
    recordRef: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_correlationId", ["correlationId"])
    .index("by_userId", ["userId"])
    .index("by_decision", ["decision"]),
});
