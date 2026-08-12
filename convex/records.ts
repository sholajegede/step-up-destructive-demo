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
