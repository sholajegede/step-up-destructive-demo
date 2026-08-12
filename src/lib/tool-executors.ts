import { api } from "../../convex/_generated/api";
import { convex } from "./convex-server";

/**
 * What each tool actually does, once the seam has released it.
 *
 * Nothing here consults the approval mode, the token, or `auth_time`. By the
 * time an executor runs, the decision has already been made. Keeping the
 * check out of these functions means there is exactly one place a destructive
 * action can be released, rather than a policy check repeated in six.
 */

export type ToolArgs = Record<string, unknown>;

type RecordKind = "invoice" | "release" | "document";

function requireString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Tool argument "${key}" is required.`);
  }
  return value.trim();
}

function requireKind(args: ToolArgs): RecordKind {
  const kind = requireString(args, "kind");
  if (kind !== "invoice" && kind !== "release" && kind !== "document") {
    throw new Error(`Unknown record kind "${kind}".`);
  }
  return kind;
}

const executors: Record<string, (args: ToolArgs) => Promise<unknown>> = {
  list_records: async (args) =>
    await convex().query(api.records.list, { kind: requireKind(args) }),

  get_record: async (args) =>
    await convex().query(api.records.getByRef, {
      ref: requireString(args, "ref"),
    }),

  summarize_records: async (args) =>
    await convex().query(api.records.summarize, { kind: requireKind(args) }),

  delete_record: async (args) =>
    await convex().mutation(api.records.softDelete, {
      ref: requireString(args, "ref"),
    }),

  refund_payment: async (args) =>
    await convex().mutation(api.records.refund, {
      ref: requireString(args, "ref"),
    }),

  deploy_release: async (args) => {
    const environment = requireString(args, "environment");
    if (environment !== "staging" && environment !== "production") {
      throw new Error(`Unknown environment "${environment}".`);
    }
    return await convex().mutation(api.records.deploy, {
      ref: requireString(args, "ref"),
      environment,
    });
  },
};

export function hasExecutor(toolName: string): boolean {
  return Object.hasOwn(executors, toolName);
}

/** Runs a tool. Only ever called after the seam has allowed it. */
export async function executeTool(
  toolName: string,
  args: ToolArgs,
): Promise<unknown> {
  const executor = executors[toolName];
  if (executor === undefined) {
    throw new Error(`No executor registered for tool "${toolName}".`);
  }
  return await executor(args);
}
