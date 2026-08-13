import { NextResponse } from "next/server";
import { drainAuditSpool, spoolStatus } from "@/lib/audit-sink";
import { approvalMode, configPresence } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Liveness, configuration presence, and audit-trail health.
 *
 * Reports whether each configuration group is populated, never a
 * configuration value. The resolved approval mode is included because this
 * route reports the server's decision; it does not accept one.
 *
 * Hitting this route also drains any spooled audit rows. A health check is
 * the natural place to reconcile: it runs regularly, it is cheap when the
 * spool is empty, and it means an outage heals without anyone intervening.
 * `audit.degraded` stays true while rows are still waiting, so the gap is
 * visible rather than silent.
 */
export async function GET() {
  let drained = { replayed: 0, remaining: 0 };
  try {
    drained = await drainAuditSpool();
  } catch {
    // A failed drain must not fail the health check; the spool status below
    // still reports the backlog.
  }

  const spool = await spoolStatus().catch(() => ({
    pending: -1,
    path: "unavailable",
  }));

  return NextResponse.json({
    status: "ok",
    service: "step-up-destructive-demo",
    approvalMode: approvalMode(),
    config: configPresence(),
    audit: {
      degraded: spool.pending !== 0,
      pendingRows: spool.pending,
      oldestSpooledAt:
        "oldestSpooledAt" in spool ? spool.oldestSpooledAt : undefined,
      replayedNow: drained.replayed,
    },
    time: new Date().toISOString(),
  });
}
