export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">
        Step-up authentication for destructive agent tools
      </h1>
      <p className="text-base leading-relaxed text-black/70 dark:text-white/70">
        An agent runs safe tools freely. Every destructive tool is held until
        the server proves that a human authenticated recently.
      </p>
      <p className="text-sm text-black/50 dark:text-white/50">
        Scaffold in place. Health probe:{" "}
        <a className="underline underline-offset-4" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
