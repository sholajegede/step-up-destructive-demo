"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Empty, Mono, Panel, Skeleton, type Tone } from "./ui";

type RecordKind = "invoice" | "release" | "document";

const KINDS: { key: RecordKind; label: string }[] = [
  { key: "document", label: "Documents" },
  { key: "invoice", label: "Invoices" },
  { key: "release", label: "Releases" },
];

/**
 * What the agent can read, and what a released destructive action changed.
 *
 * Deleted rows stay visible rather than vanishing — an action that got
 * through is the thing most worth being able to see afterwards.
 */
export function RecordsPanel() {
  const [kind, setKind] = useState<RecordKind>("document");
  const [reseeding, setReseeding] = useState(false);
  const records = useQuery(api.records.list, {
    kind,
    includeDeleted: true,
  });
  const reset = useMutation(api.records.resetDemo);

  const resetDemo = async () => {
    setReseeding(true);
    try {
      await reset({});
    } finally {
      setReseeding(false);
    }
  };

  return (
    <Panel
      title="Records"
      subtitle="Live. Changes appear the moment an action is released."
      action={
        <Button
          variant="secondary"
          onClick={resetDemo}
          disabled={reseeding}
          className="shrink-0 px-2.5 py-1 text-xs"
        >
          {reseeding ? "Resetting…" : "Reset demo"}
        </Button>
      }
    >
      <div className="flex gap-1 border-b border-line px-3 py-2">
        {KINDS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setKind(option.key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              kind === option.key
                ? "bg-surface-muted text-foreground"
                : "text-muted hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {records === undefined ? (
        <Skeleton rows={3} />
      ) : records.length === 0 ? (
        <Empty>
          No {kind} records. Use “Reset demo” to restore the sample set.
        </Empty>
      ) : (
        <ul className="divide-y divide-line">
          {records.map((record) => {
            const changed =
              record.deletedAt !== undefined ||
              record.refundedAt !== undefined ||
              record.deployedAt !== undefined;
            return (
              <li
                key={record._id}
                className={`px-4 py-3 ${changed ? "bg-surface-muted/60" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Mono className="text-muted">{record.ref}</Mono>
                      <StatusBadge record={record} />
                    </div>
                    <p
                      className={`mt-1 truncate text-sm ${
                        record.deletedAt !== undefined
                          ? "text-muted line-through"
                          : ""
                      }`}
                    >
                      {record.title}
                    </p>
                    {record.summary !== undefined && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {record.summary}
                      </p>
                    )}
                  </div>
                  {record.amountCents !== undefined && (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                      {(record.amountCents / 100).toLocaleString(undefined, {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function StatusBadge({
  record,
}: {
  record: {
    status: string;
    deletedAt?: number;
    refundedAt?: number;
    deployedAt?: number;
  };
}) {
  let tone: Tone = "neutral";
  if (record.deletedAt !== undefined) tone = "deny";
  else if (record.refundedAt !== undefined || record.deployedAt !== undefined)
    tone = "challenge";
  return <Badge tone={tone}>{record.status}</Badge>;
}
