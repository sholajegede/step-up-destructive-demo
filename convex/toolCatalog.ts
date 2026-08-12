/**
 * The tool catalog and the registry invariant.
 *
 * Plain TypeScript on purpose: the Convex seed mutation, the Next.js server,
 * and the registry test all import this same module, so there is one
 * definition of what a tool is and one definition of what makes the registry
 * valid.
 */

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
  /**
   * Freshness window in seconds. Present on destructive tools, absent on safe
   * tools. See `assertRegistryInvariant`.
   */
  maxAuthAgeSeconds?: number;
  recordKind?: "invoice" | "release" | "document";
  inputSchema: Record<string, unknown>;
  enabled: boolean;
};

/** Safe tools. They read, list, and summarise. They change nothing. */
export const SAFE_TOOLS: ToolDefinition[] = [
  {
    name: "list_records",
    title: "List records",
    description:
      "List records of a given kind with their reference, title, status, and owner. Read-only.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["invoice", "release", "document"],
          description: "The kind of record to list.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    name: "get_record",
    title: "Get record",
    description:
      "Get one record by its reference, with all of its fields. Read-only.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The record reference, for example INV-1042.",
        },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    name: "summarize_records",
    title: "Summarise records",
    description:
      "Return counts and totals for records of a given kind. Read-only.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["invoice", "release", "document"],
          description: "The kind of record to summarise.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    enabled: true,
  },
];

/**
 * Destructive tools. Each one changes state that a person would want back,
 * and each one carries its own freshness window.
 *
 * The windows differ by how much damage the action does. Deleting a document
 * is recoverable from backup and gets the loosest window. Moving money and
 * shipping code to production get the tightest.
 */
export const DESTRUCTIVE_TOOLS: ToolDefinition[] = [
  {
    name: "delete_record",
    title: "Delete record",
    description:
      "Permanently delete a record by its reference. This cannot be undone from the console.",
    destructive: true,
    maxAuthAgeSeconds: 300,
    recordKind: "document",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The reference of the record to delete.",
        },
        reason: {
          type: "string",
          description: "Why the record is being deleted.",
        },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    name: "refund_payment",
    title: "Refund payment",
    description:
      "Refund a paid invoice in full to the original payment method. This moves money.",
    destructive: true,
    maxAuthAgeSeconds: 120,
    recordKind: "invoice",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The invoice reference to refund, for example INV-1042.",
        },
        reason: {
          type: "string",
          description: "Why the invoice is being refunded.",
        },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    name: "deploy_release",
    title: "Deploy release",
    description:
      "Deploy a release to an environment. A production deploy is visible to customers immediately.",
    destructive: true,
    maxAuthAgeSeconds: 120,
    recordKind: "release",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The release reference to deploy, for example REL-2026-08-03.",
        },
        environment: {
          type: "string",
          enum: ["staging", "production"],
          description: "The environment to deploy to.",
        },
      },
      required: ["ref", "environment"],
      additionalProperties: false,
    },
    enabled: true,
  },
];

export const TOOL_CATALOG: ToolDefinition[] = [
  ...SAFE_TOOLS,
  ...DESTRUCTIVE_TOOLS,
];

/**
 * The registry invariant.
 *
 * 1. A destructive tool MUST carry a positive, finite `maxAuthAgeSeconds`.
 *    Without a window there is nothing to compare `auth_time` against, and a
 *    missing window would read as "no limit" — the exact hole this build
 *    exists to close.
 * 2. A safe tool MUST NOT carry a window. A freshness window on a read-only
 *    tool is the seed of approval fatigue: it trains a person to approve
 *    prompts that did not need to exist.
 * 3. Names must be unique, since the seam resolves policy by name.
 *
 * Returns the list of violations. Empty means valid.
 */
export function registryViolations(tools: ToolDefinition[]): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      violations.push(`duplicate tool name "${tool.name}"`);
    }
    seen.add(tool.name);

    if (tool.destructive) {
      if (tool.maxAuthAgeSeconds === undefined) {
        violations.push(
          `destructive tool "${tool.name}" has no maxAuthAgeSeconds`,
        );
      } else if (
        !Number.isFinite(tool.maxAuthAgeSeconds) ||
        tool.maxAuthAgeSeconds <= 0
      ) {
        violations.push(
          `destructive tool "${tool.name}" has a non-positive maxAuthAgeSeconds ` +
            `(${tool.maxAuthAgeSeconds})`,
        );
      }
    } else if (tool.maxAuthAgeSeconds !== undefined) {
      violations.push(
        `safe tool "${tool.name}" carries maxAuthAgeSeconds ` +
          `(${tool.maxAuthAgeSeconds}); safe tools must not have a freshness window`,
      );
    }
  }

  return violations;
}

/** Throws if the registry invariant is broken. Used on every registry write. */
export function assertRegistryInvariant(tools: ToolDefinition[]): void {
  const violations = registryViolations(tools);
  if (violations.length > 0) {
    throw new Error(`Tool registry invariant broken: ${violations.join("; ")}`);
  }
}
