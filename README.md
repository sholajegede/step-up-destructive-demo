# Records Console

An operations console where a Claude agent does read-only work without interruption, and every destructive action waits until a person proves they are present.

The idea behind it is one claim. An OpenID Connect ID token carries `auth_time`, the moment a person last authenticated interactively. A refresh mints a new token but does not change `auth_time`. So `auth_time` is the only claim that tracks a human. The server reads it at the moment a destructive tool is called, compares it against that tool's freshness window, and holds the call if the authentication is too old.

The agent can list, read, and summarise records freely. When it tries to delete a document, refund an invoice, or deploy a release, the server decides again.

## How it works

![Flow of one tool call in this build. A person signs in through Kinde with authorization code and PKCE, and the browser holds an encrypted session cookie. The browser starts a run, and the Claude agent loop forwards that same session cookie to POST /api/tools/invoke. Every call enters one function, enforceToolCall. It verifies the access token against JWKS with RS256 pinned, and denies with token_invalid on failure. It reads the tool registry from Convex. A safe tool is allowed as safe_tool. A destructive tool causes the server to verify the ID token, bind it to the access token by subject, and read auth_time. APPROVAL_MODE, read only from the server environment, then selects the path: blanket allows the call as blanket_mode_freshness_skipped, and step-up compares now minus auth_time against the tool window plus clock skew. Inside the window the call is allowed as fresh_authentication. Outside it the call is challenged as auth_time_stale with HTTP 403 and a WWW-Authenticate Bearer header carrying insufficient_user_authentication and max_age=120. Allowed calls reach the tool executor, and a destructive tool changes the record. A challenged call halts the run, which holds the exact tool call by its tool use id, name, and input. The person then re-authenticates, where max_age=0 and prompt=login ask for a sign-in and are never read as proof. auth_time advances, the same held call re-enters the seam, it is decided again as fresh_authentication, and the executor runs it once. Every allow, challenge, and deny writes one audit row under one correlationId, and an action that cannot be recorded does not run.](article-assets/diagram.png)

Every tool call takes this path. There is no second path.

The agent holds no credential of its own. It calls the same public endpoint that any other client calls, and it carries the signed-in person's session. If the server refuses, the agent is refused. When a call is held, the agent stops. It does not retry, and it does not reach for a different tool to get the same effect.

## The two modes

`APPROVAL_MODE` comes from the deploy environment and from nowhere else. The browser cannot set it. The agent cannot set it. Any value other than `blanket` resolves to `step-up`, so a typo fails towards enforcement.

`blanket` reproduces the failure this console prevents. The measured rows below come from one end-to-end run of the same task in each mode.

| | `blanket` | `step-up` |
| --- | --- | --- |
| Freshness check on a destructive tool | skipped | enforced |
| Read-only tools | never prompt | never prompt |
| Reason code on a stale destructive call | `blanket_mode_freshness_skipped` | `auth_time_stale` |
| HTTP status for that call | `200` | `403` |
| `WWW-Authenticate` on that response | absent | `Bearer error="insufficient_user_authentication", max_age=120` |
| Measured: a destructive call with a 120s window, made at an authentication age of 158s | allowed, and the record changed | held, and the record did not change |
| Console counter "executed without fresh auth" after the run | `1` | `0` |
| What releases a held call | nothing is held | an interactive sign-in that advances `auth_time` |
| Effect of a token refresh alone | nothing is held | no release; `auth_time` stayed byte-identical while `jti`, `iat`, and `exp` all changed |
| Audit rows written | one per decision | one per decision |

## Tools and freshness windows

The registry holds six tools. Convex stores it, and the server reads it on every call.

| Tool | Destructive | Window | Why this window |
| --- | --- | --- | --- |
| `list_records` | no | none | Read-only. A prompt here trains a person to stop reading prompts. |
| `get_record` | no | none | Read-only. |
| `summarize_records` | no | none | Read-only. |
| `delete_record` | yes | 300s | A backup can restore a document. |
| `refund_payment` | yes | 120s | This moves money. |
| `deploy_release` | yes | 120s | A production deploy reaches customers at once. |

