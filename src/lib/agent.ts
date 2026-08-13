import Anthropic from "@anthropic-ai/sdk";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex } from "./convex-server";
import { anthropicConfig, appConfig, approvalMode } from "./env";

/**
 * The Claude agent loop.
 *
 * The agent has no privileged path. It carries the signed-in person's
 * delegated identity and calls the same `/api/tools/invoke` endpoint every
 * other caller uses, over HTTP, with their session cookie forwarded. It mints
 * no authority of its own and cannot reach an executor directly — if the seam
 * refuses, the agent is refused.
 *
 * The three seam responses are handled differently on purpose:
 *
 * - allow     — feed the result back and keep going.
 * - challenge — stop. Do not retry, do not try another tool, do not work
 *               around it. Freeze the conversation, surface the re-auth link
 *               to the human, and pause the run.
 * - deny      — stop and report. A denial is not something re-authentication
 *               fixes, so there is nothing to hand the human.
 *
 * The blind retry is the specific failure worth designing against: an agent
 * that retries a 403 in a loop turns a step-up challenge into a spin, and an
 * agent that "helpfully" reaches for a different tool routes around the very
 * control that just fired.
 */

const SYSTEM_PROMPT = `You are an operations assistant for an internal records console.

You act with the delegated authority of the signed-in person. You have no
authority of your own, and every tool call is checked by the server before it
runs.

Tools are either safe (read-only) or destructive (they change records). A
destructive tool may be held by the server until the person has authenticated
recently. If that happens you will be told so in the tool result, and the run
will end so the person can re-authenticate. That is a normal outcome, not an
error to work around: do not retry a held call, and do not substitute a
different tool to achieve the same effect.

Work in order: gather what you need with the read-only tools first, then act.
State plainly what you did and what you found.`;

export type AgentOutcome = {
  runId: Id<"runs">;
  correlationId: string;
  status: "completed" | "halted" | "failed";
  message: string;
  challenge?: {
    tool: string;
    reason: string;
    message: string;
    requiredMaxAge?: number;
    authAgeSeconds?: number;
    reauthUrl: string;
    correlationId: string;
  };
  denial?: { tool: string; reason: string; message: string };
  /** Present on a resume that released the held action. */
  released?: {
    tool: string;
    reason: string;
    authAgeSeconds?: number;
    maxAuthAgeSeconds?: number;
    amr?: string[];
    result: unknown;
  };
  toolCalls: number;
};

type SeamBody = {
  decision?: "allow" | "challenge" | "deny";
  reason?: string;
  message?: string;
  correlationId?: string;
  maxAuthAgeSeconds?: number;
  authTime?: number;
  authAgeSeconds?: number;
  amr?: string[];
  executed?: boolean;
  result?: unknown;
  error?: string;
  reauthUrl?: string;
};

type SeamResponse = {
  status: number;
  body: SeamBody;
  wwwAuthenticate: string | null;
};

/** Calls the seam over HTTP, exactly as any other client would. */
async function callSeam(
  tool: string,
  input: unknown,
  correlationId: string,
  cookieHeader: string,
): Promise<SeamResponse> {
  const response = await fetch(
    new URL("/api/tools/invoke", appConfig().siteUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The person's session, forwarded unchanged. This is the whole of the
        // agent's authority.
        cookie: cookieHeader,
      },
      body: JSON.stringify({ tool, args: input, correlationId }),
      cache: "no-store",
    },
  );

  return {
    status: response.status,
    body: (await response.json()) as SeamBody,
    wwwAuthenticate: response.headers.get("WWW-Authenticate"),
  };
}

/** Reads the tool registry and shapes it for the model. */
async function loadTools(): Promise<Anthropic.Tool[]> {
  const registry = await convex().query(api.tools.list, {});
  return registry
    .filter((tool) => tool.enabled)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
}

type EventType =
  | "model_message"
  | "tool_requested"
  | "tool_allowed"
  | "tool_challenged"
  | "tool_denied"
  | "tool_result"
  | "reauth_completed"
  | "run_finished";

type LoopContext = {
  runId: Id<"runs">;
  correlationId: string;
  cookieHeader: string;
};

/**
 * Retries a Convex write briefly.
 *
 * Used for the writes that decide what an operator sees: a run left stuck at
 * "running" because its closing status write hit a blip is a run that looks
 * broken when it is not. The audit trail has its own, stronger durability
 * path in `audit-sink.ts`; this is only about the run's own state.
 */
async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 3) {
        console.error(
          `[agent] ${label} failed after ${attempt} attempts:`,
          error instanceof Error ? error.message : error,
        );
        return undefined;
      }
      await new Promise((r) => setTimeout(r, 120 * 2 ** (attempt - 1)));
    }
  }
  return undefined;
}

