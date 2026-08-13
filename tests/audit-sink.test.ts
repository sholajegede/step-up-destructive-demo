import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The audit sink's contract under failure.
 *
 * Convex is mocked so the outage can be produced deterministically — the
 * point under test is what the seam is told when the store is down, not
 * whether Convex works.
 */
const mutation = vi.fn();
vi.mock("../src/lib/convex-server", () => ({
  convex: () => ({ mutation }),
}));

const ROW = {
  correlationId: "cid-1",
  userId: "kp_test",
  toolName: "delete_record",
  destructive: true,
  decision: "allow" as const,
  reason: "fresh_authentication",
  approvalMode: "step-up" as const,
  authTime: 1_700_000_000,
  authAgeSeconds: 20,
  maxAuthAgeSeconds: 300,
};

let spoolDir: string;

beforeEach(() => {
  mutation.mockReset();
  spoolDir = mkdtempSync(join(tmpdir(), "audit-spool-"));
  process.env.AUDIT_SPOOL_FILE = join(spoolDir, "spool.jsonl");
  process.env.AUDIT_WRITE_ATTEMPTS = "2";
  process.env.AUDIT_RETRY_BASE_MS = "1";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeAuditRow", () => {
  it("reports recorded when the store accepts it", async () => {
    const { writeAuditRow } = await import("../src/lib/audit-sink");
    mutation.mockResolvedValue("row-id");

    expect(await writeAuditRow(ROW)).toEqual({ durability: "recorded" });
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure rather than spooling immediately", async () => {
    const { writeAuditRow } = await import("../src/lib/audit-sink");
    mutation
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("row-id");

    expect(await writeAuditRow(ROW)).toEqual({ durability: "recorded" });
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it("spools the decision when the store stays down", async () => {
    const { writeAuditRow } = await import("../src/lib/audit-sink");
    mutation.mockRejectedValue(new Error("ECONNREFUSED"));

    const outcome = await writeAuditRow(ROW);
    expect(outcome.durability).toBe("spooled");

    // The decision is on disk in full — not a summary, not a counter.
    const spooled = JSON.parse(
      readFileSync(process.env.AUDIT_SPOOL_FILE as string, "utf8").trim(),
    );
    expect(spooled.decision).toBe("allow");
    expect(spooled.toolName).toBe("delete_record");
    expect(spooled.correlationId).toBe("cid-1");
    expect(spooled.authAgeSeconds).toBe(20);
    expect(spooled.spooledAt).toBeTypeOf("number");
  });

  it("reports lost when the spool is unwritable too", async () => {
    const { writeAuditRow } = await import("../src/lib/audit-sink");
    mutation.mockRejectedValue(new Error("ECONNREFUSED"));
    // A path whose parent does not exist cannot be appended to.
    process.env.AUDIT_SPOOL_FILE = join(spoolDir, "missing", "spool.jsonl");

    const outcome = await writeAuditRow(ROW);
    expect(outcome.durability).toBe("lost");
  });

  it("never throws — the caller needs the outcome to decide", async () => {
    const { writeAuditRow } = await import("../src/lib/audit-sink");
    mutation.mockRejectedValue(new Error("ECONNREFUSED"));
    process.env.AUDIT_SPOOL_FILE = join(spoolDir, "missing", "spool.jsonl");

    await expect(writeAuditRow(ROW)).resolves.toBeDefined();
  });
});

describe("spool replay", () => {
  it("reports the backlog while rows are waiting", async () => {
    const { writeAuditRow, spoolStatus } = await import(
      "../src/lib/audit-sink"
    );
    mutation.mockRejectedValue(new Error("down"));
    await writeAuditRow(ROW);
    await writeAuditRow({ ...ROW, correlationId: "cid-2" });

    const status = await spoolStatus();
    expect(status.pending).toBe(2);
    expect(status.oldestSpooledAt).toBeTypeOf("number");
  });

  it("replays spooled rows once the store returns", async () => {
    const { writeAuditRow, drainAuditSpool, spoolStatus } = await import(
      "../src/lib/audit-sink"
    );

    mutation.mockRejectedValue(new Error("down"));
    await writeAuditRow(ROW);
    await writeAuditRow({ ...ROW, correlationId: "cid-2" });

    mutation.mockReset();
    mutation.mockResolvedValue("row-id");

    const drained = await drainAuditSpool();
    expect(drained.replayed).toBe(2);
    expect(drained.remaining).toBe(0);
    expect((await spoolStatus()).pending).toBe(0);

    // The replayed row is the decision as taken, without the spool marker.
    const replayed = mutation.mock.calls[0][1];
    expect(replayed.decision).toBe("allow");
    expect(replayed.spooledAt).toBeUndefined();
  });

  it("keeps rows that still fail on replay", async () => {
    const { writeAuditRow, drainAuditSpool, spoolStatus } = await import(
      "../src/lib/audit-sink"
    );

    mutation.mockRejectedValue(new Error("down"));
    await writeAuditRow(ROW);

    const drained = await drainAuditSpool();
    expect(drained.replayed).toBe(0);
    expect(drained.remaining).toBe(1);
    // Still on disk, still replayable — never discarded.
    expect((await spoolStatus()).pending).toBe(1);
  });

  it("is a no-op when nothing is spooled", async () => {
    const { drainAuditSpool } = await import("../src/lib/audit-sink");
    expect(existsSync(process.env.AUDIT_SPOOL_FILE as string)).toBe(false);
    expect(await drainAuditSpool()).toEqual({ replayed: 0, remaining: 0 });
  });
});
