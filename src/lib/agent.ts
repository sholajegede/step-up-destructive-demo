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
 *               around it. Surface the re-auth link to the human, carry the
 *               correlationId and required max_age through, and pause the run.
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
  /** The final assistant text. */
  message: string;
  /** Set when the run halted on a step-up challenge. */
  challenge?: {
    tool: string;
    reason: string;
    message: string;
    requiredMaxAge?: number;
    reauthUrl: string;
    correlationId: string;
  };
  /** Set when the run stopped on a denial. */
  denial?: { tool: string; reason: string; message: string };
  toolCalls: number;
};

type SeamResponse = {
  status: number;
  body: {
    decision?: "allow" | "challenge" | "deny";
    reason?: string;
    message?: string;
    correlationId?: string;
    maxAuthAgeSeconds?: number;
    authAgeSeconds?: number;
    executed?: boolean;
    result?: unknown;
    error?: string;
    reauthUrl?: string;
  };
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
    body: await response.json(),
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

export async function runAgent(options: {
  prompt: string;
  userId: string;
  cookieHeader: string;
  correlationId: string;
}): Promise<AgentOutcome> {
  const { apiKey, model, maxTokens } = anthropicConfig();
  const client = new Anthropic({ apiKey });
  const tools = await loadTools();

  const runId = await convex().mutation(api.runs.start, {
    correlationId: options.correlationId,
    userId: options.userId,
    prompt: options.prompt,
    // Resolved server-side inside the seam; recorded here for the timeline.
    approvalMode: approvalMode(),
  });

  const event = async (
    type:
      | "model_message"
      | "tool_requested"
      | "tool_allowed"
      | "tool_challenged"
      | "tool_denied"
      | "tool_result"
      | "run_finished",
    detail: {
      toolName?: string;
      message?: string;
      detail?: Record<string, unknown>;
    },
  ) => {
    await convex().mutation(api.runs.appendEvent, {
      runId,
      type,
      toolName: detail.toolName,
      message: detail.message,
      detail: detail.detail,
    });
  };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: options.prompt },
  ];
  let toolCalls = 0;
  let lastText = "";

  // A hard ceiling on model turns. The loop also ends on end_turn, on a
  // challenge, and on a denial; this only bounds a pathological run.
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
      await event("model_message", { message: text });
    }

    if (response.stop_reason !== "tool_use") {
      await convex().mutation(api.runs.setStatus, {
        runId,
        status: "completed",
      });
      await event("run_finished", { message: "Run completed." });
      return {
        runId,
        correlationId: options.correlationId,
        status: "completed",
        message: lastText,
        toolCalls,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const requests = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const request of requests) {
      toolCalls += 1;
      await event("tool_requested", {
        toolName: request.name,
        detail: { input: request.input as Record<string, unknown> },
      });

      const seam = await callSeam(
        request.name,
        request.input,
        options.correlationId,
        options.cookieHeader,
      );

      // A step-up challenge ends the run. The human is the only one who can
      // clear it, so the agent stops rather than retrying or substituting.
      if (seam.status === 403 && seam.body.decision === "challenge") {
        await event("tool_challenged", {
          toolName: request.name,
          message: seam.body.message,
          detail: {
            reason: seam.body.reason,
            wwwAuthenticate: seam.wwwAuthenticate,
            requiredMaxAge: seam.body.maxAuthAgeSeconds,
            authAgeSeconds: seam.body.authAgeSeconds,
          },
        });
        await convex().mutation(api.runs.setStatus, {
          runId,
          status: "halted",
          haltedReason: seam.body.reason,
        });
        await event("run_finished", {
          message: "Run paused, waiting for a fresh authentication.",
        });

        return {
          runId,
          correlationId: options.correlationId,
          status: "halted",
          message: lastText,
          toolCalls,
          challenge: {
            tool: request.name,
            reason: seam.body.reason ?? "step_up_required",
            message: seam.body.message ?? "A fresh authentication is required.",
            requiredMaxAge: seam.body.maxAuthAgeSeconds,
            reauthUrl: seam.body.reauthUrl ?? "/api/auth/login?max_age=0&prompt=login&stepUp=1",
            correlationId: seam.body.correlationId ?? options.correlationId,
          },
        };
      }

      if (seam.body.decision === "deny" || seam.status === 401) {
        await event("tool_denied", {
          toolName: request.name,
          message: seam.body.message,
          detail: { reason: seam.body.reason },
        });
        await convex().mutation(api.runs.setStatus, {
          runId,
          status: "failed",
          haltedReason: seam.body.reason,
        });
        await event("run_finished", { message: "Run stopped on a denial." });

        return {
          runId,
          correlationId: options.correlationId,
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

      await event("tool_allowed", {
        toolName: request.name,
        message: seam.body.message,
        detail: { reason: seam.body.reason },
      });
      await event("tool_result", {
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

  await convex().mutation(api.runs.setStatus, { runId, status: "failed" });
  await event("run_finished", { message: "Run stopped at the turn limit." });
  return {
    runId,
    correlationId: options.correlationId,
    status: "failed",
    message: lastText,
    toolCalls,
  };
}
