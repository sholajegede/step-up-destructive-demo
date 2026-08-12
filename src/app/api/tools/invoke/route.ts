import { NextResponse, type NextRequest } from "next/server";
import { enforceToolCall, newCorrelationId } from "@/lib/enforcement";
import { readSession } from "@/lib/session";
import { executeTool, type ToolArgs } from "@/lib/tool-executors";

export const dynamic = "force-dynamic";

/**
 * The single entry point for tool calls.
 *
 * Every call passes through `enforceToolCall` before anything is executed.
 * There is no branch here that reaches an executor without a decision, and no
 * way for a caller to influence which mode the decision is made in — the
 * approval mode is read from the deploy environment inside the seam.
 *
 * Tokens come from the encrypted session cookie. A caller cannot present
 * tokens of their own choosing on the request, so an agent cannot swap in an
 * ID token it found somewhere to manufacture freshness.
 */
export async function POST(request: NextRequest) {
  let body: { tool?: unknown; args?: unknown; correlationId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Body must be JSON." },
      { status: 400 },
    );
  }

  if (typeof body.tool !== "string" || body.tool === "") {
    return NextResponse.json(
      { error: "tool_required", message: "A tool name is required." },
      { status: 400 },
    );
  }

  const args: ToolArgs =
    typeof body.args === "object" && body.args !== null
      ? (body.args as ToolArgs)
      : {};

  const correlationId =
    typeof body.correlationId === "string" && body.correlationId !== ""
      ? body.correlationId
      : newCorrelationId();

  const session = await readSession();

  const result = await enforceToolCall({
    toolName: body.tool,
    accessToken: session?.accessToken,
    idToken: session?.idToken,
    correlationId,
    recordRef: typeof args.ref === "string" ? args.ref : undefined,
  });

  const summary = {
    tool: body.tool,
    decision: result.decision,
    reason: result.reason,
    message: result.message,
    correlationId: result.correlationId,
    approvalMode: result.approvalMode,
    destructive: result.destructive,
    authAgeSeconds: result.authAgeSeconds,
    maxAuthAgeSeconds: result.maxAuthAgeSeconds,
  };

  if (result.decision === "challenge") {
    // RFC 9470 shape: 403 with insufficient_user_authentication and the
    // max_age the resource server needs satisfied.
    return NextResponse.json(
      {
        ...summary,
        error: "insufficient_user_authentication",
        // Where the caller sends the human to fix it. The parameters are a
        // hint to the provider; the proof is re-checked here on the retry.
        reauthUrl: `/api/auth/login?max_age=0&prompt=login&stepUp=1&returnTo=%2Ftools`,
      },
      {
        status: 403,
        headers:
          result.challengeHeader === undefined
            ? undefined
            : { "WWW-Authenticate": result.challengeHeader },
      },
    );
  }

  if (result.decision === "deny") {
    return NextResponse.json(
      { ...summary, error: result.reason },
      { status: result.reason === "token_invalid" ? 401 : 403 },
    );
  }

  try {
    const output = await executeTool(body.tool, args);
    return NextResponse.json({ ...summary, executed: true, result: output });
  } catch (error) {
    // The call was authorised; the tool itself failed. Reported as an
    // execution failure, not as a policy decision, and the audit row already
    // written correctly records that the call was allowed.
    return NextResponse.json(
      {
        ...summary,
        executed: false,
        error: "execution_failed",
        message: error instanceof Error ? error.message : "Tool failed.",
      },
      { status: 500 },
    );
  }
}
