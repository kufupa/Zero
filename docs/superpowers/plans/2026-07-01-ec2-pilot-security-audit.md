# EC2-pilot Security Audit

**Scope:** `git diff 4b4a728c..EC2-pilot` — all 26 commits since this branch forked
from `FE-demo-minimal`. New per-mailbox backend (`apps/server-pilot/**`) plus the
frontend cache/polling changes in `apps/mail/**`.

**Skill applied:** `ce-code-review` security / adversarial / correctness lenses
(`.cursor/compound-engineering/skills/ce-code-review/references/personas/security-reviewer.md`).

**Calibration (per the V4 plan constraints):** solo dev, single EC2 + single RDS,
private VPC, **fixtures/fakes only this pass — real mail server, VPN, and SMTP are
out of scope**. Findings are weighted for *real exploitability*, not enterprise
compliance. "Add rate limiting / generic hardening" style noise is intentionally
omitted. Where a risk only becomes reachable once real ingest is enabled, it is
flagged as **deferred / gate-before-prod** rather than a live P0.

Severity: P0 critical · P1 high · P2 moderate · P3 low.

---

## TL;DR

The mailbox isolation model is **sound and consistently applied** — this is the
part that matters most and it holds (see Strengths). No live cross-tenant data
leak is exploitable as wired. The real work is a set of **trust-boundary and
deferred-sanitizer items that must be closed before real email ingest is turned
on**, plus one misleading "SSL enabled" commit that doesn't actually authenticate
the DB server.

Ranked most-severe first:

| # | Sev | Finding | File |
|---|-----|---------|------|
| 1 | P2 | Inbound email HTML stored + served unsanitized (stored-XSS seam; sanitizer is a stub) | `mail/ingest/store.ts`, `trpc/routes/mail.ts` |
| 2 | P2 | Inbound routing trusts forgeable `X-Zero-Mailbox` header → cross-mailbox injection | `mail/ingest/parse-message.ts`, `store.ts` |
| 3 | P2 | RDS TLS certificate verification disabled (`rejectUnauthorized:false`) despite "enable SSL" commit | `db/client.ts`, `scripts/seed-prod.ts` |
| 4 | P3 | Signed-URL `Content-Disposition` built from raw attacker-controlled filename | `trpc/routes/mail.ts` |
| 5 | P3 | Open self-serve registration + no email verification + autoSignIn | `lib/auth.ts` |
| 6 | P3 | `accountLinking.allowDifferentEmails: true` widens linking surface | `lib/auth.ts` |
| 7 | P3 | Test short-circuits live inside production auth middleware | `trpc/trpc.ts` |

Plus residual/correctness notes and verified strengths below.

---

## Findings

### 1. [P2] Inbound email HTML stored and served unsanitized — stored-XSS seam
**`apps/server-pilot/src/mail/ingest/store.ts:231`, `apps/server-pilot/src/trpc/routes/mail.ts:644-654` & `:235`**

Inbound HTML bodies are persisted verbatim (`htmlBody: parsed.htmlBody`) and
returned verbatim by `mail.get` (`htmlBody: m.htmlBody`). The route that is
supposed to clean them, `mail.processEmailContent`, is an explicit no-op:

```ts
// mail.ts:652
return { processedHtml: input.html, hasBlockedImages: false };
```

For an email client this is *the* classic vulnerability: an attacker who can get
a message into a mailbox delivers `<script>`/`<img onerror>`/`<a href=javascript:>`
and it executes in the reader's session (session cookie theft, actions-as-user).

**Why this is P2 and not P0 here:** real inbound mail is out of scope this pass
(fixtures only), so it is not yet reachable by an external attacker, and the plan
itself defers the sanitizer ("Task 9 / future task can wire a real sanitizer").
But the serving path is shipped, and the moment real ingest is enabled this
becomes P0.

