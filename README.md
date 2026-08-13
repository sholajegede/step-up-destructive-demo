# Records Console

An operations console where an AI agent does read-only work freely, and every
destructive action is held until a person proves they are present.

The agent can list, read, and summarise records without interruption. When it
tries to delete a document, refund an invoice, or deploy a release, the server
checks how long ago a human actually authenticated. If that was too long ago,
the action is held and the person is asked to re-authenticate. The agent
cannot proceed until they do.

---

## The problem

An agent that holds a long-lived access token can act at any time. The token
says who the person is. It does not say whether that person is still there.

The usual answer is to ask the person to approve things. In practice that
produces approval fatigue: a stream of prompts, most of them harmless, all
cleared by reflex. The prompts stop being a decision and become a habit, and
the one that mattered is cleared with the rest.

This console takes a different line:

- **Read-only tools never prompt.** No freshness check, no interruption. This
  is deliberate — a prompt on a harmless action is what trains a person to
  stop reading prompts.
- **Destructive tools are held** until the server can prove a human
  authenticated recently. The person re-authenticates once, at the moment it
  matters.

The number to watch is **executed without fresh auth**. It is on the console.
It must be zero.

---

## The security model

### `auth_time` is the evidence

An OpenID Connect ID token carries `auth_time`: the moment the person last
authenticated interactively. It is the only claim that tracks a human, and
this build rests on it.

Two claims that look similar are **not** used, deliberately:

- `iat` and `exp` move whenever a token is minted. A refresh mints new tokens
  with no person involved, so a check of "was this token issued recently?"
  passes with nobody there. Verified against the live provider: a refresh
  issues a new ID token — new `jti`, new `iat`, new `exp` — and carries the
  **original** `auth_time` through untouched. A freshly minted token can
  correctly describe an authentication from an hour ago.

`auth_time` appears on the **ID token**, not the access token. The access
token is the credential presented at the API boundary; the ID token is the
evidence of human presence. A destructive call needs both, and the server
binds them by subject so an ID token from one session cannot vouch for an
access token from another.

### One seam

Every tool call goes through a single function. There is no second path.

```
verify access token → destructive? → auth_time within the tool's window?
                                   → allow / challenge / deny
```

- **Safe tools** are allowed with no freshness check.
- **Destructive tools** carry a freshness window, in seconds, tiered by
  damage: 300s to delete a document, 120s to move money or deploy to
  production.
- A destructive tool with **no** window is refused as a registry defect. An
  absent limit is treated as a bug, never as permission.

A held call answers with HTTP 403 and an RFC 9470 challenge:

```
WWW-Authenticate: Bearer error="insufficient_user_authentication",
  error_description="…", max_age=120
```

### The agent has no authority of its own

The agent holds no credential. It calls the same public endpoint every other
client uses, carrying the signed-in person's session. It cannot reach a tool
directly. If the server refuses, the agent is refused.

When a destructive call is held, the agent **stops**. It does not retry, and
it does not reach for a different tool to get the same effect. The run pauses
and the person is shown a link to re-authenticate.

### Two modes, decided by the server

`APPROVAL_MODE` is read from the deploy environment and from nowhere else. The
browser cannot set it. The agent cannot set it. Any value other than
`blanket` resolves to `step-up`, so a typo fails towards enforcement.

| Mode | Behaviour |
| --- | --- |
| `step-up` | Destructive tools are held until `auth_time` is inside the window. |
| `blanket` | The freshness check is skipped. Destructive tools run. |

`blanket` exists to show the failure this console is built to prevent. Run the
same task in each mode and watch **executed without fresh auth**.

### Re-authentication is a request, not proof

The re-authentication link sends `max_age=0` and `prompt=login`. Those ask the
provider for an interactive sign-in. They are never treated as evidence. When
the agent retries, the server reads `auth_time` out of the presented token
again and decides again.

A retry that skipped a real sign-in meets the same refusal as the first
attempt. A token refresh does not release a held action.

### Everything is audited

Every allow, challenge, and deny writes one row with a `correlationId`. A
challenge, a refused retry, a re-authentication, and the release share one id,
so the whole story reads as one trail.

An action that cannot be recorded does not run.

---

## Honest limitations

**The console proves *when* a person authenticated. It cannot prove *how*.**

The Kinde tenant used here emits no `amr` or `acr` claim on either token, even
when multi-factor authentication is completed. This was checked against the
provider's documentation and against real tokens: the ID token carries 19
claims and none of them record the authentication method.

The assertion mechanism is built and ships **off**. Set
`STEP_UP_REQUIRED_AMR` (for example `mfa`) and a destructive release must
evidence that method, or it is held. On this tenant that setting refuses every
destructive call, because there is no `amr` to check — correct fail-closed
behaviour, but not a control this provider can satisfy. It is configuration,
not code, for a provider that does emit the claim.

`acr_values` is deliberately absent from the challenge header for the same
reason. A demand that cannot be verified is not a control.

