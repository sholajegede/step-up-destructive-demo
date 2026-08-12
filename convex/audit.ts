import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { approvalModeValidator, decisionValidator } from "./schema";

/**
 * Records one enforcement decision.
 *
 * Every allow, challenge, and deny writes exactly one row. The freshness
 * arithmetic is stored as it was evaluated so the decision can be re-read
 * later without the token that produced it.
 */
export const record = mutation({
  args: {
    correlationId: v.string(),
    runId: v.optional(v.id("runs")),
    userId: v.string(),
    toolName: v.string(),
    destructive: v.boolean(),
    decision: decisionValidator,
    reason: v.string(),
    approvalMode: approvalModeValidator,
    authTime: v.optional(v.number()),
    authAgeSeconds: v.optional(v.number()),
    maxAuthAgeSeconds: v.optional(v.number()),
    amr: v.optional(v.array(v.string())),
    tokenId: v.optional(v.string()),
    recordRef: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("auditLog", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** The full trail for one correlationId, oldest first. */
export const byCorrelationId = query({
  args: { correlationId: v.string() },
  handler: async (ctx, { correlationId }) => {
    const rows = await ctx.db
      .query("auditLog")
      .withIndex("by_correlationId", (q) =>
        q.eq("correlationId", correlationId),
      )
      .collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
});

/** Most recent decisions across all runs. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db.query("auditLog").order("desc").take(limit ?? 50);
  },
});

/**
 * The headline counters.
 *
 * `executedWithoutFreshAuth` counts destructive calls that were allowed while
 * the authentication was outside the tool's window — the number that must be
 * zero whenever step-up is enforced.
 */
export const metrics = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("auditLog").collect();
    const destructive = rows.filter((r) => r.destructive);
    return {
      safeCalls: rows.filter((r) => !r.destructive).length,
      destructiveAttempts: destructive.length,
      challenged: rows.filter((r) => r.decision === "challenge").length,
      denied: rows.filter((r) => r.decision === "deny").length,
      executedWithoutFreshAuth: destructive.filter(
        (r) =>
          r.decision === "allow" &&
          (r.authAgeSeconds === undefined ||
            r.maxAuthAgeSeconds === undefined ||
            r.authAgeSeconds > r.maxAuthAgeSeconds),
      ).length,
    };
  },
});
