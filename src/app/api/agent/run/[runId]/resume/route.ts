import { NextResponse, type NextRequest } from "next/server";
import { resumeAgent } from "@/lib/agent";
import type { Id } from "../../../../../../../convex/_generated/dataModel";
import { verifyIdToken } from "@/lib/jwt";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Resumes a run that a step-up challenge paused.
 *
 * This route does not decide whether the held action may run. It re-presents
 * the held call to the seam under the original correlationId, and the seam
 * re-reads `auth_time` from the token on that request and decides. A resume
 * without a genuine re-authentication therefore meets the same refusal as the
 * original attempt — there is no path through this route that releases an
 * action the seam would not release on its own.
 *
 * The `auth_time` read here is for the audit narrative only, and is read from
 * a verified token rather than taken from the caller.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await readSession();
  if (session === null) {
    return NextResponse.json(
      { error: "not_signed_in", message: "Sign in before resuming a run." },
      { status: 401 },
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

  // Observational only. If the ID token does not verify, the resume still
  // proceeds — and the seam will refuse it, which is the correct outcome.
  let observedAuthTime: number | undefined;
  if (session.idToken !== undefined) {
    try {
      observedAuthTime = (await verifyIdToken(session.idToken)).auth_time;
    } catch {
      observedAuthTime = undefined;
    }
  }

  const { runId } = await context.params;

  try {
    const outcome = await resumeAgent({
      runId: runId as Id<"runs">,
      userId: session.subject,
      cookieHeader,
      observedAuthTime,
    });

    if ("error" in outcome) {
      return NextResponse.json(outcome, {
        status: outcome.error === "not_found" ? 404 : 409,
      });
    }

    // A resume that the seam refused again is reported as 403, so a caller
    // cannot mistake "still held" for "released".
    return NextResponse.json(outcome, {
      status: outcome.status === "halted" ? 403 : 200,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "resume_failed",
        message: error instanceof Error ? error.message : "The resume failed.",
      },
      { status: 500 },
    );
  }
}