/**
 * Appends a timeline event. Best-effort by design.
 *
 * `runEvents` is display telemetry: it drives the console timeline. The
 * security record is `auditLog`, written inside the seam, and that write is
 * strict — a failure there fails the call.
 *
 * The two are deliberately treated differently. In Phase 5 a transient
 * network failure on the final timeline write turned a resume that had
 * already released and executed a destructive action into an HTTP 500, which
 * reads to an operator as "the action failed" — the most dangerous thing a
 * console can say about a delete that actually happened. A timeline write can
 * be lost without anything becoming unsafe; the audit row cannot.
 */
async function appendEvent(
  ctx: LoopContext,
  type: EventType,
  detail: {
    toolName?: string;
    message?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await withRetry(`timeline write "${type}" for run ${ctx.runId}`, () =>
    convex().mutation(api.runs.appendEvent, {
      runId: ctx.runId,
      type,
      toolName: detail.toolName,
      message: detail.message,
      detail: detail.detail,
    }),
  );
}

/** Freezes the conversation at a challenge and returns the halted outcome. */
async function pauseOnChallenge(
  ctx: LoopContext,
  seam: SeamResponse,
  request: { id: string; name: string; input: unknown },
  messages: Anthropic.MessageParam[],
  lastText: string,
  toolCalls: number,
): Promise<AgentOutcome> {
  await appendEvent(ctx, "tool_challenged", {
    toolName: request.name,
    message: seam.body.message,
    detail: {
      reason: seam.body.reason,
      wwwAuthenticate: seam.wwwAuthenticate,
      // `requiredMaxAge` is the value the RFC 9470 challenge carries.
      // `maxAuthAgeSeconds` is the field every decision event reports, so an
      // allowed row and a held row read the same way in the timeline.
      requiredMaxAge: seam.body.maxAuthAgeSeconds,
      maxAuthAgeSeconds: seam.body.maxAuthAgeSeconds,
      authAgeSeconds: seam.body.authAgeSeconds,
    },
  });

  await withRetry(`pause run ${ctx.runId}`, () =>
    convex().mutation(api.runs.pause, {
      runId: ctx.runId,
      haltedReason: seam.body.reason ?? "step_up_required",
    challengeAuthTime: seam.body.authTime,
      pausedState: {
        messages,
        toolUseId: request.id,
        toolName: request.name,
        toolInput: request.input,
      },
    }),
  );

  await appendEvent(ctx, "run_finished", {
    message: "Run paused, waiting for a fresh authentication.",
  });

  return {
    runId: ctx.runId,
    correlationId: ctx.correlationId,
    status: "halted",
    message: lastText,
    toolCalls,
    challenge: {
      tool: request.name,
      reason: seam.body.reason ?? "step_up_required",
      message: seam.body.message ?? "A fresh authentication is required.",
      requiredMaxAge: seam.body.maxAuthAgeSeconds,
      authAgeSeconds: seam.body.authAgeSeconds,
      // The link carries the run back to the console, so the person lands
      // where the paused timeline is and the round trip closes in one place.
      // `max_age=0` and `prompt=login` are asks to the provider, never proof:
      // the resume is re-checked against `auth_time` by the seam.
      reauthUrl:
        `/api/auth/login?max_age=0&prompt=login&stepUp=1&returnTo=` +
        encodeURIComponent(`/?resume=${ctx.runId}`),
      correlationId: seam.body.correlationId ?? ctx.correlationId,
    },
  };
}

/**
 * Drives the model loop.
 *
 * `pending` is set only on a resume: it is the tool call that was held by a
 * challenge, and it is re-presented to the seam before the model is consulted
 * again. Re-presenting rather than re-planning is what makes the resume the
 * *same* task — the model never gets a chance to pick a different action.
 */
async function drive(
  ctx: LoopContext,
  seed: Anthropic.MessageParam[],
  pending?: { toolUseId: string; toolName: string; toolInput: unknown },
): Promise<AgentOutcome> {
  const { apiKey, model, maxTokens } = anthropicConfig();
  const client = new Anthropic({ apiKey });
  const tools = await loadTools();

  const messages = [...seed];
  let toolCalls = 0;
  let lastText = "";
  let released: AgentOutcome["released"];

  if (pending !== undefined) {
    const seam = await callSeam(
      pending.toolName,
      pending.toolInput,
      ctx.correlationId,
      ctx.cookieHeader,
    );
    toolCalls += 1;

    if (seam.status === 403 && seam.body.decision === "challenge") {
      // Still stale. The action stays held — this is the negative case that
      // must hold when a resume was not preceded by a real re-authentication.
      return await pauseOnChallenge(
        ctx,
        seam,
        {
          id: pending.toolUseId,
          name: pending.toolName,
          input: pending.toolInput,
        },
        messages,
        lastText,
        toolCalls,
      );
    }

    if (seam.body.decision === "deny" || seam.status === 401) {
      await appendEvent(ctx, "tool_denied", {
        toolName: pending.toolName,
        message: seam.body.message,
        detail: { reason: seam.body.reason },
      });
      await withRetry(`fail run ${ctx.runId}`, () =>
        convex().mutation(api.runs.setStatus, {
          runId: ctx.runId,
          status: "failed",
          haltedReason: seam.body.reason,
        }),
      );
      await appendEvent(ctx, "run_finished", {
        message: "Run stopped on a denial.",
      });
      return {
        runId: ctx.runId,
        correlationId: ctx.correlationId,
        status: "failed",
        message: lastText,
        toolCalls,
        denial: {
          tool: pending.toolName,
          reason: seam.body.reason ?? "denied",
          message: seam.body.message ?? "The call was refused.",
        },
      };
    }

    await withRetry(`clear paused state on run ${ctx.runId}`, () =>
      convex().mutation(api.runs.clearPausedState, { runId: ctx.runId }),
    );
    await appendEvent(ctx, "tool_allowed", {
      toolName: pending.toolName,
      message: seam.body.message,
      detail: {
        reason: seam.body.reason,
        authAgeSeconds: seam.body.authAgeSeconds,
        maxAuthAgeSeconds: seam.body.maxAuthAgeSeconds,
        amr: seam.body.amr,
      },
    });
    await appendEvent(ctx, "tool_result", {
      toolName: pending.toolName,
      detail: { result: seam.body.result as Record<string, unknown> },
    });

    released = {
      tool: pending.toolName,
      reason: seam.body.reason ?? "fresh_authentication",
      authAgeSeconds: seam.body.authAgeSeconds,
      maxAuthAgeSeconds: seam.body.maxAuthAgeSeconds,
      amr: seam.body.amr,
      result: seam.body.result,
    };

    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: pending.toolUseId,
          content: JSON.stringify(
            seam.body.executed === true
              ? seam.body.result
              : { error: seam.body.error ?? "The tool did not run." },
          ),
          is_error: seam.body.executed !== true,
        },
      ],
    });
  }

  for (let turn = 0; turn < 12; turn += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text !== "") {
      lastText = text;
      await appendEvent(ctx, "model_message", { message: text });
    }

    if (response.stop_reason !== "tool_use") {
      await withRetry(`complete run ${ctx.runId}`, () =>
        convex().mutation(api.runs.setStatus, {
          runId: ctx.runId,
          status: "completed",
        }),
      );
      await appendEvent(ctx, "run_finished", { message: "Run completed." });
      return {
        runId: ctx.runId,
        correlationId: ctx.correlationId,
        status: "completed",
        message: lastText,
        toolCalls,
        released,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const requests = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const request of requests) {
      toolCalls += 1;
      await appendEvent(ctx, "tool_requested", {
        toolName: request.name,
        detail: { input: request.input as Record<string, unknown> },
      });

      const seam = await callSeam(
        request.name,
        request.input,
        ctx.correlationId,
        ctx.cookieHeader,
      );

      if (seam.status === 403 && seam.body.decision === "challenge") {
        return await pauseOnChallenge(
          ctx,
          seam,
          request,
          messages,
          lastText,
          toolCalls,
        );
      }

      if (seam.body.decision === "deny" || seam.status === 401) {
        await appendEvent(ctx, "tool_denied", {
          toolName: request.name,
          message: seam.body.message,
          detail: { reason: seam.body.reason },
        });
        await withRetry(`fail run ${ctx.runId}`, () =>
          convex().mutation(api.runs.setStatus, {
            runId: ctx.runId,
            status: "failed",
            haltedReason: seam.body.reason,
          }),
        );
        await appendEvent(ctx, "run_finished", {
          message: "Run stopped on a denial.",
        });
        return {
          runId: ctx.runId,
          correlationId: ctx.correlationId,
          status: "failed",
          message: lastText,
          toolCalls,
          denial: {
            tool: request.name,
            reason: seam.body.reason ?? "denied",
            message: seam.body.message ?? "The call was refused.",
          },
        };
      }

      await appendEvent(ctx, "tool_allowed", {
        toolName: request.name,
        message: seam.body.message,
        detail: {
          reason: seam.body.reason,
          authAgeSeconds: seam.body.authAgeSeconds,
          maxAuthAgeSeconds: seam.body.maxAuthAgeSeconds,
          amr: seam.body.amr,
        },
      });
      await appendEvent(ctx, "tool_result", {
        toolName: request.name,
        detail: { result: seam.body.result as Record<string, unknown> },
      });

      results.push({
        type: "tool_result",
        tool_use_id: request.id,
        content: JSON.stringify(
          seam.body.executed === true
            ? seam.body.result
            : { error: seam.body.error ?? "The tool did not run." },
        ),
        is_error: seam.body.executed !== true,
      });
    }

    messages.push({ role: "user", content: results });
  }

  await withRetry(`fail run ${ctx.runId}`, () =>
    convex().mutation(api.runs.setStatus, {
      runId: ctx.runId,
      status: "failed",
    }),
  );
  await appendEvent(ctx, "run_finished", {
    message: "Run stopped at the turn limit.",
  });
  return {
    runId: ctx.runId,
    correlationId: ctx.correlationId,
    status: "failed",
    message: lastText,
    toolCalls,
    released,
  };
}