**Fix (gate real-ingest on this):** sanitize on the way out (server-side
DOMPurify / `sanitize-html` with a strict allowlist, strip `<script>`, event
handlers, `javascript:`/`data:` URLs), *and* render the body in a sandboxed
iframe (`sandbox` without `allow-scripts`) on the frontend. Add a CSP +
`X-Frame-Options: DENY` at nginx at the same time (see note N5). Do not enable
POP3 ingest against the real server until this lands.

---

### 2. [P2] Inbound routing trusts forgeable `X-Zero-Mailbox` header
**`apps/server-pilot/src/mail/ingest/parse-message.ts:194`, `apps/server-pilot/src/mail/ingest/store.ts:143-175`**

Mailbox routing is driven entirely by a mail header read straight off the parsed
message:

```ts
const ownerHeaderValue = firstHeader(headers, 'x-zero-mailbox');
// store.ts then routes by: mailboxTransport.ownerHeaderValue == parsed.ownerHeaderValue
```

`X-Zero-Mailbox` is an ordinary email header. Any external sender can set it. The
security boundary depends **entirely on the upstream `nava@` relay stripping any
sender-supplied `X-Zero-Mailbox` and re-stamping its own** — that requirement is
not enforced in code and is not documented as a hard control. If the relay
appends its stamp instead of replacing, `firstHeader` makes it worse: it returns
the **first** occurrence, so an attacker's forged header wins over the relay's.

**Impact when real ingest is on:** an outsider emails `nava@` with
`X-Zero-Mailbox: centurion@legacyhotel.com` and their message lands in the
Centurion tenant's inbox (cross-mailbox mail injection / spoofed internal mail).

**Why P2 now:** real ingest is out of scope this pass, so not yet live.

**Fix:** (a) at the relay, unconditionally strip all inbound `X-Zero-Mailbox`
before stamping; (b) in `buildParsedMessage`, read the **last** `x-zero-mailbox`
occurrence (the trusted relay-stamped one), or better, have the relay use a value
the sender cannot predict; (c) document the relay-strip requirement in the
deferred-real-mail readiness doc so it is a checklist item before enablement.

---

### 3. [P2] RDS TLS certificate verification disabled
**`apps/server-pilot/src/db/client.ts:27`, `apps/server-pilot/scripts/seed-prod.ts:51`**

```ts
const conn = postgres(url, { ... ssl: { rejectUnauthorized: false } });
```

Commit `7156f885` ("fix: enable RDS SSL and harden SSM command quoting") claims to
enable SSL, but `rejectUnauthorized:false` encrypts the connection **without
authenticating the server** — the client accepts any certificate, so a
man-in-the-middle between EC2 and RDS can present its own cert and read/modify the
DB stream (which carries the Better Auth session data and all mailbox contents).

The RDS instance is private in the EC2 VPC with an SG that only permits 5432 from
the app SG, so the practical MITM surface is small — that is why this is P2, not
P1. But the commit's stated intent is not actually achieved, and the fix is tiny.

**Fix:** ship the AWS RDS regional CA bundle and use
`ssl: { rejectUnauthorized: true, ca: <rds-ca-pem> }` (or `postgres`'s
`ssl: 'verify-full'` with the CA configured). Apply in both `db/client.ts` and
`seed-prod.ts` (they duplicate the setting).

---

### 4. [P3] Signed-URL `Content-Disposition` built from raw attacker-controlled filename
**`apps/server-pilot/src/trpc/routes/mail.ts:805`**

```ts
ResponseContentDisposition: `attachment; filename="${filename}"`,
```

`filename` here is the **DB-stored original MIME filename** (attacker-controlled
via the inbound attachment) — note this is *not* the sanitized value used for the
S3 key (`attachmentKey` at `storage/s3.ts:149` sanitizes; this path reads the raw
`attachment.filename` column). A `"` or newline in the filename corrupts the
`Content-Disposition` response header S3 reflects back.

The AWS SDK URL-encodes the presign query parameters, so raw HTTP-header injection
is largely mitigated by S3 itself; the realistic impact is a malformed disposition
or filename spoofing on download. Hence P3.

