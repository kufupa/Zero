# Audit A — Security-Hardening Fix Verification

Scope: verify 8 fix commits on branch `EC2-pilot` close the prior audit
(`docs/superpowers/plans/2026-07-01-ec2-pilot-security-audit.md`) findings, and
hunt for NEW bugs / bypasses the fixes introduced. Read-only; no code changed.

Calibration: solo dev, single EC2 + single private RDS, VPN/SSM, fixtures/fakes
this pass (real POP3/SMTP/VPN deferred). `[latent]` = only bites when real mail
is enabled. Severity P0–P3, weighted for real exploitability.

Method note: the sanitizer (Fix 1) was exercised empirically against 32 XSS /
tracking payloads using the exact production config against `sanitize-html@2.17.0`.

---

## Per-fix verdicts

### Fix 1 — stored-XSS sanitizer (`e917df5a` + `232c6feb`)  → FIXED (XSS); P2 [latent] residual (CSS tracking)

- Real library, not hand-rolled: `sanitize-html@2.17.0` (htmlparser2 tree-based),
  `apps/server-pilot/src/mail/sanitize-email-html.ts:1,86`.
- Empirically robust against script-execution XSS. All neutralized:
  `<script>`, `<img onerror>` / `oNeRrOr` mixed-case, `<svg onload>`,
  `<svg><script>`, `javascript:` / `JaVaScRiPt:` / `java\tscript:` /
  `java\nscript:` hrefs, `data:text/html`, `vbscript:`, `<iframe>`, `<object>`,
  `<embed>`, `<base>`, `<form>`, `<bgsound>`, `<meta refresh>`,
  `<details ontoggle>`, and the noscript/title/style-comment mXSS classics
  (title inner-HTML is entity-escaped). No script-exec bypass found.
- Wiring: applied in `mail.processEmailContent` only
  (`apps/server-pilot/src/trpc/routes/mail.ts:789-797`). It is **NOT** applied on
  the stored-ingest path (`store.ts` writes `parsed.htmlBody` raw, line 225) and
  **NOT** inline in `mail.get` — `mail.get` returns `toParsedMessage(...)` whose
  `processedHtml`/`decodedBody` fields are the **raw DB htmlBody**
  (`wire-compat.ts:168,189,191`). Sanitization is therefore client-triggered per
  render; the wire field literally named `processedHtml` is unsanitized (footgun
  for any future/mobile/API consumer that trusts the name). The live FE render
  path does re-sanitize via `processEmailContent` (see Fix 2), so this is an
  architectural fragility, not an active XSS today.
- **Residual P2 [latent] — remote-CSS tracking bypass (NEW surface from this fix).**
  The config adds `'style'` to `allowedTags` (`sanitize-email-html.ts:36`) and
  allows an unrestricted inline `style` attribute on `*`/`a`/`img`
  (lines 40,53,54) with no `allowedStyles`. Confirmed passthrough (unchanged):
  - `<style>@import url(http://evil/x.css);</style>` → emitted verbatim.
  - `<style>body{background:url(http://evil/track.png)}</style>` → verbatim.
  - `<p style="background:url(http://evil/track.png)">` → verbatim.
  - `<p style="position:fixed;...;width:9999px;height:9999px">` → verbatim.
  These load remote content / beacon the reader's IP **even when
  `shouldLoadImages=false`**, i.e. they defeat the image-blocking privacy control
  this very fix introduces, and enable CSS UI-redress inside the shadow root.
  `sanitize-html` itself prints: *"Your allowedTags option includes `style`,
  which is inherently vulnerable to XSS attacks."* No script-exec bypass was
  reproduced via `<style>`, but the library-flagged risk + the tracking channel
  make removing `style` (tag+attr filtering via `allowedStyles`) the correct
  hardening. `[latent]` because live tracking needs real attacker mail.

### Fix 2 — FE blocks raw-HTML fallback (`94c674de`)  → PARTIAL; P1 [latent]

- The added `resolveMailDisplayHtml`
  (`apps/mail/lib/mail/resolve-mail-display-html.ts`) is correct **for the
  non-demo path**: returns `processedHtml` when present, else
  `UNSAFE_MAIL_CONTENT_PLACEHOLDER` — never raw HTML. Good.