/**
 * Opens a run and returns its id without doing any work.
 *
 * Split from the loop so the console can start streaming the timeline
 * immediately. The agent's first model turn takes seconds; an operator should
 * not stare at nothing while it happens.
 */
export async function createRun(options: {
  prompt: string;
  userId: string;
  correlationId: string;
}): Promise<Id<"runs">> {
  // Retried like the other run-state writes: a transient fault here fails the
  // operator's very first action, which reads as "the app is broken" rather
  // than "the network hiccuped".
  const runId = await withRetry("open run", () =>
    convex().mutation(api.runs.start, {
      correlationId: options.correlationId,
      userId: options.userId,
      prompt: options.prompt,
      approvalMode: approvalMode(),
    }),
  );
  if (runId === undefined) {
    throw new Error("could not open a run — the store did not accept it");
  }
  return runId;
}

/** Drives an already-opened run to its first stopping point. */
export async function runAgent(options: {
  runId: Id<"runs">;
  prompt: string;
  cookieHeader: string;
  correlationId: string;
}): Promise<AgentOutcome> {
  return await drive(
    {
      runId: options.runId,
      correlationId: options.correlationId,
      cookieHeader: options.cookieHeader,
    },
    [{ role: "user", content: options.prompt }],
  );
}

/**
 * Resumes a run that a step-up challenge paused.
 *
 * The held tool call is re-presented to the seam under the original
 * correlationId. Nothing here decides whether it may proceed: the seam
 * re-reads `auth_time` from the token presented on this request and makes
 * that call itself. A resume attempted without a genuine re-authentication
 * therefore meets exactly the same refusal as the original attempt.
 */