**Fix:** strip/replace `"` and control chars, or RFC 5987-encode
(`filename*=UTF-8''<pct-encoded>`), before interpolating.

---

### 5. [P3] Open self-serve registration + no email verification + autoSignIn
**`apps/server-pilot/src/lib/auth.ts:39-49`**

```ts
emailAndPassword: { enabled: true, requireEmailVerification: false, autoSignIn: true },
emailVerification: { sendOnSignUp: false, ... },
```

Anyone who can reach the internet-facing app (nginx :443) can create an account
with any email — including a plausible-looking internal address — and is
immediately signed in, unverified.

**Why only P3:** this does **not** grant mail access. Mailbox visibility is gated
separately by `mailboxAccess` rows (seeded/admin-assigned), and
`resolveMailboxContext` throws `FORBIDDEN` for a user with zero access rows. So an
anonymous registrant sees no mailbox data. The residual risk is account spam and
lookalike/phishing accounts on a public pilot.

**Fix:** for the pilot, restrict who can register (invite/allowlist, or disable
open sign-up and provision the 3 pilot users via the seed only), or require email
verification before the app is internet-reachable.

---

### 6. [P3] `accountLinking.allowDifferentEmails: true`
**`apps/server-pilot/src/lib/auth.ts:61-67`**

```ts
account: { accountLinking: { enabled: true, allowDifferentEmails: true,
  trustedProviders: ['google'] } },
```

Allowing a social identity to link to an existing account with a *different*
email widens the account-linking attack surface (linking/takeover scenarios).
Only relevant once Google OAuth is actually configured (it is optional in the
pilot). Safer default is `allowDifferentEmails: false` unless a concrete pilot
flow needs cross-email linking.

---

### 7. [P3] Test short-circuits inside production auth middleware
**`apps/server-pilot/src/trpc/trpc.ts:95-98` and `:108-118`**

`privateProcedure` and `mailboxProcedure` bypass the real Better-Auth session
lookup / mailbox-access check when the context already carries `sessionUser`
(resp. `activeTransportId` + `accessRole`):

```ts
const injected = (ctx as Partial<TrpcPrivateContext>).sessionUser;
if (injected) { return next({ ctx: { ...ctx, sessionUser: injected } }); }
```

**Not exploitable as wired** — the production context factory
(`main.ts:72`) only ever sets `{ auth, reqHeaders }`, so a client cannot inject
these fields. But it is a landmine: any future change that spreads
request/body-derived data into the tRPC source context would silently disable
authentication and mailbox isolation for every route. Gate the seam explicitly.

**Fix:** guard on `process.env.NODE_ENV === 'test'` (or an explicit injected
sentinel that can never come from a request) rather than on the mere presence of
the fields.

---

## Residual / correctness notes (lower priority, mostly deferred-scope)

- **N1 — Outbound recipient/subject not validated (SMTP header-injection surface).**
  `mail.send` / drafts accept `to/cc/bcc/subject` as `z.string()` (`mail.ts:507-513`),
  not `.email()`, and pass them to the transport. Harmless now (fake SMTP), but
  validate as email + reject CRLF **before** wiring the real relay, or a crafted
  recipient/subject can inject SMTP headers. `from` is correctly forced to
  `ctx.transportEmail` (spoof already blocked — good).

- **N2 — Ingest persistence is not actually one transaction.** `store.ts`
  docstring says message+attachment insert "in one transaction; commit," but
  `persistInboundMessage` runs `db.insert(message)` then `db.insert(attachment)`
  as separate statements (no `db.transaction(...)`). A failure between them leaves
  a message row with missing attachments, and the worker's DELE-after-commit
  safety order can then drop the POP3 source for a partially-stored message. Wrap
  both inserts in a single `db.transaction`.

- **N3 — Unbounded in-memory buffering → worker memory-DoS.** RETR loads the full
  message (`Readable.from([raw])`) and each attachment is drained to a Buffer
  (`streamToBuffer`) before the S3 PUT. A very large message/attachment can spike
  RSS on the single PM2 worker. Enforce a max message/attachment size before real
  ingest (the plan already flags PDF RSS as a gate).

