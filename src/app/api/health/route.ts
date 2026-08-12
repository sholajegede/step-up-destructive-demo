import { NextResponse } from "next/server";
import { approvalMode, configPresence } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Liveness and configuration-presence probe.
 *
 * Reports whether each configuration group is populated. It never reports a
 * configuration value. The resolved approval mode is included because it is
 * read-only here — this route reports the server's decision, it does not
 * accept one.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "step-up-destructive-demo",
    approvalMode: approvalMode(),
    config: configPresence(),
    time: new Date().toISOString(),
  });
}
