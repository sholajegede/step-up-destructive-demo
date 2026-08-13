import { Suspense } from "react";
import { Console } from "@/components/console";
import { approvalMode } from "@/lib/env";
import { getSessionView } from "@/lib/session-view";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Resolved on the server from the deploy environment. It is rendered for
  // the operator to see and is never accepted from the browser.
  const mode = approvalMode();
  const session = await getSessionView();

  if (session.signedIn !== true) {
    return <SignIn />;
  }

  const claims = session.idToken ?? session.accessToken;

  return (
    <Suspense fallback={null}>
      <Console
        mode={mode}
        userId={claims?.sub ?? ""}
        email={claims?.email}
      />
    </Suspense>
  );
}

function SignIn() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8">
        <h1 className="text-xl font-semibold tracking-tight">
          Records Console
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          An agent runs read-only tools freely and is held at every destructive
          action until you prove you are present. Sign in to give it a task.
        </p>
        <a
          href="/api/auth/login?returnTo=%2F"
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Sign in
        </a>
        <p className="mt-4 text-xs text-muted">
          The agent acts with your delegated authority and never holds a
          credential of its own.
        </p>
      </div>
    </main>
  );
}
