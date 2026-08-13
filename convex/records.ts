import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const recordKind = v.union(
  v.literal("invoice"),
  v.literal("release"),
  v.literal("document"),
);

/** The rows the demo acts on. Nothing here is secret or personal. */
const SEED_RECORDS = [
  {
    kind: "invoice" as const,
    ref: "INV-1042",
    title: "Northwind Logistics — August retainer",
    status: "paid",
    owner: "billing@northwind.example",
    amountCents: 480000,
    summary: "Monthly retainer, paid in full on 2026-08-01.",
  },
  {
    kind: "invoice" as const,
    ref: "INV-1043",
    title: "Harbour Analytics — seat expansion",
    status: "paid",
    owner: "ap@harbour.example",
    amountCents: 129900,
    summary: "Twelve extra seats, paid on 2026-08-04.",
  },
  {
    kind: "invoice" as const,
    ref: "INV-1044",
    title: "Beacon Foods — annual plan",
    status: "open",
    owner: "finance@beacon.example",
    amountCents: 1740000,
    summary: "Annual plan, due 2026-08-30.",
  },
  {
    kind: "release" as const,
    ref: "REL-2026-08-03",
    title: "Checkout service 4.2.0",
    status: "staged",
    owner: "platform-team",
    environment: "staging",
    summary: "Adds idempotency keys to the payment capture path.",
  },
  {
    kind: "release" as const,
    ref: "REL-2026-08-07",
    title: "Search indexer 1.9.3",
    status: "staged",
    owner: "search-team",
    environment: "staging",
    summary: "Rebuilds the synonym dictionary. Needs a full reindex.",
  },
  {
    kind: "document" as const,
    ref: "DOC-3301",
    title: "Q3 pricing model",
    status: "active",
    owner: "revops",
    summary: "Working model for the Q3 price change. One copy only.",
  },
  {
    kind: "document" as const,
    ref: "DOC-3302",
    title: "Incident review — 2026-07-19 outage",
    status: "active",
    owner: "sre",
    summary: "Post-incident review, referenced by three open actions.",
  },
  {
    kind: "document" as const,
    ref: "DOC-3303",
    title: "Vendor contract — Northwind",
    status: "archived",
    owner: "legal",
    summary: "Superseded by the 2026 master agreement.",
  },
];

export const list = query({
  args: { kind: v.optional(recordKind), includeDeleted: v.optional(v.boolean()) },
  handler: async (ctx, { kind, includeDeleted }) => {
    const rows = kind
      ? await ctx.db
          .query("records")
          .withIndex("by_kind", (q) => q.eq("kind", kind))
          .collect()
      : await ctx.db.query("records").collect();
    const visible = includeDeleted
      ? rows
      : rows.filter((r) => r.deletedAt === undefined);
    return visible.sort((a, b) => a.ref.localeCompare(b.ref));
  },
});

export const getByRef = query({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => {
    return await ctx.db
      .query("records")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .unique();
  },
});

/** Counts and totals for one kind. Read-only. */
export const summarize = query({
  args: { kind: recordKind },
  handler: async (ctx, { kind }) => {
    const rows = await ctx.db
      .query("records")
      .withIndex("by_kind", (q) => q.eq("kind", kind))
      .collect();
    const live = rows.filter((r) => r.deletedAt === undefined);
    return {
      kind,
      total: live.length,
      deleted: rows.length - live.length,
      byStatus: live.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
      totalAmountCents: live.reduce((sum, r) => sum + (r.amountCents ?? 0), 0),
    };
  },
});

/**
 * Marks a record deleted.
 *
 * Soft on purpose: an action that slipped through must stay visible in the
 * console and in the audit trail rather than disappearing.
 */
export const softDelete = mutation({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => {
    const row = await ctx.db
      .query("records")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .unique();
    if (row === null) throw new Error(`No record ${ref}`);
    if (row.deletedAt !== undefined) {
      return { ref, alreadyDeleted: true, deletedAt: row.deletedAt };
    }
    const deletedAt = Date.now();
    await ctx.db.patch(row._id, { deletedAt, status: "deleted" });
    return { ref, alreadyDeleted: false, deletedAt };
  },
});

export const refund = mutation({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => {
    const row = await ctx.db
      .query("records")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .unique();
    if (row === null) throw new Error(`No record ${ref}`);
    if (row.kind !== "invoice") throw new Error(`${ref} is not an invoice`);
    if (row.refundedAt !== undefined) {
      return { ref, alreadyRefunded: true, refundedAt: row.refundedAt };
    }
    const refundedAt = Date.now();
    await ctx.db.patch(row._id, { refundedAt, status: "refunded" });
    return {
      ref,
      alreadyRefunded: false,
      refundedAt,
      amountCents: row.amountCents,
    };
  },
});

export const deploy = mutation({
  args: { ref: v.string(), environment: v.string() },
  handler: async (ctx, { ref, environment }) => {
    const row = await ctx.db
      .query("records")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .unique();
    if (row === null) throw new Error(`No record ${ref}`);
    if (row.kind !== "release") throw new Error(`${ref} is not a release`);
    const deployedAt = Date.now();
    await ctx.db.patch(row._id, {
      deployedAt,
      environment,
      status: `deployed:${environment}`,
    });
    return { ref, environment, deployedAt };
  },
});

/**
 * Resets the demo to a clean slate: records restored, and the run history and
 * audit trail cleared.
 *
 * The audit trail is cleared here because these counters are
 * deployment-wide — without a reset, one earlier blanket-mode run leaves
 * `executedWithoutFreshAuth` permanently non-zero and the operator can never
 * see the number that step-up is supposed to hold at zero.
 *
 * This is a demo affordance, and the only thing in the build that deletes an
 * audit row. Nothing on the agent's path can reach it: it is not a registered
 * tool, so the seam never brokers it and the model cannot call it.
 */
export const resetDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const tables = ["auditLog", "runEvents", "runs", "records"] as const;
    const cleared: Record<string, number> = {};

    for (const table of tables) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
      }
      cleared[table] = rows.length;
    }

    for (const record of SEED_RECORDS) {
      await ctx.db.insert("records", record);
    }

    return { cleared, seeded: SEED_RECORDS.length };
  },
});

export const seedRecords = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("records").collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    for (const record of SEED_RECORDS) {
      await ctx.db.insert("records", record);
    }
    return { seeded: SEED_RECORDS.length };
  },
});
