/**
 * End-to-end narrative.
 *
 * Walks the whole story in one pass and exits nonzero on the first failed
 * assertion. Every step asserts the *real* outcome — audit rows, record
 * state, and counters read back from the deployment — rather than the HTTP
 * status the app happened to return.
 *
 * Two things this script deliberately does not do:
 *
 * - It never sets `APPROVAL_MODE` on a request. The mode is decided by the
 *   deploy environment, so switching it means restarting the server with a
 *   different environment. The script manages that lifecycle rather than
 *   introducing a back door it could flip.
 * - It never mints or forges a session. It drives a real browser, and the
 *   operator signs in once at the start and re-authenticates once at the
 *   climax. Everything between those two beats is automatic.
 *
 * Usage:  npm run e2e
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";
import { chromium, type Browser, type BrowserContext } from "playwright";

/**
 * `convex/_generated/api` re-exports `anyApi` verbatim, but it sits under the
 * project's CommonJS package scope while this script runs as ESM. Referencing
 * `anyApi` directly is the same object without the module-format mismatch.
 */
type AuditRow = {
  correlationId: string;
  toolName: string;
  destructive: boolean;
  decision: "allow" | "challenge" | "deny";
  reason: string;
  approvalMode: "step-up" | "blanket";
  authAgeSeconds?: number;
  maxAuthAgeSeconds?: number;
};

type Metrics = {
  safeCalls: number;
  destructiveAttempts: number;
  challenged: number;
  denied: number;
  executedWithoutFreshAuth: number;
};

type RecordDoc = {
  ref: string;
  status: string;
  deletedAt?: number;
  refundedAt?: number;
  deployedAt?: number;
};

type RunDoc = {
  status: "running" | "halted" | "completed" | "failed";
  correlationId: string;
  haltedReason?: string;
};

type Args = Record<string, unknown>;
type Query<A extends Args, Result> = FunctionReference<
  "query",
  "public",
  A,
  Result
>;
type Mutation<A extends Args, Result> = FunctionReference<
  "mutation",
  "public",
  A,
  Result
>;

const api = anyApi as unknown as {
  audit: {
    byCorrelationId: Query<{ correlationId: string }, AuditRow[]>;
    metrics: Query<Record<string, never>, Metrics>;
  };
  records: {
    resetDemo: Mutation<Record<string, never>, unknown>;
    getByRef: Query<{ ref: string }, RecordDoc | null>;
  };
  runs: { get: Query<{ runId: string }, RunDoc | null> };
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadEnvFile(filename: string): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), filename), "utf8");
  } catch {
    return;
  }
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "" || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(".env.local");

const PORT = Number(process.env.E2E_PORT ?? 3001);
const BASE = `http://localhost:${PORT}`;
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;
if (CONVEX_URL === undefined || CONVEX_URL === "") {
  console.error("NEXT_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` once.");
  process.exit(1);
}
const convex = new ConvexHttpClient(CONVEX_URL);

// ---------------------------------------------------------------------------
// Output and assertions
// ---------------------------------------------------------------------------

const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RESET = "[0m";

let assertions = 0;

class AssertionFailed extends Error {}

function step(number: number, title: string): void {
  console.log(`\n${BOLD}── Step ${number}: ${title}${RESET}`);
}

function info(message: string): void {
  console.log(`   ${DIM}${message}${RESET}`);
}

