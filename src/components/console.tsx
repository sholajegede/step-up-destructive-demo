"use client";

import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { ApprovalMode } from "@/lib/env";
import { MetricsPanel } from "./metrics-panel";
import { RecordsPanel } from "./records-panel";
import { RunTimeline, useHeldChallenge } from "./run-timeline";
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Mono,
  Panel,
  Skeleton,
  formatAge,
  formatTime,
} from "./ui";

const SUGGESTIONS = [
  "Review our documents, identify the one that has been superseded and is no longer needed, then delete it.",
  "Summarise the invoices, then refund the smallest paid one.",
  "Check the staged releases and deploy the checkout service to production.",
];

export function Console({
  mode,
  userId,
  email,
}: {
  mode: ApprovalMode;
  userId: string;
  email?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [prompt, setPrompt] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<Id<"runs"> | null>(null);
  const [starting, setStarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runs = useQuery(api.runs.listByUser, { userId, limit: 20 });

  // Derived rather than stored: with nothing explicitly chosen, the newest
  // run is shown. A returning operator lands on something instead of an empty
  // pane, and picking a run is just setting the override.
  const activeRunId: Id<"runs"> | null =
    selectedRunId ?? (runs !== undefined && runs.length > 0 ? runs[0]._id : null);
  const challenge = useHeldChallenge(activeRunId);

  const resume = useCallback(async (runId: Id<"runs">) => {
    setResuming(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/agent/run/${runId}/resume`, {
        method: "POST",
      });
      // A 403 here means the seam refused the resume, which the timeline
      // already shows. Only report what the timeline cannot say for itself.
      if (!response.ok && response.status !== 403) {
        const body = await response.json().catch(() => ({}));
        setNotice(
          body.message ??
            "The resume request did not come back cleanly. The timeline below is authoritative.",
        );
      }
    } catch {
      setNotice(
        "The resume request did not come back cleanly. The timeline below is authoritative.",
      );
    } finally {
      setResuming(false);
    }
  }, []);

  // Coming back from Kinde: the login carried the run id, so the round trip
  // closes here without the operator hunting for the paused run.
  const resumedRef = useRef<string | null>(null);
  useEffect(() => {
    const target = searchParams.get("resume");
    if (target === null || resumedRef.current === target) return;
    resumedRef.current = target;
    setSelectedRunId(target as Id<"runs">);
    void resume(target as Id<"runs">);
    router.replace("/");
  }, [searchParams, resume, router]);

  const start = async () => {
    const task = prompt.trim();
    if (task === "") return;
    setStarting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: task }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body.runId === "string") {
        setSelectedRunId(body.runId as Id<"runs">);
      } else if (!response.ok && response.status !== 403) {
        setNotice(body.message ?? "The run could not be started.");
      }
      setPrompt("");
    } catch {
      setNotice(
        "The run request did not come back cleanly. Check the run list below.",
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-4 py-4 lg:px-6">
      <Header mode={mode} email={email} />

      {notice !== null && (
        <ErrorNote title="Request problem" onDismiss={() => setNotice(null)}>
          {notice}
        </ErrorNote>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-h-0 flex-col gap-4">
          <Panel
            title="Give the agent a task"
            subtitle="It reads freely. Anything destructive is checked before it runs."
          >
            <div className="flex flex-col gap-3 p-4">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    void start();
                  }
                }}
                rows={3}
                placeholder="e.g. Review our documents, find the one that has been superseded, and delete it."
                className="w-full resize-y rounded-lg border border-line bg-background px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-line-strong"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={start}
                  disabled={starting || prompt.trim() === ""}
                >
                  {starting ? "Starting…" : "Run task"}
                </Button>
                <span className="text-xs text-muted">⌘/Ctrl + Enter</span>
                <span className="ml-auto text-xs text-muted">
                  Runs are independent — start another any time.
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setPrompt(suggestion)}
                    className="rounded-md border border-line px-2 py-1 text-left text-xs text-muted transition-colors hover:border-line-strong hover:text-foreground"
                  >
                    {suggestion.length > 58
                      ? `${suggestion.slice(0, 58)}…`
                      : suggestion}
                  </button>
                ))}
              </div>
            </div>
          </Panel>

          {challenge !== null && activeRunId !== null && (
            <StepUpCallToAction
              challenge={challenge}
              runId={activeRunId}
              resuming={resuming}
              onResume={() => void resume(activeRunId)}
            />
          )}

          {activeRunId === null ? (
            <Panel title="Timeline" className="flex-1">
              {runs === undefined ? (
                <Skeleton rows={4} />
              ) : (
                <Empty>
                  No run selected. Give the agent a task above to begin.
                </Empty>
              )}
            </Panel>
          ) : (
            <RunTimeline runId={activeRunId} />
          )}
        </div>

        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <MetricsPanel mode={mode} />
          <RunList
            runs={runs}
            selectedRunId={activeRunId}
            onSelect={setSelectedRunId}
          />
          <RecordsPanel />
        </aside>
      </div>
    </div>
  );
}

function Header({ mode, email }: { mode: ApprovalMode; email?: string }) {
  const stepUp = mode === "step-up";
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="min-w-0">
        <h1 className="text-base font-semibold tracking-tight">
          Records Console
        </h1>
        <p className="text-xs text-muted">
          An agent with your delegated authority — nothing more.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div
          className={`rounded-lg px-3 py-1.5 ${
            stepUp ? "bg-allow-bg" : "bg-escaped-bg"
          }`}
          title="Decided by the server from its deploy environment. The console cannot change it."
        >
          <p className="text-[10px] uppercase tracking-wide text-muted">
            Approval mode
          </p>
          <p
            className={`font-mono text-sm font-semibold ${
              stepUp ? "text-allow" : "text-escaped"
            }`}
          >
            {mode}
          </p>
        </div>
        {email !== undefined && (
          <span className="hidden text-xs text-muted sm:inline">{email}</span>
        )}
        <a
          href="/api/auth/logout"
          className="rounded-lg border border-line-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-muted"
        >
          Sign out
        </a>
      </div>
    </header>
  );
}

function StepUpCallToAction({
  challenge,
  runId,
  resuming,
  onResume,
}: {
  challenge: {
    tool?: string;
    reason?: string;
    requiredMaxAge?: number;
    authAgeSeconds?: number;
  };
  runId: Id<"runs">;
  resuming: boolean;
  onResume: () => void;
}) {
  const reauthUrl = `/api/auth/login?max_age=0&prompt=login&stepUp=1&returnTo=${encodeURIComponent(
    `/?resume=${runId}`,
  )}`;

  return (
    <section className="rounded-xl border border-challenge/40 bg-challenge-bg px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone="challenge">Held for step-up</Badge>
            {challenge.tool !== undefined && <Mono>{challenge.tool}</Mono>}
          </div>
          <p className="mt-2 text-sm font-medium">
            This action needs you to prove you are here, right now.
          </p>
          <p className="mt-1 text-xs text-foreground/75">
            {challenge.reason === "auth_time_stale" &&
            challenge.authAgeSeconds !== undefined ? (
              <>
                Your last sign-in was{" "}
                <strong>{formatAge(challenge.authAgeSeconds)}</strong> ago and
                this action allows{" "}
                <strong>{formatAge(challenge.requiredMaxAge)}</strong>.
              </>
            ) : (
              <>
                Freshness could not be proved from your current session
                {challenge.reason !== undefined && (
                  <>
                    {" ("}
                    <Mono>{challenge.reason}</Mono>
                    {")"}
                  </>
                )}
                . This action allows{" "}
                <strong>{formatAge(challenge.requiredMaxAge)}</strong>.
              </>
            )}{" "}
            Re-authenticating does not approve the action — the server re-checks
            when the agent tries again.
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          <a
            href={reauthUrl}
            className="inline-flex items-center justify-center rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            Re-authenticate to continue
          </a>
          <Button
            variant="secondary"
            onClick={onResume}
            disabled={resuming}
            className="text-xs"
          >
            {resuming ? "Retrying…" : "Retry without re-authenticating"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function RunList({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: Doc<"runs">[] | undefined;
  selectedRunId: Id<"runs"> | null;
  onSelect: (id: Id<"runs">) => void;
}) {
  return (
    <Panel title="Runs" subtitle="Yours, newest first">
      {runs === undefined ? (
        <Skeleton rows={3} />
      ) : runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {runs.map((run) => {
            const selected = run._id === selectedRunId;
            return (
              <li key={run._id}>
                <button
                  type="button"
                  onClick={() => onSelect(run._id as Id<"runs">)}
                  className={`w-full px-4 py-2.5 text-left transition-colors ${
                    selected ? "bg-surface-muted" : "hover:bg-surface-muted/60"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      tone={
                        run.status === "halted"
                          ? "challenge"
                          : run.status === "completed"
                            ? "allow"
                            : run.status === "failed"
                              ? "deny"
                              : "neutral"
                      }
                    >
                      {run.status}
                    </Badge>
                    <span className="font-mono text-[11px] text-muted">
                      {formatTime(run.startedAt)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-foreground/80">
                    {run.prompt}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