- **But that branch is dead on the shipped build.** `FORCE_FRONTEND_ONLY_DEMO =
  true` (`apps/mail/lib/demo/runtime.ts:7`) forces `isFrontendOnlyDemo()` true.
  Consequences in `mail-content.tsx`:
  1. the server-sanitize query is `enabled: !frontendOnlyDemo && Boolean(html)`
     (line 116) → **disabled** → `processedData` undefined.
  2. `resolveMailDisplayHtml({ frontendOnlyDemo:true, processedHtml:undefined,
     rawHtml })` takes the demo branch → `resolveMailHtml({ rawHtml })`
     (`resolve-mail-display-html.ts:19-24`).
  3. `resolveMailHtml` (`apps/mail/lib/mail/resolve-mail-html.ts:39-51`) is a
     **regex sanitizer that strips only `<script>`** (SCRIPT_TAG_REGEX) and
     html/head/body wrappers, then returns the rest. It does NOT strip
     `onerror`/event handlers, `<img onerror>`, `<svg>`, `javascript:` hrefs.
  4. result is injected via `shadowRootRef.current.innerHTML = resolvedHtml`
     (`mail-content.tsx:146`) → `<img src=x onerror=alert(1)>` **would execute**.
- Render is **Shadow DOM, not an iframe `sandbox`** (`mail-content.tsx:140`).
  Shadow DOM scopes CSS/DOM only, NOT script execution — the entire XSS defense
  rests on the sanitizer, no defense-in-depth. The task's "iframe sandbox without
  allow-scripts" is NOT satisfied.
- Not exploitable **now** only because demo mode renders local fixtures, not
  attacker mail. Hard coupling to document: **enabling real mail REQUIRES setting
  `FORCE_FRONTEND_ONLY_DEMO=false`** (and demo env off), otherwise the server
  sanitizer stays bypassed and raw attacker HTML is rendered through the weak
  regex path. P1 [latent].
- Dead legacy sink noted (not wired, not reachable): `EmailTemplate` in
  `apps/mail/lib/email-utils.client.tsx:196` does `dangerouslySetInnerHTML`, but
  the module is imported only for `handleUnsubscribe`/`highlightText`
  (thread-display.tsx:26, mail-list.tsx:31); the iframe renderer is unused.

### Fix 3 — X-Zero-Mailbox trust: last occurrence (`ac100dd5`)  → FIXED [latent] (documented residual)

- `lastHeader(headers,'x-zero-mailbox')` now used
  (`apps/server-pilot/src/mail/ingest/parse-message.ts:202,251-260`); routing in
  `store.ts` keys off `parsed.ownerHeaderValue` (lowercased) → active transport
  lookup (`store.ts:162,172-184`). `firstHeader` no longer used for the owner.
- Correctness caveat (as briefed): last-wins is safe **only if the trusted relay
  appends its stamp below any forged ones**. If the relay *prepends* without
  stripping, last-wins returns the attacker's value — worse than first-wins. The
  true guarantee is the relay STRIPPING inbound `X-Zero-Mailbox`, which makes
  order moot (single value).
- Relay-strip is documented as a **required hard gate** in both deploy docs:
  `deploy/deferred-real-mail-readiness.md:27,30` ("Strip rule (required before
  prod multi-user)… last occurrence… forged earlier values stripped") and
  `deploy/exchange-smoke.md:16-19` (transport rule + strip rule + `nava@` not
  internet-reachable + negative quarantine test). Residual trust is stated.
- `[latent]` — real POP3 ingest deferred. Verdict FIXED with the documented relay
  dependency being the load-bearing control.

### Fix 4 — RDS TLS CA verification (`e8ccba50`)  → FIXED; P3 residual (migrations)

- `getPostgresSslOptions()` returns `{ rejectUnauthorized: true, ca:
  readFileSync(<bundled pem>) }` (`apps/server-pilot/src/db/ssl-config.ts:5-8`).
  **Fail-closed**: a missing CA makes `readFileSync` throw → no connection (never
  silently no-verify).
- Applied on ALL runtime/seed/test DB paths:
  - `src/db/client.ts:28` (runtime pool)
  - `scripts/seed-prod.ts:91` (prod seed — prior duplicate `rejectUnauthorized:
    false` removed)
  - `tests/helpers/test-db.ts:30,58` (probe + tx-rollback tests)
  A repo-wide grep finds `rejectUnauthorized` only in `ssl-config.ts` (all other
  hits are docs). CA source = committed bundled file
  `deploy/rds-ca-global.pem` (AWS global bundle), force-unignored via
  `.gitignore` `!apps/server-pilot/deploy/rds-ca-global.pem` — deterministic, no
  deploy-time download.
