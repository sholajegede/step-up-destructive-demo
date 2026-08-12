import { NextResponse } from "next/server";
import { getSessionView } from "@/lib/session-view";

export const dynamic = "force-dynamic";

/** Reports the signed-in person's verified claims. No token material. */
export async function GET() {
  return NextResponse.json(await getSessionView());
}
