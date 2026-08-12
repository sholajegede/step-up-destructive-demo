import { describe, expect, it } from "vitest";
import {
  DESTRUCTIVE_TOOLS,
  SAFE_TOOLS,
  TOOL_CATALOG,
  registryViolations,
  type ToolDefinition,
} from "../convex/toolCatalog";

describe("tool registry", () => {
  it("holds both safe and destructive tools", () => {
    expect(SAFE_TOOLS.length).toBeGreaterThan(0);
    expect(DESTRUCTIVE_TOOLS.length).toBeGreaterThan(0);
    expect(TOOL_CATALOG).toHaveLength(
      SAFE_TOOLS.length + DESTRUCTIVE_TOOLS.length,
    );
  });

  it("gives every destructive tool a positive freshness window", () => {
    for (const tool of DESTRUCTIVE_TOOLS) {
      expect(tool.destructive).toBe(true);
      expect(
        tool.maxAuthAgeSeconds,
        `destructive tool "${tool.name}" must declare maxAuthAgeSeconds`,
      ).toBeTypeOf("number");
      expect(tool.maxAuthAgeSeconds!).toBeGreaterThan(0);
      expect(Number.isFinite(tool.maxAuthAgeSeconds!)).toBe(true);
    }
  });

  it("gives no safe tool a freshness window", () => {
    for (const tool of SAFE_TOOLS) {
      expect(tool.destructive).toBe(false);
      expect(
        tool.maxAuthAgeSeconds,
        `safe tool "${tool.name}" must not declare maxAuthAgeSeconds`,
      ).toBeUndefined();
    }
  });

  it("names every tool uniquely", () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("passes its own invariant check", () => {
    expect(registryViolations(TOOL_CATALOG)).toEqual([]);
  });

  it("covers delete, refund, and deploy as destructive", () => {
    const destructiveNames = DESTRUCTIVE_TOOLS.map((t) => t.name);
    expect(destructiveNames).toContain("delete_record");
    expect(destructiveNames).toContain("refund_payment");
    expect(destructiveNames).toContain("deploy_release");
  });

  it("covers read, list, and summarise as safe", () => {
    const safeNames = SAFE_TOOLS.map((t) => t.name);
    expect(safeNames).toContain("get_record");
    expect(safeNames).toContain("list_records");
    expect(safeNames).toContain("summarize_records");
  });
});

describe("registry invariant", () => {
  const base: ToolDefinition = {
    name: "example",
    title: "Example",
    description: "Example tool.",
    destructive: false,
    inputSchema: { type: "object", properties: {} },
    enabled: true,
  };

  it("rejects a destructive tool with no window", () => {
    const violations = registryViolations([
      { ...base, name: "drop_everything", destructive: true },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("has no maxAuthAgeSeconds");
  });

  it("rejects a destructive tool with a zero or negative window", () => {
    for (const bad of [0, -1]) {
      const violations = registryViolations([
        {
          ...base,
          name: "drop_everything",
          destructive: true,
          maxAuthAgeSeconds: bad,
        },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("non-positive");
    }
  });

  it("rejects a safe tool that carries a window", () => {
    const violations = registryViolations([
      { ...base, name: "just_reading", maxAuthAgeSeconds: 60 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("must not have a freshness window");
  });

  it("rejects duplicate names", () => {
    const violations = registryViolations([base, base]);
    expect(violations).toContain('duplicate tool name "example"');
  });

  it("accepts a well-formed pair", () => {
    expect(
      registryViolations([
        base,
        {
          ...base,
          name: "careful_delete",
          destructive: true,
          maxAuthAgeSeconds: 300,
        },
      ]),
    ).toEqual([]);
  });
});
