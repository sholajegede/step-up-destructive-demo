import { NextResponse, type NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";
import { newCorrelationId } from "@/lib/enforcement";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Long-horizon tool loops need more than the default serverless budget. */
export const maxDuration = 300;

/**
 * Starts an agent run.
 *
 * The run carries the caller's own session. There is no service account and
 * no agent credential: the cookie header is forwarded to the seam unchanged,
 * so the agent can do exactly what the signed-in person could do, and nothing
 * more.
 */
export async function POST(request: NextRequest) {
  const session = await readSession();
  if (session === null) {
    return NextResponse.json(
      { error: "not_signed_in", message: "Sign in before starting a run." },
      { status: 401 },
    );
  }

  let body: { prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Body must be JSON." },
      { status: 400 },
    );
  }

  const prompt =
    typeof body.prompt === "string" && body.prompt.trim() !== ""
      ? body.prompt.trim()
      : null;
  if (prompt === null) {
    return NextResponse.json(
      { error: "prompt_required", message: "A prompt is required." },
      { status: 400 },
    );
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader === null) {
    return NextResponse.json(
      {
        error: "no_session_cookie",
        message: "The request carried no session cookie.",
      },
      { status: 401 },
    );
  }

  try {
    const outcome = await runAgent({
      prompt,
      userId: session.subject,
      cookieHeader,
      correlationId: newCorrelationId(),
    });
    return NextResponse.json(outcome);
  } catch (error) {
    return NextResponse.json(
      {
        error: "agent_failed",
        message: error instanceof Error ? error.message : "The run failed.",
      },
      { status: 500 },
    );
  }
}
