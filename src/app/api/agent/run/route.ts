import { after, NextResponse, type NextRequest } from "next/server";
import { createRun, runAgent } from "@/lib/agent";
import { newCorrelationId } from "@/lib/enforcement";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Starts an agent run.
 *
 * The run row is created first and its id returned immediately, then the loop
 * is driven after the response. The console subscribes to the run in Convex,
 * so the operator watches the timeline fill in rather than waiting on this
 * request — and a failure on the way back cannot misreport work that the
 * timeline and audit trail already record correctly.
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

  const correlationId = newCorrelationId();
  let runId;
  try {
    runId = await createRun({
      prompt,
      userId: session.subject,
      correlationId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "run_not_started",
        message:
          error instanceof Error ? error.message : "The run could not start.",
      },
      { status: 500 },
    );
  }

  after(async () => {
    try {
      await runAgent({ runId, prompt, cookieHeader, correlationId });
    } catch (error) {
      // The run's own status and timeline carry the outcome; this is a last
      // resort so a crash is not silent in the server log.
      console.error(`[run ${runId}] agent loop failed:`, error);
    }
  });

  return NextResponse.json({ runId, correlationId }, { status: 202 });
}