**The audit spool is a floor, not a durable queue.** If the audit store is
unreachable, a decision is retried, then written to a local append-only file,
and replayed when the store returns. A decision is therefore never *silently*
lost. But that file lives on one host and does not survive it. A production
deployment wants a durable queue with its own availability guarantees.

---

## Requirements

- Node.js 22 or later
- A Kinde account
- A Convex account
- An Anthropic API key

All keys must be your own. Do not use a key from a shared or example account.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Set up Convex

```bash
npx convex dev --once
```

The first run asks you to sign in and to select or create a project. It then
writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` to `.env.local`.

### 3. Set up Kinde

In the Kinde dashboard:

1. Add an application. Select **Back-end web**.
2. Set the allowed callback URL to
   `http://localhost:3001/api/auth/callback`.
3. Set the allowed logout redirect URL to `http://localhost:3001`.
4. Turn on multi-factor authentication for the tenant.
5. Copy the domain, the client ID, and the client secret.

Multi-factor authentication is required. The re-authentication step must be a
real interactive sign-in.

### 4. Write the environment file

Copy `.env.example` to `.env.local`. Then set these values:

```bash
APPROVAL_MODE=step-up

KINDE_ISSUER_URL=https://<your-tenant>.kinde.com
KINDE_CLIENT_ID=<your client id>
KINDE_CLIENT_SECRET=<your client secret>
KINDE_REDIRECT_URI=http://localhost:3001/api/auth/callback
KINDE_POST_LOGOUT_REDIRECT_URI=http://localhost:3001

ANTHROPIC_API_KEY=<your API key>
ANTHROPIC_MODEL=claude-opus-5

SESSION_SECRET=<32 or more random characters>
APP_SITE_URL=http://localhost:3001
```

Make a session secret with this command:

```bash
openssl rand -base64 32
```

Keep `.env.local` out of version control. It is in `.gitignore`.

### 5. Add the sample data

```bash
npx convex run tools:seedRegistry '{}'
npx convex run records:seedRecords '{}'
```

---

## Run it

```bash
npm run dev
```

Open `http://localhost:3001`. Then:

1. Sign in.
2. Write a task. For example: *Review our documents, find the one that has
   been superseded, and delete it.*
3. Select **Run task**.
4. Watch the timeline. Read-only steps are allowed immediately.
5. The destructive step is held. Read the reason and the authentication age.
6. Select **Re-authenticate to continue**. Complete the sign-in.
7. The run continues. The action executes. The record changes.

To see the failure mode, stop the server and start it again in blanket mode:

```bash
APPROVAL_MODE=blanket npm run dev
```

Run the same task. The destructive action executes with no re-authentication.
The **executed without fresh auth** counter increases.

Use **Reset demo** to restore the records and clear the trail.

---

## The end-to-end narrative

One script walks the whole story and checks the result at each step.

The script drives a real browser. Install the browser once:

```bash
npx playwright install chromium
```

Then run the script:

```bash
npm run e2e
```

It opens a browser window named **Google Chrome for Testing**. Sign in when it
asks. It then runs without help until it asks you to re-authenticate once. It
saves the session to `.e2e-auth.json`, so a later run does not ask you to sign
in again. Every check reads the deployment back —
audit rows, record state, and counters — not the HTTP status.

The script:

1. Resets to a clean state.
2. Runs a read-only task in step-up mode. Nothing is held. No record changes.
3. Lets the authentication age, then runs a destructive task in blanket mode.
   The action executes. The record changes. The escape counter increases.
4. Resets, and runs a destructive task in step-up mode. The action is held.
5. Refreshes the token and retries. The action stays held.
6. Waits for a real re-authentication, then retries. The action executes once.
7. Checks that the trail is one coherent story under one `correlationId`.

The script exits with a non-zero code if a check fails. It names the check and
prints the expected and actual values.

It changes `APPROVAL_MODE` by restarting the server, because the mode is a
property of the deployment. It never sends the mode on a request.

---

## Other commands

```bash
npm test          # unit tests
npm run lint      # lint
npm run build     # production build
```

`GET /api/health` reports liveness, which configuration groups are present
(never their values), the resolved approval mode, and the audit-spool depth.

---

## Deploying

The app runs on Vercel with Convex as the backend.

1. Run `npx convex deploy` and note the production deployment URL.
2. Create the Vercel project from this repository.
3. Add every variable from `.env.local` to the Vercel project, with the
   production Convex URL.
4. Set `APP_SITE_URL` and the two Kinde URLs to the deployed origin.
5. Add the deployed callback and logout URLs to the Kinde application.

Set `APPROVAL_MODE` per environment. Keep `step-up` in production. `blanket`
is a demonstration setting and must not be used with real data.

The audit spool is a local file. On a platform with a read-only or ephemeral
filesystem, set `AUDIT_SPOOL_FILE` to a writable path, or replace the spool
with a durable queue before relying on it.

---

## Licence

MIT