export async function resumeAgent(options: {
  runId: Id<"runs">;
  userId: string;
  cookieHeader: string;
  /** `auth_time` observed now, for the audit narrative only. */
  observedAuthTime?: number;
}): Promise<AgentOutcome | { error: string; message: string }> {
  const run = await convex().query(api.runs.get, { runId: options.runId });
  if (run === null || run.userId !== options.userId) {
    return { error: "not_found", message: "No such run." };
  }
  if (run.status !== "halted" || run.pausedState === undefined) {
    return {
      error: "not_paused",
      message: `This run is ${run.status}; only a paused run can be resumed.`,
    };
  }

  const ctx: LoopContext = {
    runId: options.runId,
    correlationId: run.correlationId,
    cookieHeader: options.cookieHeader,
  };

  // The run is working again from here, whatever the seam goes on to decide.
  await withRetry(`mark run ${options.runId} resuming`, () =>
    convex().mutation(api.runs.markResuming, { runId: options.runId }),
  );

  // Recorded before the attempt so the trail shows what the human did, and
  // shows it even when the seam goes on to refuse the resume.
  await appendEvent(ctx, "reauth_completed", {
    message:
      options.observedAuthTime === undefined
        ? "Resume attempted; no auth_time could be read."
        : `Resume attempted with auth_time ${options.observedAuthTime}.`,
    detail: {
      authTimeAtChallenge: run.challengeAuthTime,
      authTimeNow: options.observedAuthTime,
      advanced:
        run.challengeAuthTime !== undefined &&
        options.observedAuthTime !== undefined &&
        options.observedAuthTime > run.challengeAuthTime,
    },
  });

  const paused = run.pausedState;
  return await drive(ctx, paused.messages as Anthropic.MessageParam[], {
    toolUseId: paused.toolUseId,
    toolName: paused.toolName,
    toolInput: paused.toolInput,
  });
}