- **Residual P3:** `drizzle.config.ts:4-6` uses `?sslmode=require` for
  `drizzle-kit` migrations = *encrypt but do NOT verify CA/hostname* (libpq
  `require` ≠ `verify-full`). MITM window exists during manual, dev-initiated
  migrations over VPN/SSM only — not a runtime/attacker-facing path. Worth
  upgrading to `verify-full` with the same CA for completeness. Not a regression
  (pre-existing; commit didn't touch it).

### Fix 5 — outbound field validation / SMTP header injection (`075cedfd`)  → FIXED

- `assertSafeOutboundFields`
  (`apps/server-pilot/src/mail/send/validate-outbound.ts:45-56`): rejects NUL/LF/CR
  in `subject` (`hasUnsafeChars`, char codes 0/10/13, lines 11-17) and validates
  every `to`/`cc`/`bcc` as an email (`EMAIL_RE`, line 9) — which independently
  forbids CR/LF/whitespace. Called in `mail.send` BEFORE the transport
  (`routes/mail.ts:635-640`).
- Drafts→send is covered: `drafts.ts` has **no send route**; sending is only
  `mail.send` with a `draftId` reference, and `mail.send` reads recipients from
  the request `sendInput` (validated), never from stored draft fields. No bypass.
- `from` spoof block preserved: SMTP `from` is forced to `ctx.transportEmail`
  (`routes/mail.ts:689`); a supplied `input.fromEmail` must equal
  `ctx.transportEmail` or → FORBIDDEN (lines 641-646). A CRLF in `fromEmail` can
  only fail that equality → rejected; the injected value is never transported.
- Display-name form `"Name <a@b.com>"` is **rejected** (space fails
  `[^\s@]+`) — safe (strict), no `"Name <...>"` injection surface.
- Bodies (`html`/`text`) are not header fields; not validating them is correct.

### Fix 6 — attachment filename in Content-Disposition (`f3e60acd`)  → FIXED; P3 nit

- `formatContentDispositionFilename`
  (`apps/server-pilot/src/mail/attachment-filename.ts:35-45`) strips `"` and all
  control chars (`code <= 0x1f || 0x7f`, lines 1-4), builds
  `attachment; filename="<ascii-fallback>"`, and adds RFC 5987
  `filename*=UTF-8''…` for non-ASCII. Applied at the real presign call site:
  `getSignedAttachmentUrl` → `ResponseContentDisposition:
  formatContentDispositionFilename(filename)` (`routes/mail.ts:948`).
- No CR/LF survive → no header injection into the S3 response; `"` stripped → no
  quoted-string breakout; semicolons stay inside the quoted string (inert);
  unicode routed through RFC 5987. Long names uncapped (S3-side limit) — cosmetic.
- **P3 nit:** backslash `0x5c` is not stripped/escaped, so a name ending `\`
  yields `filename="foo\"` (the `\` escapes the closing quote → malformed quoted
  string). Not injectable (no CRLF, no added attributes) — a robustness nit only.

### Fix 7 — restrict signup + tighten account linking (`4b031e7e`)  → FIXED (deployed config); P3 [latent] OAuth gap

- `allowDifferentEmails: false` (`apps/server-pilot/src/lib/auth.ts:105`),
  `accountLinking.enabled:true`, `trustedProviders:['google']` (103-107).
- Server-side enforcement is a real throwing hook, not a config flag:
  `hooks.before` runs `assertPilotSignupAllowed` on `/sign-up*` which throws
  `APIError('FORBIDDEN')` when the email is not allowlisted (auth.ts:109-116,
  34-40). Case/whitespace-normalized on both sides (`isPilotSignupEmailAllowed`
  trims+lowercases, 24-32). Non-string `ctx.body.email` → `undefined` →
  fail-closed (rejected).
- Deployed config: `write-ec2-env.sh:43` sets `PILOT_OPEN_SIGNUP='0'` and sets NO
  `PILOT_SIGNUP_ALLOWLIST` → allowlist empty → **all email/password signups
  blocked**. Seeded pilot users are NOT locked out: they are DB-seeded and
  authenticate via `/sign-in/*` (hook gates only `/sign-up`).
