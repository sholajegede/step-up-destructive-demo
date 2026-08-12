import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  TOOL_CATALOG,
  assertRegistryInvariant,
  registryViolations,
  type ToolDefinition,
} from "./toolCatalog";

/** All enabled tools, safe and destructive. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const tools = await ctx.db.query("tools").collect();
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** One tool by name. Returns null when the name is not registered. */
export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
  },
});

/**
 * Re-checks the invariant against the rows actually stored, not against the
 * catalog in source. A registry that passes in TypeScript but was written
 * badly by hand is still a broken registry.
 */
export const validateRegistry = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tools").collect();
    const asDefinitions: ToolDefinition[] = rows.map((row) => ({
      name: row.name,
      title: row.title,
      description: row.description,
      destructive: row.destructive,
      maxAuthAgeSeconds: row.maxAuthAgeSeconds,
      inputSchema: row.inputSchema,
      enabled: row.enabled,
    }));
    const violations = registryViolations(asDefinitions);
    return {
      count: rows.length,
      destructiveCount: rows.filter((r) => r.destructive).length,
      safeCount: rows.filter((r) => !r.destructive).length,
      violations,
      valid: violations.length === 0,
    };
  },
});

/**
 * Writes the catalog into the registry, replacing what is there.
 *
 * The invariant is asserted before the first write, so a bad catalog never
 * reaches the database in a half-applied state.
 */
export const seedRegistry = mutation({
  args: {},
  handler: async (ctx) => {
    assertRegistryInvariant(TOOL_CATALOG);

    const existing = await ctx.db.query("tools").collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }

    for (const tool of TOOL_CATALOG) {
      await ctx.db.insert("tools", {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        destructive: tool.destructive,
        maxAuthAgeSeconds: tool.maxAuthAgeSeconds,
        recordKind: tool.recordKind,
        inputSchema: tool.inputSchema,
        enabled: tool.enabled,
      });
    }

    return { seeded: TOOL_CATALOG.length };
  },
});
