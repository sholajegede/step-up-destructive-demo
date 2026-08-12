"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import type { SessionView } from "@/lib/session-view";

type RefreshComparison = {
  authTimeBefore?: number;
  authTimeAfter?: number;
  authTimeMoved: boolean;
  issuedAtMoved: boolean;
  tokenIdMoved: boolean;
  refreshTokenRotated: boolean;
  verdict: string;
};

/** One observation, appended as the checks are run. */
type Observation = {
  at: string;
  label: string;
  detail: string;
  good: boolean | null;
};

export function AuthProbe({ session }: { session: SessionView }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [comparison, setComparison] = useState<RefreshComparison | null>(null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A callback failure comes back on the URL, so it is read during render
  // rather than copied into state.
  const callbackError =
    searchParams.get("auth_error") === null
      ? null
      : `${searchParams.get("auth_error")}: ` +
        `${searchParams.get("auth_error_description") ?? "no detail"}`;
  const error = actionError ?? callbackError;

  const note = useCallback(
    (label: string, detail: string, good: boolean | null = null) => {
      setObservations((prior) => [
        ...prior,
        { at: new Date().toISOString(), label, detail, good },
      ]);
    },
    [],
  );

  const runRefresh = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/auth/refresh", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setActionError(`${data.error}: ${data.message}`);
        return;
      }
      setComparison(data.comparison as RefreshComparison);
      const c = data.comparison as RefreshComparison;
      note(
        "Token refresh",
        c.verdict,
        // A refresh that leaves auth_time alone is the result the design needs.
        !c.authTimeMoved,
      );
      note(
        "Refresh issued a new token",
        `iat moved: ${c.issuedAtMoved}, jti moved: ${c.tokenIdMoved}, ` +
          `refresh token rotated: ${c.refreshTokenRotated}`,
        c.issuedAtMoved,
      );
      // The session lives on the server; re-render it there.
      router.refresh();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "Refresh failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const claims = session.accessToken ?? session.idToken;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Authentication probe
        </h1>
        <p className="text-sm leading-relaxed text-black/60 dark:text-white/60">
          Watch what the provider does to <code>auth_time</code>. A fresh
          interactive sign-in must move it. A token refresh must not.
        </p>
      </header>

      {error !== null && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <section className="flex flex-wrap gap-3">
        {/* Plain navigations: the login route redirects to the provider, so
            this must leave the app rather than route on the client. */}
        <a
          href="/api/auth/login?returnTo=%2Fauth-probe"
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          Sign in
        </a>
        <a
          href="/api/auth/login?returnTo=%2Fauth-probe&max_age=0&prompt=login&stepUp=1"
          className="rounded border border-black/20 px-4 py-2 text-sm font-medium dark:border-white/30"
        >
          Re-authenticate (max_age=0, prompt=login)
        </a>
        <button
          type="button"
          onClick={runRefresh}
          disabled={busy || session.hasRefreshToken !== true}
          className="rounded border border-black/20 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-white/30"
        >
          Refresh token
        </button>
        <a
          href="/api/auth/logout"
          className="rounded border border-black/20 px-4 py-2 text-sm font-medium dark:border-white/30"
        >
          Sign out
        </a>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Current claims
        </h2>
        {session.signedIn !== true ? (
          <p className="text-sm text-black/60 dark:text-white/60">
            Not signed in.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded border border-black/10 p-4 text-sm dark:border-white/15">
            <Row label="subject" value={claims?.sub} />
            <Row label="email" value={claims?.email} />
            <Row
              label="auth_time"
              value={
                claims?.authTime === undefined
                  ? "ABSENT — freshness cannot be proved"
                  : `${claims.authTime} (${claims.authTimeIso})`
              }
            />
            <Row
              label="auth age"
              value={
                claims?.authAgeSeconds === undefined
                  ? undefined
                  : `${claims.authAgeSeconds}s ago`
              }
            />
            <Row
              label="iat"
              value={
                claims?.issuedAt === undefined
                  ? undefined
                  : `${claims.issuedAt} (${claims.issuedAtIso})`
              }
            />
            <Row label="exp" value={claims?.expiresAtIso} />
            <Row label="amr" value={claims?.amr?.join(", ")} />
            <Row label="acr" value={claims?.acr} />
            <Row label="jti" value={claims?.jti} />
            <Row
              label="refresh token"
              value={session.hasRefreshToken === true ? "present" : "absent"}
            />
          </dl>
        )}
        {session.accessTokenError !== undefined && (
          <p className="text-sm text-red-600 dark:text-red-400">
            access token: {session.accessTokenError}
          </p>
        )}
        {session.idTokenError !== undefined && (
          <p className="text-sm text-red-600 dark:text-red-400">
            id token: {session.idTokenError}
          </p>
        )}
      </section>

      {comparison !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Refresh comparison
          </h2>
          <div
            className={`rounded border p-4 text-sm ${
              comparison.authTimeMoved
                ? "border-red-500/40 bg-red-500/10"
                : "border-green-600/40 bg-green-600/10"
            }`}
          >
            <p className="font-medium">{comparison.verdict}</p>
            <p className="mt-2 text-black/70 dark:text-white/70">
              auth_time before {String(comparison.authTimeBefore)} → after{" "}
              {String(comparison.authTimeAfter)}
            </p>
          </div>
        </section>
      )}

      {observations.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Observations
          </h2>
          <ol className="flex flex-col gap-2 text-sm">
            {observations.map((observation, index) => (
              <li
                key={index}
                className="rounded border border-black/10 px-4 py-3 dark:border-white/15"
              >
                <span className="font-medium">{observation.label}</span>
                {observation.good !== null && (
                  <span
                    className={
                      observation.good
                        ? "ml-2 text-green-700 dark:text-green-400"
                        : "ml-2 text-red-700 dark:text-red-400"
                    }
                  >
                    {observation.good ? "as required" : "not as required"}
                  </span>
                )}
                <p className="mt-1 text-black/60 dark:text-white/60">
                  {observation.detail}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <dt className="font-mono text-xs text-black/50 dark:text-white/50">
        {label}
      </dt>
      <dd className="break-all">{value ?? "—"}</dd>
    </>
  );
}