The registry enforces an invariant on every write. A destructive tool must carry a positive, finite window. A safe tool must not carry a window at all. Names must be unique. A destructive tool that reaches the seam with no window is denied as `registry_defect`, because an absent limit reads as "no limit", and that is the exact hole this build closes.

`CLOCK_SKEW_SECONDS` adds tolerance for drift between this server and the provider. It defaults to 30.

## Decision codes

The seam returns one decision and one machine-readable reason. Both go into the audit row.

| Reason | Decision | HTTP | Meaning |
| --- | --- | --- | --- |
| `safe_tool` | allow | 200 | The tool is read-only. No freshness check runs. |
| `fresh_authentication` | allow | 200 | `auth_time` is inside the tool's window. |
| `blanket_mode_freshness_skipped` | allow | 200 | Blanket mode skipped the check. This is the failure mode. |
| `auth_time_stale` | challenge | 403 | The person authenticated too long ago. |
| `auth_time_missing` | challenge | 403 | The ID token carries no `auth_time`. |
| `id_token_missing` | challenge | 403 | The session holds no ID token. |
| `id_token_invalid` | challenge | 403 | The ID token failed verification or expired. |
| `mfa_required` | challenge | 403 | `STEP_UP_REQUIRED_AMR` is set and `amr` does not satisfy it. |
| `amr_unprovable` | challenge | 403 | `STEP_UP_REQUIRED_AMR` is set and the token carries no `amr`. |
| `token_invalid` | deny | 401 | The access token is absent or failed verification. |
| `subject_mismatch` | deny | 403 | The ID token and the access token name different subjects. |
| `unknown_tool` | deny | 403 | The registry holds no tool by that name. |
| `tool_disabled` | deny | 403 | The registry has the tool switched off. |
| `registry_defect` | deny | 403 | A destructive tool carries no usable window. |
| `registry_unavailable` | deny | 403 | The registry could not be read, so no policy applies. |
| `audit_unavailable` | deny | 403 | The decision could not be recorded, so the action does not run. |

A challenge answers with the RFC 9470 shape:

```
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_user_authentication",
  error_description="…", max_age=120
```

`id_token_invalid` and `auth_time_stale` are kept apart on purpose. `auth_time_stale` means the ID token verified, and `now − auth_time` fell outside the window. `id_token_invalid` means the ID token did not verify at all, most often because it expired: the ID token lives an hour and the access token lives a day, so a long session reaches the seam with a good access token and a dead ID token. Both hold the call. They record different facts, so the audit trail says which one happened.

The re-authentication link sends `max_age=0` and `prompt=login`. Those ask the provider for an interactive sign-in. The server never treats them as proof. On the retry it reads `auth_time` out of the presented token again and decides again.

## Requirements

- Node.js 22 or later
- A Kinde account
- A Convex account
- An Anthropic API key

Use your own keys. Do not use a key from a shared account.

## Setup

### 1. Install

```bash
npm install
```

### 2. Set up Convex

```bash
npx convex dev --once
```

The first run asks you to sign in and to select or create a project. It writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` into `.env.local`.

### 3. Set up Kinde

In the Kinde dashboard:

1. Add an application. Select **Back-end web**.
2. Set the allowed callback URL to `http://localhost:3001/api/auth/callback`.
3. Set the allowed logout redirect URL to `http://localhost:3001`.
4. Turn on multi-factor authentication for the tenant.
5. Copy the domain, the client ID, and the client secret.

The re-authentication step must be a real interactive sign-in, so keep multi-factor authentication on.

### 4. Write the environment file

Copy `.env.example` to `.env.local` and fill it in. `.gitignore` already excludes `.env.local`.

Make a session secret with this command:

```bash
openssl rand -base64 32
```

### 5. Add the sample data

```bash
npx convex run tools:seedRegistry '{}'
npx convex run records:seedRecords '{}'
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `APPROVAL_MODE` | no | `blanket` or `step-up`. Server-side only. Anything other than `blanket` resolves to `step-up`. |
| `KINDE_ISSUER_URL` | yes | The tenant URL, for example `https://your-tenant.kinde.com`. |
| `KINDE_CLIENT_ID` | yes | The application client ID. |
| `KINDE_CLIENT_SECRET` | yes | The application client secret. |
| `KINDE_REDIRECT_URI` | yes | The callback URL. Must match the Kinde application. |
| `KINDE_POST_LOGOUT_REDIRECT_URI` | yes | Where the provider returns after a sign-out. |
| `KINDE_AUDIENCE` | no | The audience of a registered API. Leave blank until you register one. |
| `KINDE_SCOPES` | no | Defaults to `openid profile email offline`. |
| `ANTHROPIC_API_KEY` | yes | The key the agent loop uses. |
| `ANTHROPIC_MODEL` | yes | The model id. Configuration, never hardcoded. |
| `ANTHROPIC_MAX_TOKENS` | no | Defaults to `16000`. The template sets `4096`. |
| `SESSION_SECRET` | yes | Encrypts the session cookie. 32 or more random characters. |
| `APP_SITE_URL` | yes | The origin of this app. |
| `DEFAULT_MAX_AUTH_AGE_SECONDS` | no | Defaults to `300`. The seam does not read it. Every destructive tool carries its own window, and a missing window is a `registry_defect`. |
| `CLOCK_SKEW_SECONDS` | no | Drift tolerance in seconds. Defaults to `30`. |
| `CONVEX_DEPLOYMENT` | yes | Written by `npx convex dev`. |
| `NEXT_PUBLIC_CONVEX_URL` | yes | Written by `npx convex dev`. |
| `AUDIT_WRITE_ATTEMPTS` | no | Attempts before the audit row goes to the local spool. Defaults to `3`. |
| `AUDIT_RETRY_BASE_MS` | no | Backoff base in milliseconds. Defaults to `120`. |
| `AUDIT_SPOOL_FILE` | no | Path of the local spool file. Defaults to `.audit-spool.jsonl`. |
| `STEP_UP_REQUIRED_AMR` | no | Authentication methods a destructive release must evidence. Leave empty on Kinde. Read the limitations below. |

## Run it

```bash
npm run dev
```

Open `http://localhost:3001`. Then:

1. Sign in.
2. Write a task, for example: *Review our documents, find the one that has been superseded, and delete it.*
3. Select **Run task**.
4. Watch the timeline. Read-only steps run at once.
5. The destructive step is held. Read the reason and the authentication age.
6. Select **Re-authenticate to continue** and complete the sign-in.
7. The run continues, the action executes, and the record changes.

To see the failure mode, stop the server and start it again in blanket mode:

```bash
APPROVAL_MODE=blanket npm run dev
```

Run the same task. The destructive action executes with no re-authentication, and the counter "executed without fresh auth" increases.

Select **Reset demo** to restore the records and clear the trail.

Other commands:

```bash
npm run lint     # lint
npm run build    # production build
```

`GET /api/health` reports liveness, which configuration groups are present, the resolved approval mode, and the depth of the audit spool. It never reports a configuration value. The call also drains the spool, so a call on a schedule heals an audit outage without anyone intervening.

## Verify it

### Unit tests

```bash
npm test
```

51 tests across 5 files. They drive the decision table directly, with no tokens, no network, and no database. They cover the registry invariant, the `max_age` parser, and the audit sink, including the case where the sink cannot reach the store.

### End-to-end narrative

One script walks the whole story in a real browser and checks the result at each step. Install the browser once:

```bash
npx playwright install chromium
```

Then run the script:

```bash
npm run e2e
```

It opens a window named **Google Chrome for Testing**. Sign in when it asks. It then runs without help until it asks you to re-authenticate once. It saves the session to `.e2e-auth.json`, so a later run does not ask you to sign in again.

The script runs 44 assertions across 7 steps:

1. Reset to a clean state.
2. Run a read-only task in step-up mode. Nothing is held, and no record changes.
3. Let the authentication age, then run a destructive task in blanket mode. The action executes, the record changes, and the escape counter increases.
4. Reset, then run the same destructive task in step-up mode. The action is held.
5. Refresh the token and retry. The action stays held, and `auth_time` is unchanged.
6. Wait for a real re-authentication, then retry. The action executes once.
7. Check that the trail reads as one story under one `correlationId`.

Every assertion reads the deployment back. It checks audit rows, record state, and counters, not the HTTP status. The script exits with a non-zero code on a failure, and it names the check with the expected and actual values.

The script changes `APPROVAL_MODE` by restarting the server, because the mode is a property of the deployment. It never sends the mode on a request.

## Regenerate the diagram

The diagram source is `article-assets/diagram.mmd`. The Mermaid CLI renders it. Nothing is added to `package.json`, so the render stays a one-off command:

```bash
npx -y -p @mermaid-js/mermaid-cli mmdc \
  -i article-assets/diagram.mmd \
  -o article-assets/diagram.png \
  -b white -s 2 -p article-assets/puppeteer.json
```

`-s 2` renders at twice the size, which keeps the text sharp on a high-density screen. `puppeteer.json` passes `--no-sandbox`, which some Linux hosts need.

## Honest limitations

**This build proves *when* a person authenticated. It cannot prove *how*.**

The Kinde tenant here emits no `amr` and no `acr` claim on either token, even after a completed multi-factor sign-in. This was checked against the provider's documentation and against real tokens. The ID token carries 19 claims, and none of them record the authentication method.

The assertion mechanism is built, and it ships off. Set `STEP_UP_REQUIRED_AMR` to `mfa` and a destructive release must evidence that method, or the call is held as `mfa_required`. On this tenant that setting holds every destructive call as `amr_unprovable`, because there is no `amr` to read. That is correct fail-closed behaviour, but it is not a control this provider can satisfy. It is configuration for a provider that does emit the claim, not code to write.

`acr_values` is deliberately absent from the challenge header for the same reason. A demand that nothing can verify is not a control.

**The audit spool is a floor, not a durable queue.** If the audit store is unreachable, the server retries the write `AUDIT_WRITE_ATTEMPTS` times, with an exponential backoff from `AUDIT_RETRY_BASE_MS`. It then appends the row to a local file and replays it when the store returns. A decision is therefore never silently lost, and an allow that reaches neither the store nor the spool converts to a deny with `audit_unavailable`. But that file lives on one host, and it does not survive that host. A production deployment wants a durable queue with its own availability guarantees.

**The freshness window is a bound on damage, not a guarantee of intent.** A window proves that a person authenticated inside it. It does not prove that the person read the task, or that the person wanted this particular call. Tighter windows narrow the gap. They do not close it.

**The demo runs on one deployment.** `blanket` exists to show the failure. Never point it at real data.

## Deploying

The app runs on Vercel with Convex as the backend.

1. Run `npx convex deploy` and note the production deployment URL.
2. Create the Vercel project from this repository.
3. Add every variable from `.env.local` to the Vercel project, with the production Convex URL.
4. Set `APP_SITE_URL` and the two Kinde URLs to the deployed origin.
5. Add the deployed callback and logout URLs to the Kinde application.

Set `APPROVAL_MODE` per environment, and keep `step-up` in production.

The audit spool is a local file. On a platform with a read-only or ephemeral filesystem, set `AUDIT_SPOOL_FILE` to a writable path, or replace the spool with a durable queue before you rely on it.

## Licence

MIT