/** Asserts, counting the check and naming precisely what failed. */
function assert(condition: boolean, description: string, detail = ""): void {
  assertions += 1;
  if (condition) {
    console.log(`   ${GREEN}✓${RESET} ${description}`);
    return;
  }
  throw new AssertionFailed(
    `${description}${detail === "" ? "" : `\n     ${detail}`}`,
  );
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  description: string,
): void {
  assert(
    Object.is(actual, expected),
    description,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Server lifecycle — the only way to change APPROVAL_MODE
// ---------------------------------------------------------------------------

let server: ChildProcess | null = null;

async function stopServer(): Promise<void> {
  if (server === null) return;
  const dying = server;
  server = null;
  dying.kill("SIGTERM");
  for (let i = 0; i < 50; i += 1) {
    if (dying.exitCode !== null || dying.signalCode !== null) break;
    await sleep(100);
  }
  await sleep(400);
}

async function startServer(mode: "step-up" | "blanket"): Promise<void> {
  await stopServer();
  server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, APPROVAL_MODE: mode },
    stdio: "ignore",
    detached: false,
  });

  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`, {
        cache: "no-store",
      });
      if (response.ok) {
        const health = (await response.json()) as { approvalMode: string };
        if (health.approvalMode === mode) {
          info(`server up on :${PORT} in ${mode} mode`);
          return;
        }
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`server did not come up in ${mode} mode`);
}

// ---------------------------------------------------------------------------
// Deployment reads — the source of truth for every assertion
// ---------------------------------------------------------------------------

/**
 * Retries a deployment read/write through a transient network fault.
 *
 * This hardens the harness, not the assertions. The values every assertion
 * compares are still read truthfully from the deployment — a connect timeout
 * on the way to Convex says nothing about whether the seam behaved, and
 * failing the narrative on one would report a network blip as a security
 * regression.
 */
async function resilient<T>(label: string, call: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        message.includes("fetch failed") ||
        message.includes("timeout") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT");
      if (!transient || attempt === 5) break;
      info(`${label}: transient network fault, retrying (${attempt}/4)`);
      await sleep(1500 * attempt);
    }
  }
  throw last;
}

const auditFor = (correlationId: string) =>
  resilient("audit read", () =>
    convex.query(api.audit.byCorrelationId, { correlationId }),
  );

const metrics = () => resilient("metrics read", () => convex.query(api.audit.metrics, {}));

const recordByRef = (ref: string) =>
  resilient(`record ${ref}`, () => convex.query(api.records.getByRef, { ref }));

const resetDemo = () =>
  resilient("reset", () => convex.mutation(api.records.resetDemo, {}));

// ---------------------------------------------------------------------------
// Browser-driven calls — the operator's real session
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let context: BrowserContext | null = null;

/** Runs a fetch inside the browser so the session cookie is carried. */
async function inSession<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const page = context!.pages()[0];
  return await page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        method: init.method ?? "GET",
        headers:
          init.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    { path, init },
  ) as { status: number; body: T };
}

type RunStarted = { runId: string; correlationId: string };

/** Starts a run and waits for it to stop moving. */
async function runTask(prompt: string): Promise<{
  runId: string;
  correlationId: string;
  run: RunDoc;
}> {
  const started = await inSession<RunStarted>("/api/agent/run", {
    method: "POST",
    body: { prompt },
  });
  if (started.status !== 202 || started.body?.runId === undefined) {
    throw new Error(
      `run did not start: HTTP ${started.status} ${JSON.stringify(started.body)}`,
    );
  }
  const run = await waitForSettled(started.body.runId);
  return {
    runId: started.body.runId,
    correlationId: started.body.correlationId,
    run,
  };
}

async function waitForSettled(
  runId: string,
  timeoutMs = 180_000,
): Promise<RunDoc> {
  const deadline = Date.now() + timeoutMs;
  let last: RunDoc | null = null;
  while (Date.now() < deadline) {
    const run = await resilient("run read", () =>
      convex.query(api.runs.get, { runId }),
    );
    if (run !== null) {
      last = run;
      if (run.status !== "running") return run;
    }
    await sleep(1500);
  }
  throw new Error(
    `run ${runId} never settled (last status: ${last?.status ?? "unknown"})`,
  );
}

async function resumeRun(runId: string): Promise<RunDoc> {
  const response = await inSession<{ accepted?: boolean }>(
    `/api/agent/run/${runId}/resume`,
    { method: "POST" },
  );
  if (response.status !== 202) {
    throw new Error(`resume was not accepted: HTTP ${response.status}`);
  }
  return await waitForSettled(runId);
}

type SessionView = {
  signedIn: boolean;
  idToken?: { authTime?: number; sub?: string; email?: string };
};

const readSession = () => inSession<SessionView>("/api/auth/session");

/** Manual beats wait generously — a person may not be at the keyboard. */
const OPERATOR_TIMEOUT_MS = 900_000;

async function waitForSignIn(): Promise<SessionView> {
  const deadline = Date.now() + OPERATOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { body } = await readSession();
    if (body?.signedIn === true) return body;
    await sleep(2000);
  }
  throw new Error("timed out waiting for sign-in");
}

// ---------------------------------------------------------------------------
// The narrative
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `${BOLD}Step-up enforcement — end-to-end narrative${RESET}\n${DIM}Every assertion reads the deployment back, not the HTTP status.${RESET}`,
  );

  browser = await chromium.launch({ headless: false });
  context = await browser.newContext();
  const page = await context.newPage();

  // -- Step 1 --------------------------------------------------------------
  step(1, "Clean slate");
  await startServer("step-up");
  await resetDemo();

  const opening = await metrics();
  assertEqual(opening.executedWithoutFreshAuth, 0, "escapes start at 0");
  assertEqual(opening.destructiveAttempts, 0, "no destructive attempts yet");

  // Land the operator directly on the provider rather than on a page with a
  // button they have to find. The window is a fresh browser profile, so there
  // is no existing session to reuse.
  await page.goto(`${BASE}/api/auth/login?returnTo=%2F`);
  console.log(
    `\n   ${YELLOW}${BOLD}▶ OPERATOR: sign in.${RESET}\n` +
      `   ${YELLOW}A Chromium window has opened at the Kinde sign-in page.${RESET}\n` +
      `   ${DIM}It is a fresh browser profile, so your usual session does not apply.${RESET}\n` +
      `   ${DIM}Waiting up to ${OPERATOR_TIMEOUT_MS / 60_000} minutes…${RESET}`,
  );
  const session = await waitForSignIn();
  info(`signed in as ${session.idToken?.email ?? session.idToken?.sub}`);

  // -- Step 2 --------------------------------------------------------------
  step(2, "Step-up mode — a read-only task is never interrupted");
  const safe = await runTask(
    "Summarise our documents and list the invoices. Do not change anything.",
  );
  const safeRows = await auditFor(safe.correlationId);

  assert(safeRows.length > 0, "the safe run produced audit rows");
  assert(
    safeRows.every((row) => row.decision === "allow"),
    "every tool call in the safe run was allowed",
    `decisions: ${safeRows.map((r) => `${r.toolName}=${r.decision}`).join(", ")}`,
  );
  assert(
    safeRows.every((row) => row.destructive === false),
    "no destructive tool was reached",
  );
  assert(
    safeRows.every((row) => row.reason === "safe_tool"),
    "every allow was on the safe-tool path, not a freshness pass",
  );

  const afterSafe = await metrics();
  assertEqual(
    afterSafe.challenged,
    0,
    "nothing was challenged during read-only work",
  );
  assertEqual(afterSafe.executedWithoutFreshAuth, 0, "escapes still 0");

  for (const ref of ["DOC-3303", "INV-1042", "REL-2026-08-03"]) {
    const record = await recordByRef(ref);
    assert(
      record?.deletedAt === undefined &&
        record?.refundedAt === undefined &&
        record?.deployedAt === undefined,
      `${ref} is unchanged after the read-only run`,
    );
  }

  // -- Step 3 --------------------------------------------------------------
  step(3, "Blanket mode — the hole, shown deliberately");
  await startServer("blanket");
  const slip = await runTask(
    "Delete the superseded vendor contract document, DOC-3303.",
  );
  const slipRows = await auditFor(slip.correlationId);
  const slipped = slipRows.find(
    (row) => row.destructive && row.decision === "allow",
  );

  assert(
    slipped !== undefined,
    "a destructive call was allowed in blanket mode",
    `rows: ${slipRows.map((r) => `${r.toolName}=${r.decision}/${r.reason}`).join(", ")}`,
  );
  assertEqual(
    slipped?.reason,
    "blanket_mode_freshness_skipped",
    "it was allowed by skipping the freshness check",
  );
  assertEqual(
    slipped?.approvalMode,
    "blanket",
    "the audit row records the mode that let it through",
  );

  const deleted = await recordByRef("DOC-3303");
  assert(
    deleted?.deletedAt !== undefined,
    "the record was actually changed — the action ran for real",
  );

  const afterSlip = await metrics();
  assert(
    afterSlip.executedWithoutFreshAuth > 0,
    "the escapes counter went nonzero",
    `escapes: ${afterSlip.executedWithoutFreshAuth}`,
  );
  const escapesFromBlanket = afterSlip.executedWithoutFreshAuth;
  info(`escapes after the blanket slip: ${escapesFromBlanket}`);

  // -- Step 4 --------------------------------------------------------------
  step(4, "Step-up mode — the same task is held");
  await resetDemo();
  await startServer("step-up");

  const resetMetrics = await metrics();
  assertEqual(
    resetMetrics.executedWithoutFreshAuth,
    0,
    "reset cleared the trail",
  );

  const held = await runTask(
    "Delete the superseded vendor contract document, DOC-3303.",
  );
  assertEqual(held.run.status, "halted", "the run halted instead of acting");

  const heldRows = await auditFor(held.correlationId);
  const challenge = heldRows.find((row) => row.decision === "challenge");
  assert(
    challenge !== undefined,
    "the destructive call was challenged",
    `rows: ${heldRows.map((r) => `${r.toolName}=${r.decision}/${r.reason}`).join(", ")}`,
  );
  assert(
    challenge?.destructive === true,
    "the challenge was on the destructive tool",
  );
  assert(
    heldRows.every((row) => !(row.destructive && row.decision === "allow")),
    "no destructive call was allowed",
  );

  const stillThere = await recordByRef("DOC-3303");
  assert(
    stillThere?.deletedAt === undefined,
    "the record is untouched — nothing executed",
  );
  assertEqual(
    (await metrics()).executedWithoutFreshAuth,
    0,
    "escapes remain 0 in step-up",
  );

  // -- Step 5 --------------------------------------------------------------
  step(5, "The negative — a refresh cycle must not release the action");
  const before = await readSession();
  const authTimeBefore = before.body.idToken?.authTime;
  assert(
    authTimeBefore !== undefined,
    "auth_time is readable before the refresh",
  );

  const refreshed = await inSession<{
    comparison?: { authTimeMoved?: boolean; idTokenChanged?: boolean };
  }>("/api/auth/refresh", { method: "POST" });
  assertEqual(refreshed.status, 200, "the refresh succeeded");
  assertEqual(
    refreshed.body.comparison?.authTimeMoved,
    false,
    "the refresh did NOT advance auth_time",
  );

  const afterRefresh = await readSession();
  assertEqual(
    afterRefresh.body.idToken?.authTime,
    authTimeBefore,
    "auth_time is byte-identical after a machine-to-machine refresh",
  );

  const refusedRun = await resumeRun(held.runId);
  assertEqual(
    refusedRun.status,
    "halted",
    "the resume was refused — a refresh does not prove human presence",
  );

  const afterNegative = await auditFor(held.correlationId);
  assert(
    afterNegative.length > heldRows.length,
    "the refused resume was itself recorded",
  );
  assert(
    afterNegative.every((row) => !(row.destructive && row.decision === "allow")),
    "still nothing destructive allowed",
  );
  assert(
    (await recordByRef("DOC-3303"))?.deletedAt === undefined,
    "the record is still untouched after the refresh-only retry",
  );

  // -- Step 6 --------------------------------------------------------------
  step(6, "The release — only a real human re-authentication opens the gate");
  const reauthUrl = `${BASE}/api/auth/login?max_age=0&prompt=login&stepUp=1&returnTo=%2F`;
  console.log(
    `\n   ${YELLOW}${BOLD}▶ OPERATOR: re-authenticate.${RESET}\n` +
      `   ${YELLOW}The Chromium window is now on the Kinde sign-in page again.${RESET}\n` +
      `   ${DIM}This is the step the whole build turns on: the action stays held${RESET}\n` +
      `   ${DIM}until a person proves presence. Waiting for auth_time to advance${RESET}\n` +
      `   ${DIM}past ${authTimeBefore}, up to ${OPERATOR_TIMEOUT_MS / 60_000} minutes…${RESET}`,
  );
  await page.goto(reauthUrl);

  const deadline = Date.now() + OPERATOR_TIMEOUT_MS;
  let authTimeAfter: number | undefined;
  while (Date.now() < deadline) {
    const now = await readSession().catch(() => null);
    const candidate = now?.body.idToken?.authTime;
    if (candidate !== undefined && candidate > (authTimeBefore ?? 0)) {
      authTimeAfter = candidate;
      break;
    }
    await sleep(2000);
  }
  assert(
    authTimeAfter !== undefined,
    "a fresh interactive authentication advanced auth_time",
    "timed out waiting for the operator",
  );
  info(`auth_time ${authTimeBefore} → ${authTimeAfter}`);

  const releasedRun = await resumeRun(held.runId);
  assert(
    releasedRun.status === "completed",
    "the resumed run completed",
    `status: ${releasedRun.status}`,
  );

  const finalRows = await auditFor(held.correlationId);
  const releases = finalRows.filter(
    (row) => row.destructive && row.decision === "allow",
  );
  assertEqual(releases.length, 1, "the destructive action was released exactly once");
  assertEqual(
    releases[0]?.reason,
    "fresh_authentication",
    "it was released on proven freshness",
  );
  assert(
    (releases[0]?.authAgeSeconds ?? Number.MAX_SAFE_INTEGER) <=
      (releases[0]?.maxAuthAgeSeconds ?? 0),
    "the release was inside the tool's window",
    `age ${releases[0]?.authAgeSeconds}s vs window ${releases[0]?.maxAuthAgeSeconds}s`,
  );

  const finallyDeleted = await recordByRef("DOC-3303");
  assert(
    finallyDeleted?.deletedAt !== undefined,
    "the record changed — the action executed for real",
  );

  // -- Step 7 --------------------------------------------------------------
  step(7, "Audit reconciliation — one coherent story");
  assert(
    finalRows.every((row) => row.correlationId === held.correlationId),
    "every row of the round trip shares one correlationId",
  );
  assert(
    finalRows.filter((row) => row.decision === "challenge").length >= 2,
    "the trail records both the original halt and the refused retry",
  );

  const orderedDecisions = finalRows.map((row) => row.decision);
  assertEqual(
    orderedDecisions[orderedDecisions.length - 1],
    "allow",
    "the story ends in a release, after the challenges",
  );

  const closing = await metrics();
  assertEqual(
    closing.executedWithoutFreshAuth,
    0,
    "the release did NOT count as an escape — it was genuinely fresh",
  );
  assert(
    closing.challenged >= 2,
    "challenges are counted",
    `challenged: ${closing.challenged}`,
  );
  assert(
    closing.destructiveAttempts > closing.denied,
    "destructive attempts were held, not merely denied",
  );

  info(
    `final counters: safe=${closing.safeCalls} destructive=${closing.destructiveAttempts} ` +
      `challenged=${closing.challenged} escapes=${closing.executedWithoutFreshAuth}`,
  );

  console.log(
    `\n${GREEN}${BOLD}PASS${RESET} — ${assertions} assertions across 7 steps.\n` +
      `${DIM}Blanket mode let a destructive action through with no human present.\n` +
      `Step-up held the same action, refused a refresh-only retry, and released it\n` +
      `only after a real re-authentication — all under one correlationId.${RESET}`,
  );
}

// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.close();

main()
  .then(async () => {
    await stopServer();
    await context?.close();
    await browser?.close();
    process.exit(0);
  })
  .catch(async (error) => {
    if (error instanceof AssertionFailed) {
      console.error(
        `\n   ${RED}✗ ASSERTION FAILED${RESET}\n   ${RED}${error.message}${RESET}`,
      );
    } else {
      console.error(
        `\n   ${RED}✗ ERROR${RESET}\n   ${RED}${error instanceof Error ? error.message : String(error)}${RESET}`,
      );
      if (error instanceof Error) {
        if (error.cause !== undefined) console.error(`   cause: ${String((error.cause as Error)?.message ?? error.cause)}`);
        console.error(`   ${DIM}${error.stack?.split("\n").slice(1, 5).join("\n   ")}${RESET}`);
      }
    }
    console.error(
      `\n${RED}${BOLD}FAIL${RESET} — stopped after ${assertions} passing assertions.`,
    );
    await stopServer();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    process.exit(1);
  });
