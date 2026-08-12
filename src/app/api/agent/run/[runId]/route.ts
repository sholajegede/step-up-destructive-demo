import { NextResponse } from "next/server";
import { api } from "../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import { convex } from "@/lib/convex-server";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Returns one run and its event stream.
 *
 * A run is readable only by the person it belongs to, compared on the subject
 * from their verified session.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await readSession();
  if (session === null) {
    return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
  }

  const { runId } = await context.params;
  const run = await convex().query(api.runs.get, {
    runId: runId as Id<"runs">,
  });
  if (run === null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (run.userId !== session.subject) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [events, audit] = await Promise.all([
    convex().query(api.runs.events, { runId: runId as Id<"runs"> }),
    convex().query(api.audit.byCorrelationId, {
      correlationId: run.correlationId,
    }),
  ]);

  return NextResponse.json({ run, events, audit });
}
