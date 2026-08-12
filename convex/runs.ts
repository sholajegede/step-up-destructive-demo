import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { approvalModeValidator } from "./schema";

const runStatus = v.union(
  v.literal("running"),
  v.literal("halted"),
  v.literal("completed"),
  v.literal("failed"),
);

const eventType = v.union(
  v.literal("run_started"),
  v.literal("model_message"),
  v.literal("tool_requested"),
  v.literal("tool_allowed"),
  v.literal("tool_challenged"),
  v.literal("tool_denied"),
  v.literal("tool_result"),
  v.literal("reauth_completed"),
  v.literal("run_finished"),
);

/**
 * Opens a run.
 *
 * `approvalMode` is passed in by the server, which resolved it from the deploy
 * environment. It is stored on the run so the timeline can show which mode
 * produced the outcome.
 */
export const start = mutation({
  args: {
    correlationId: v.string(),
    userId: v.string(),
    prompt: v.string(),
    approvalMode: approvalModeValidator,
  },
  handler: async (ctx, args) => {
    const runId = await ctx.db.insert("runs", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
    await ctx.db.insert("runEvents", {
      runId,
      correlationId: args.correlationId,
      seq: 0,
      type: "run_started",
      message: args.prompt,
      createdAt: Date.now(),
    });
    return runId;
  },
});

export const appendEvent = mutation({
  args: {
    runId: v.id("runs"),
    type: eventType,
    toolName: v.optional(v.string()),
    message: v.optional(v.string()),
    detail: v.optional(v.any()),
  },
  handler: async (ctx, { runId, ...event }) => {
    const run = await ctx.db.get(runId);
    if (run === null) {
      throw new Error(`Unknown run ${runId}`);
    }
    const last = await ctx.db
      .query("runEvents")
      .withIndex("by_runId_seq", (q) => q.eq("runId", runId))
      .order("desc")
      .first();
    return await ctx.db.insert("runEvents", {
      runId,
      correlationId: run.correlationId,
      seq: (last?.seq ?? -1) + 1,
      ...event,
      createdAt: Date.now(),
    });
  },
});

export const setStatus = mutation({
  args: {
    runId: v.id("runs"),
    status: runStatus,
    haltedReason: v.optional(v.string()),
  },
  handler: async (ctx, { runId, status, haltedReason }) => {
    await ctx.db.patch(runId, {
      status,
      haltedReason,
      endedAt:
        status === "completed" || status === "failed" ? Date.now() : undefined,
    });
  },
});

/**
 * Freezes a run at a step-up challenge.
 *
 * The conversation is stored so the resume continues the same task under the
 * same correlationId, rather than re-running the prompt from the top.
 */
export const pause = mutation({
  args: {
    runId: v.id("runs"),
    haltedReason: v.string(),
    challengeAuthTime: v.optional(v.number()),
    pausedState: v.object({
      messages: v.any(),
      toolUseId: v.string(),
      toolName: v.string(),
      toolInput: v.any(),
    }),
  },
  handler: async (ctx, { runId, ...rest }) => {
    await ctx.db.patch(runId, { status: "halted", ...rest });
  },
});

/** Clears the paused state once a run has resumed past its challenge. */
export const clearPausedState = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await ctx.db.patch(runId, {
      status: "running",
      pausedState: undefined,
      haltedReason: undefined,
    });
  },
});

export const get = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => ctx.db.get(runId),
});

export const byCorrelationId = query({
  args: { correlationId: v.string() },
  handler: async (ctx, { correlationId }) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_correlationId", (q) =>
        q.eq("correlationId", correlationId),
      )
      .unique();
  },
});

/** The run's event stream, oldest first — what the timeline renders. */
export const events = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    return await ctx.db
      .query("runEvents")
      .withIndex("by_runId_seq", (q) => q.eq("runId", runId))
      .order("asc")
      .collect();
  },
});