- **Residual P3 [latent] — OAuth signup not gated.** The `before` hook checks
  `ctx.path.startsWith('/sign-up')` only; Better Auth social account creation
  happens on `/sign-in/social` + `/callback/:provider`, which the hook does NOT
  cover. If Google is ever enabled, a first-time Google user creates an account
  bypassing the allowlist. Currently latent: Google creds are absent from
  `write-ec2-env.sh` → `getSocialProviders` returns `{}` → no OAuth path exists.
  Blast radius even if enabled is small: a bypass account has zero
  `mailbox_access` rows → `resolveMailboxContext` throws NO_MAILBOX → no data
  access. Still, gate social account creation before enabling Google.

### Fix 8 — limit tRPC auth injection to test env (`727833f9`)  → FIXED

- Both procedures gate the injection short-circuit on
  `const isTest = process.env.NODE_ENV === 'test'`
  (`apps/server-pilot/src/trpc/trpc.ts:100`): `privateProcedure` uses
  `isTest ? ctx.sessionUser : undefined` (105-107); `mailboxProcedure` uses
  `isTest ? ctx : {}` (121). In non-test the injected object is
  undefined/empty → the real `getSessionUser` / `resolveMailboxContext` always
  run (111-115, 131-139).
- Adversarially unreachable in production:
  1. `NODE_ENV` is a server process var, not settable by any request.
  2. Even if the gate were bypassed, the production context factory sets ONLY
     `{ auth, reqHeaders }` (`main.ts:74`) — it never populates
     `sessionUser`/`activeTransportId`/`accessRole`/`transportEmail` from request
     body/headers, so there is nothing to inject.
  3. Deploy pins `NODE_ENV='production'` (`write-ec2-env.sh:34`).
  Triple-safe. Verdict FIXED.

---

## New regressions introduced by these fixes

- **R1 [P2, latent] — sanitizer opened a remote-CSS tracking channel.** Fix 1's
  config newly permits `<style>` tags and unrestricted inline `style`, so
  `@import url(...)` / `background:url(...)` fetch remote content and beacon the
  reader even with images disabled — defeating the image-block the same fix adds,
  and enabling CSS UI-redress in the shadow root. Library emits an explicit
  `style`-is-XSS-risky warning. Fix: drop `style` from `allowedTags` and add an
  `allowedStyles` allowlist (no `url()`/`position:fixed`). See Fix 1 above.

- **R2 [P1, latent] — Fix 2's guarantee does not hold on the shipped build.**
  The "no raw-HTML fallback" placeholder branch is inert because
  `FORCE_FRONTEND_ONLY_DEMO=true` keeps the FE on the `<script>`-only regex
  sanitizer AND disables the server sanitizer query. This is a pre-existing demo
  flag rather than a bug the commit wrote, but the fix's protection is not on the
  active code path; enabling real mail without flipping the flag = live stored
  XSS. Treat "flip `FORCE_FRONTEND_ONLY_DEMO=false`" as a hard gate coupled to
  real-mail enablement.

- **No auth / cross-mailbox regression.** None of the eight fixes weakened
  transport scoping, `resolveMailboxContext`, the `from`-forcing spoof block, or
  attachment access re-verification (re-checked below).

---

## Confirmed strengths still holding after the fixes

- Every thread/message/label/draft/attachment lookup is `transportId`-scoped
  (`eq(...transportId, ctx.activeTransportId)`) throughout `routes/mail.ts` and
  `routes/drafts.ts` — unchanged by the fixes.
- Client-supplied mailbox (`x-zero-active-transport`) is verified against
  `mailboxAccess` in `resolveMailboxContext` (`trpc/context.ts:42-72`); unknown
  transport → FORBIDDEN. Unchanged.
- `mail.send` forces `from = ctx.transportEmail` and rejects a mismatched
  `fromEmail` with FORBIDDEN (`routes/mail.ts:641-646,689`). Preserved and now
  reinforced by CRLF/email validation (Fix 5).
- `getAttachment` / `getMessageAttachments` / `listAttachments` re-verify the
  message's `transportId` via `requireMessageForTransport` before returning
  metadata or a 5-minute presigned URL (`routes/mail.ts:827,868,907`,
  presign expiry line 952). Unchanged; the filename fix (6) rides on top safely.
- RDS TLS is now fail-closed with real CA verification on all runtime/seed/test
  paths (Fix 4).
