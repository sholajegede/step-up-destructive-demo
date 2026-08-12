import { ConvexHttpClient } from "convex/browser";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";

/**
 * The same invariant, checked against the rows that are actually stored.
 *
 * The catalog test proves the source is correct. This proves the deployment
 * is correct, which is the thing the enforcement seam will read at runtime.
 */
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

describe.skipIf(!convexUrl)("registry as deployed", () => {
  let client: ConvexHttpClient;
  type StoredTool = {
    name: string;
    destructive: boolean;
    maxAuthAgeSeconds?: number;
  };
  let tools: StoredTool[];

  beforeAll(async () => {
    client = new ConvexHttpClient(convexUrl!);
    tools = (await client.query(api.tools.list, {})) as StoredTool[];
  });

  it("has been seeded", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.destructive)).toBe(true);
    expect(tools.some((t) => !t.destructive)).toBe(true);
  });

  it("stores a positive freshness window on every destructive tool", () => {
    for (const tool of tools.filter((t) => t.destructive)) {
      expect(
        tool.maxAuthAgeSeconds,
        `stored destructive tool "${tool.name}" has no maxAuthAgeSeconds`,
      ).toBeTypeOf("number");
      expect(tool.maxAuthAgeSeconds!).toBeGreaterThan(0);
    }
  });

  it("stores no freshness window on any safe tool", () => {
    for (const tool of tools.filter((t) => !t.destructive)) {
      expect(
        tool.maxAuthAgeSeconds,
        `stored safe tool "${tool.name}" carries a maxAuthAgeSeconds`,
      ).toBeUndefined();
    }
  });

  it("reports itself valid from the server side", async () => {
    const result = await client.query(api.tools.validateRegistry, {});
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.destructiveCount).toBeGreaterThan(0);
    expect(result.safeCount).toBeGreaterThan(0);
  });
});
