"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { ApprovalMode } from "@/lib/env";
import { Panel, Skeleton } from "./ui";

/**
 * Live counters.
 *
 * `executedWithoutFreshAuth` is the headline and is styled as such: it is the
 * number that must be zero whenever the freshness check is enforced, and the
 * number that climbs the moment it is not.
 */
export function MetricsPanel({ mode }: { mode: ApprovalMode }) {
  const metrics = useQuery(api.audit.metrics, {});

  if (metrics === undefined) {
    return (
      <Panel title="Metrics" subtitle="Across every run on this deployment">
        <Skeleton rows={2} />
      </Panel>
    );
  }

  const escaped = metrics.executedWithoutFreshAuth;
  const escapedIsBad = escaped > 0;

  return (
    <Panel title="Metrics" subtitle="Across every run on this deployment">
      <div className="grid grid-cols-2 gap-px bg-line">
        <Cell label="Safe calls" value={metrics.safeCalls} />
        <Cell label="Destructive attempts" value={metrics.destructiveAttempts} />
        <Cell label="Challenged" value={metrics.challenged} />
        <Cell label="Denied" value={metrics.denied} />
      </div>

      <div
        className={`m-3 rounded-lg px-4 py-3 ${
          escapedIsBad ? "bg-escaped-bg" : "bg-allow-bg"
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={`text-sm font-medium ${
              escapedIsBad ? "text-escaped" : "text-allow"
            }`}
          >
            Executed without fresh auth
          </span>
          <span
            className={`font-mono text-2xl font-semibold tabular-nums ${
              escapedIsBad ? "text-escaped" : "text-allow"
            }`}
          >
            {escaped}
          </span>
        </div>
        <p className="mt-1 text-xs text-foreground/70">
          {escapedIsBad
            ? `${escaped} destructive ${escaped === 1 ? "action" : "actions"} ran without a recent human authentication.`
            : mode === "step-up"
              ? "No destructive action has run without a recent human authentication."
              : "None yet — but blanket mode does not check, so this can climb."}
        </p>
      </div>
    </Panel>
  );
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}
