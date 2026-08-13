"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  Badge,
  Empty,
  ErrorNote,
  Mono,
  Panel,
  Skeleton,
  formatAge,
  formatTime,
  type Tone,
} from "./ui";

type RunEvent = Doc<"runEvents">;

const LABELS: Record<RunEvent["type"], string> = {
  run_started: "Task received",
  model_message: "Agent",
  tool_requested: "Tool requested",
  tool_allowed: "Allowed",
  tool_challenged: "Held for step-up",
  tool_denied: "Denied",
  tool_result: "Result",
  reauth_completed: "Re-authentication",
  run_finished: "Run finished",
};

const TONES: Partial<Record<RunEvent["type"], Tone>> = {
  tool_allowed: "allow",
  tool_challenged: "challenge",
  tool_denied: "deny",
  reauth_completed: "challenge",
};

/**
 * The live run timeline.
 *
 * Everything here is read from Convex by subscription — including the run's
 * status. That is deliberate: the HTTP call that started or resumed the run
 * is not the source of truth for whether it succeeded. A transient network
 * failure on the way back must never render a destructive action that
 * actually executed as a failed run.
 */
export function RunTimeline({ runId }: { runId: Id<"runs"> }) {
  const run = useQuery(api.runs.get, { runId });
  const events = useQuery(api.runs.events, { runId });

  if (run === undefined || events === undefined) {
    return (
      <Panel title="Timeline">
        <Skeleton rows={4} />
      </Panel>
    );
  }

  if (run === null) {
    return (
      <Panel title="Timeline">
        <Empty>That run no longer exists.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="Timeline"
      subtitle={`${events.length} step${events.length === 1 ? "" : "s"} · updates live`}
      action={<RunStatusBadge status={run.status} />}
      className="min-h-0 flex-1"
    >
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-muted/50 px-4 py-2">
        <span className="text-xs text-muted">correlationId</span>
        <Mono className="truncate text-muted">{run.correlationId}</Mono>
      </div>

      {events.length === 0 ? (
        <Empty>Waiting for the first step…</Empty>
      ) : (
        <ol className="flex-1 divide-y divide-line overflow-y-auto">
          {events.map((event) => (
            <TimelineRow key={event._id} event={event} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function TimelineRow({ event }: { event: RunEvent }) {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const tone = TONES[event.type];
  const age = detail.authAgeSeconds as number | undefined;
  // Every decision event reports `maxAuthAgeSeconds`. `requiredMaxAge` is the
  // older field name and is still read so rows written before it was
  // normalised keep rendering their window.
  const window = (detail.maxAuthAgeSeconds ?? detail.requiredMaxAge) as
    | number
    | undefined;
  const amr = detail.amr as string[] | undefined;

  return (
    <li className="arrive px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {tone !== undefined ? (
            <Badge tone={tone}>{LABELS[event.type]}</Badge>
          ) : (
            <span className="text-xs font-medium text-muted">
              {LABELS[event.type]}
            </span>
          )}
          {event.toolName !== undefined && (
            <Mono className="truncate">{event.toolName}</Mono>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {formatTime(event.createdAt)}
        </span>
      </div>

      {event.message !== undefined && event.message !== "" && (
        <p
          className={`mt-1.5 whitespace-pre-wrap text-sm ${
            event.type === "model_message" ? "" : "text-foreground/75"
          }`}
        >
          {event.message.length > 700
            ? `${event.message.slice(0, 700)}…`
            : event.message}
        </p>
      )}

      {detail.input !== undefined && (
        <Mono className="mt-1.5 block truncate text-muted">
          {JSON.stringify(detail.input)}
        </Mono>
      )}

      {(age !== undefined || window !== undefined) && (
        <p className="mt-1.5 text-xs text-muted">
          Authentication age{" "}
          <span className="font-mono text-foreground">{formatAge(age)}</span>{" "}
          against a window of{" "}
          <span className="font-mono text-foreground">{formatAge(window)}</span>
          {detail.reason !== undefined && (
            <>
              {" · "}
              <Mono>{String(detail.reason)}</Mono>
            </>
          )}
        </p>
      )}

      {amr !== undefined && amr.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          Methods <Mono className="text-foreground">{amr.join(", ")}</Mono>
        </p>
      )}
    </li>
  );
}

function RunStatusBadge({ status }: { status: Doc<"runs">["status"] }) {
  const map: Record<Doc<"runs">["status"], { tone: Tone; label: string }> = {
    running: { tone: "neutral", label: "Running" },
    halted: { tone: "challenge", label: "Held" },
    completed: { tone: "allow", label: "Completed" },
    failed: { tone: "deny", label: "Stopped" },
  };
  const { tone, label } = map[status];
  return (
    <Badge tone={tone} className="shrink-0">
      {status === "running" && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {label}
    </Badge>
  );
}

/**
 * The challenge a run is currently held at, or null.
 *
 * Derived from the same subscriptions the timeline renders, so the call to
 * action and the timeline can never disagree about whether a run is held.
 */
export function useHeldChallenge(runId: Id<"runs"> | null): {
  tool?: string;
  reason?: string;
  requiredMaxAge?: number;
  authAgeSeconds?: number;
} | null {
  const run = useQuery(api.runs.get, runId === null ? "skip" : { runId });
  const events = useQuery(api.runs.events, runId === null ? "skip" : { runId });

  if (run === undefined || run === null || events === undefined) return null;
  if (run.status !== "halted") return null;

  const held = events.filter((e) => e.type === "tool_challenged").at(-1);
  if (held === undefined) return null;

  const detail = (held.detail ?? {}) as Record<string, unknown>;
  return {
    tool: held.toolName,
    reason: detail.reason as string | undefined,
    requiredMaxAge: (detail.maxAuthAgeSeconds ?? detail.requiredMaxAge) as
      | number
      | undefined,
    authAgeSeconds: detail.authAgeSeconds as number | undefined,
  };
}

export { ErrorNote };
