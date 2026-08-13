import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { api } from "../../convex/_generated/api";
import { convex } from "./convex-server";
import { auditConfig } from "./env";

/**
 * Durable audit writes.
 *
 * The audit row is the security record: it is the only evidence that a
 * decision was taken and what it was. Phase 3 found the gap — when Convex was
 * briefly unreachable the seam failed closed, which was right, but wrote no
 * row, so a refusal happened with no record that it had. A control that
 * silently stops recording is indistinguishable from one that stopped
 * working.
 *
 * The write therefore goes through three stages, in order:
 *
 *   1. Convex, retried briefly with backoff — covers a blip.
 *   2. A local append-only spool — covers a longer outage. The decision is
 *      recorded, out of process, and replayable.
 *   3. Neither — the decision is unrecordable, and the caller must fail
 *      closed.
 *
 * Stage 2 is a floor, not a finished answer: the spool lives on one host and
 * does not survive that host. A real deployment wants a durable queue with
 * its own availability story. What it buys here is that a decision is never
 * *silently* lost — it is either in Convex, in the spool, or refused.
 */

export type AuditRow = {
  correlationId: string;
  userId: string;
  toolName: string;
  destructive: boolean;
  decision: "allow" | "challenge" | "deny";
  reason: string;
  approvalMode: "blanket" | "step-up";
  authTime?: number;
  authAgeSeconds?: number;
  maxAuthAgeSeconds?: number;
  amr?: string[];
  tokenId?: string;
  recordRef?: string;
};

export type AuditOutcome =
  /** Landed in the audit store. */
  | { durability: "recorded" }
  /** The store is down; the row is on disk and replayable. */
  | { durability: "spooled"; error: string }
  /** Nowhere. The caller must fail closed. */
  | { durability: "lost"; error: string };

function spoolPath(): string {
  return resolve(process.cwd(), auditConfig().spoolFile);
}

const sleep = (ms: number) =>
  new Promise((resolve_) => setTimeout(resolve_, ms));

/**
 * Writes one audit row.
 *
 * Never throws: the caller needs the outcome in order to decide whether it is
 * still safe to proceed, and an exception here would lose that distinction.
 */
export async function writeAuditRow(row: AuditRow): Promise<AuditOutcome> {
  const { writeAttempts, retryBaseMs } = auditConfig();
  let lastError = "unknown";

  for (let attempt = 1; attempt <= writeAttempts; attempt += 1) {
    try {
      await convex().mutation(api.audit.record, row);
      return { durability: "recorded" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < writeAttempts) {
        await sleep(retryBaseMs * 2 ** (attempt - 1));
      }
    }
  }

  try {
    await appendFile(
      spoolPath(),
      `${JSON.stringify({ ...row, spooledAt: Date.now() })}\n`,
      "utf8",
    );
    console.error(
      `[audit] sink unavailable, row spooled locally (${row.decision}/${row.reason} on ${row.toolName}): ${lastError}`,
    );
    return { durability: "spooled", error: lastError };
  } catch (spoolError) {
    const message =
      spoolError instanceof Error ? spoolError.message : String(spoolError);
    console.error(
      `[audit] SINK AND SPOOL BOTH UNAVAILABLE — decision cannot be recorded: ${message}`,
    );
    return { durability: "lost", error: `${lastError}; spool: ${message}` };
  }
}

export type SpoolStatus = {
  pending: number;
  oldestSpooledAt?: number;
  path: string;
};

/** How many decisions are waiting to be replayed. */
export async function spoolStatus(): Promise<SpoolStatus> {
  const path = spoolPath();
  try {
    await stat(path);
  } catch {
    return { pending: 0, path };
  }

  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");

  let oldest: number | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { spooledAt?: number };
      if (
        parsed.spooledAt !== undefined &&
        (oldest === undefined || parsed.spooledAt < oldest)
      ) {
        oldest = parsed.spooledAt;
      }
    } catch {
      // A torn line still counts as pending; it is not silently dropped.
    }
  }

  return { pending: lines.length, oldestSpooledAt: oldest, path };
}

/**
 * Replays spooled rows into the audit store.
 *
 * The spool is claimed by rename before replay, so a concurrent writer
 * appending to a fresh file cannot have its rows dropped by this drain. Rows
 * that still fail are written back for the next attempt.
 */
export async function drainAuditSpool(): Promise<{
  replayed: number;
  remaining: number;
}> {
  const path = spoolPath();
  try {
    await stat(path);
  } catch {
    return { replayed: 0, remaining: 0 };
  }

  const claimed = `${path}.draining`;
  try {
    await rename(path, claimed);
  } catch {
    // Another drain already claimed it.
    return { replayed: 0, remaining: (await spoolStatus()).pending };
  }

  const lines = (await readFile(claimed, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");

  const failed: string[] = [];
  let replayed = 0;

  for (const line of lines) {
    let row: AuditRow;
    try {
      const parsed = JSON.parse(line) as AuditRow & { spooledAt?: number };
      delete (parsed as { spooledAt?: number }).spooledAt;
      row = parsed;
    } catch {
      // Unparseable: keep it rather than discard evidence.
      failed.push(line);
      continue;
    }

    try {
      await convex().mutation(api.audit.record, row);
      replayed += 1;
    } catch {
      failed.push(line);
    }
  }

  if (failed.length > 0) {
    await appendFile(path, `${failed.join("\n")}\n`, "utf8");
  }
  await writeFile(claimed, "", "utf8").catch(() => {});
  await rename(claimed, `${claimed}.done`).catch(() => {});

  return { replayed, remaining: failed.length };
}
