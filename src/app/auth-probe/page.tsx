import { Suspense } from "react";
import { getSessionView } from "@/lib/session-view";
import { AuthProbe } from "./auth-probe";

export const dynamic = "force-dynamic";

/**
 * The observation surface for the authentication behaviour this build rests
 * on. Not the product UI — this exists so the claims can be watched directly.
 *
 * The session is read and verified on the server and handed down, so the
 * page renders the real claims on first paint with no client-side fetch.
 */
export default async function AuthProbePage() {
  const session = await getSessionView();
  return (
    <Suspense fallback={null}>
      <AuthProbe session={session} />
    </Suspense>
  );
}