- **N4 — Account-switch clears the wrong IDB key.** `nav-user.tsx:166-175` sets
  the cache scope to the **new** mailbox, then deletes
  `idbCacheKeyForScope(getMailCacheScope())` — i.e. the new scope's (empty) key —
  leaving the previous mailbox's persisted cache under its own key. **Not a
  cross-user leak** (same user owns both mailboxes), just stale same-user cache.
  Compute the delete key from the *previous* scope before switching.

- **N5 — No security headers at nginx.** `deploy/nginx.conf` sets no HSTS,
  `X-Frame-Options`, `X-Content-Type-Options`, or CSP. Not a standalone finding,
  but add `X-Frame-Options: DENY` + a strict CSP as part of the Finding-1 XSS fix
  (defense-in-depth for the HTML render), and an HTTP→HTTPS redirect.

---

## Verified strengths (isolation model holds — stated so these aren't re-litigated)

- **Client cannot select a mailbox it lacks access to.** The frontend sends the
  chosen mailbox in the `x-zero-active-transport` header
  (`query-provider.tsx:212`), and the server *verifies* it against `mailboxAccess`
  in `resolveMailboxContext` (`context.ts:34-55`) — a forged/other-tenant
  transport id yields `FORBIDDEN`, not access. This is the crux of the isolation
  and it is correct.
- **Every thread/message/draft/label/attachment lookup is `transportId`-scoped.**
  Cross-mailbox id guessing returns `NOT_FOUND` (`mail-helpers.ts`,
  and `and(eq(...id), eq(...transportId, ctx.activeTransportId))` throughout
  `mail.ts` / `drafts.ts` / `labels.ts`). Attachment access re-derives the
  transport from the message before signing a URL (`mail.ts:717-757`).
- **Send-as spoofing blocked.** `mail.send` forces `from = ctx.transportEmail` and
  rejects a mismatched `fromEmail` with `FORBIDDEN` (`mail.ts:518-520`).
- **SSM / shell injection closed.** `deploy/ssm-run-command.sh:20` base64-encodes
  the payload (`[A-Za-z0-9+/=]`, no shell metacharacters) before embedding in the
  RunShellScript JSON — this is the `7156f885` hardening and it is correct.
  `seed-prod.ts` invokes `aws` via `spawn` with an args array (no shell), also
  safe.
- **S3 key path-traversal closed.** Attachment keys are
  `attachments/{server-uuid}/{index}-{sanitized-filename}` — filename is
  `[^A-Za-z0-9._-] → _` and length-capped (`storage/s3.ts:149`); the messageId is
  a server-generated UUID, not user input.
- **Secret hygiene is good.** `.env.production` and `.env.*` are gitignored
  (`.gitignore:66-68`); `write-ec2-env.sh` creates the file mode `600` owned by
  `ubuntu` and never echoes the secret; pilot passwords are random
  (`randomBytes(18)`) + hashed (`hashPassword`) and stored in Secrets Manager —
  `seed-prod.ts` logs only emails and the secret *name*, never the passwords. No
  hardcoded credentials found in the diff.
- **POP3 TLS (deferred) is not weakened.** `openTls` uses Node's `tls.connect`
  defaults (`rejectUnauthorized:true`, SNI from host) and defaults `POP3_TLS` on;
  RETR message numbers are integers, so no POP3 command injection.

---

## Suggested pre-real-ingest gate (checklist before turning on real mail)

1. Wire the HTML sanitizer + sandboxed render + CSP (Finding 1).
2. Enforce relay strip/re-stamp of `X-Zero-Mailbox` and read the trusted value
   (Finding 2).
3. Turn on RDS cert verification with the CA bundle (Finding 3).
4. Validate outbound recipients/subject + reject CRLF (Note N1).
5. Bound message/attachment size (Note N3).

Findings 5–7 and Note N4 are independent of ingest and can be handled on their own
schedule.

---

*No code was modified by this audit. Report only.*
