# Changelog

## 1.0.0

First release.

### Enforcement

- One seam that every agent tool call passes through. Safe tools are allowed
  without a freshness check. Destructive tools are held until `auth_time`
  proves a recent human authentication.
- Freshness is read from the ID token, verified server-side at the moment of
  the call, and bound to the access token by subject. `iat` and `exp` are
  never used as a proxy for human presence.
- Per-tool freshness windows, tiered by damage: 300s for a document delete,
  120s for a refund or a production deploy. A destructive tool with no window
  is refused rather than treated as unlimited.
- Held calls answer with HTTP 403 and an RFC 9470
  `insufficient_user_authentication` challenge carrying the required
  `max_age`.
- `APPROVAL_MODE` is resolved from the deploy environment only. Any value
  other than `blanket` resolves to `step-up`.

### Agent

- Claude tool-calling loop that carries the signed-in person's delegated
  identity and holds no credential of its own.
- A held call ends the run. The agent does not retry and does not substitute
  another tool.
- A paused run stores its conversation and resumes the same held call under
  the original `correlationId`.

### Console

- Free-text task composer, multiple concurrent runs, and a live timeline.
- Re-authentication and release completed from the interface.
- Live records view, live counters, and a demo reset.

### Audit

- Every allow, challenge, and deny writes one row with a `correlationId`.
- Audit writes retry, then fall back to a local append-only spool, and replay
  when the store returns. A decision that cannot be recorded anywhere is
  refused.
- An unreadable tool registry is refused and recorded rather than failing
  open or failing silently.

### Verification

- Unit tests for the registry invariant, the decision table, login parameter
  handling, and audit durability.
- `npm run e2e` walks the full story in one pass against the live deployment
  and exits non-zero on any failed check.

### Known limitations

- The identity provider emits no `amr` or `acr` claim, so the build proves
  when a person authenticated and not how. The assertion mechanism ships
  disabled and is enabled by configuration.
- The audit spool is a single-host file. A decision is never silently lost,
  but this is not a durable queue.
