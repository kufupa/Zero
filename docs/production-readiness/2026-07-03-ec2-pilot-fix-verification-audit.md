# EC2-Pilot Fix-Verification Audit — `4b4a728c..EC2-pilot` (45 commits + working tree)

**Date:** 2026-07-03
**Auditor:** Claude Opus 4.8 (main thread) + 4 parallel domain sub-agents
**Scope:** All 45 commits since fork from `FE-demo-minimal` (merge-base `4b4a728c`), **plus the uncommitted working tree**. New per-mailbox backend `apps/server-pilot/**` (POP3 ingest, SMTP send, tRPC mailbox-scoped routes) + `apps/mail/**` cache/wire changes. Deploy target: single EC2 in hotel VPC via VPN tunnel → private RDS + S3, SSM access.

**No code was modified by this audit. Report only.**

## Method & why this pass exists

Two prior deep audits already exist and were thorough **as of ~26 commits**:
- `2026-07-01-ec2-pilot-security-audit.md` — 7 findings + notes N1–N5 + verified strengths.
- `2026-07-02-ec2-pilot-bug-hunt.md` — Slices A–E, ~60 correctness findings.

Since then, **12 "fix" commits (`e917df5a` → `79d1793b`) landed that patch those very findings**, and a further **uncommitted working tree** exists. None of that patch layer has been audited. This pass therefore does NOT re-derive the whole backend. It does three things:

1. **Verify each fix** closes its finding (FIXED / PARTIAL / STILL-OPEN) with `file:line` evidence.
2. **Hunt regressions** — new bugs the fixes introduced (the primary ask: "if you flag something, no new bugs come from it" → applied to the fixes themselves).
3. **Ponytail** the real `server-pilot` code for over-engineering (prior ponytail pass targeted the *plan* against old `apps/server`, not this code).

**Calibration** (unchanged from prior passes): solo dev, 1 EC2 + 1 RDS, private VPC, **fixtures/fakes only this pass — real POP3/SMTP/VPN deferred**. `[latent]` = only bites once real mail is enabled. Severity: P0 critical · P1 high · P2 moderate · P3 low.

## Agent allocation

| Agent | Domain | Commits / files | Output |
|---|---|---|---|
| A | Security-hardening fixes | `e917df5a,232c6feb,94c674de,ac100dd5,e8ccba50,075cedfd,f3e60acd,4b031e7e,727833f9` — sanitizer, FE HTML fallback, X-Zero-Mailbox, RDS TLS, outbound validation, attachment filename, signup guard, auth-injection gate | `audit-A-security-fixes.md` |
| B | Correctness / data-integrity / wire-contract fixes | `e5bda6b0,4b173f5e,1df697b5,79d1793b` — transactional ingest+limits, tRPC POST + wire-compat, soft-delete bin + seed/benchmark guards, threading/date/keyset | `audit-B-correctness-fixes.md` |
| C | Uncommitted working tree | `git diff` HEAD..worktree — 17 files incl. context/connections/smtp/main/nginx/pm2/write-ec2-env + new cache-ttl/auth-session-ttl | `audit-C-uncommitted.md` |
| D | Ponytail (over-engineering) | whole `apps/server-pilot/src` — wire-compat.ts, driver/types, facades, dead config | `audit-D-ponytail.md` |

---

## STATUS: COMPLETE (all 4 agents reported; high-severity claims main-thread-verified against source).

> **Note — the branch moved during the audit.** The overnight autonomous run committed `d35acfb0 fix: IDB leak session TTL and NO_MAILBOX handling` (wave 4) mid-pass — HEAD went 45→46 commits. That commit **committed** the 400-day session TTL and the `NO_MAILBOX` handling (so those two findings are now *committed*, not working-tree). Wave-5 ops changes (nginx `35m`, `setDefault`, env-quoting, pm2) remain **uncommitted**. Findings are unaffected; only committed/uncommitted labels shift.

## Headline (read this first)

The fixes are, on the whole, **real and correct** — most prior findings are genuinely closed, and **tenant/mailbox isolation was preserved through every reshaped query** (the thing that matters most for a multi-tenant mail server; independently confirmed by Agents A, B, C). **No P0 and no cross-mailbox data leak** in the committed tree.

But the fixes introduced **new bugs** (the user's explicit concern), and the single biggest security item is a **hardening step that went the wrong way**:

1. **[P1 · SECURITY] Session revocation is dead for 400 days** — a session-TTL "fix" set `cookieCache.maxAge` to 400d (should be minutes). On shared hotel workstations this is effectively P0. **New regression, committed.**
2. **[P1 · DATA-LOSS] Draft bodies vanish on reload** — the wire-contract fix writes draft body to `htmlBody` but reads it from `textBody`. **New regression, committed.**
3. **[P1 · latent SECURITY] Stored-XSS gate is the top pre-real-mail blocker** — a real sanitizer exists but is not on the serving path, and the shipped FE renders inbound HTML through a `<script>`-only regex into shadow DOM. Safe *only* because ingest is fixtures-only today.

---

## Consolidated findings — ranked (security-first)

### LIVE NOW (committed / shipping state — reachable without real mail)

| # | Sev | Finding | File:line | Source |
|---|-----|---------|-----------|--------|
| 1 | **P1** (P0 shared-PC) | **Session revocation dead ≤400 days.** `cookieCache.maxAge = SESSION_TTL_SEC (400d)`; Better Auth trusts the signed cookie without a DB check for that window → logout-everywhere / offboard / compromise-kill all inert. Fix: `maxAge: 300`, keep `expiresIn` 400d. ⚠️ `auth-session-ttl.test.ts` (untracked) asserts 400d → green-locks it. | `lib/auth.ts:98` (committed `d35acfb0`) | C + main verified |
| 2 | **P1** | **Draft body lost on reload.** `drafts.create` hardcodes `textBody:null`, stores body in `htmlBody`; `get`/`list` return `content/body: r.textBody` (null); FE reads `draft.content`. Reopen draft ⇒ empty editor. | `drafts.ts:155-156,128,99` (committed `4b173f5e`) | B + main verified |
| 3 | P2 | **Benign zero-mailbox user gets HTTP 500.** `code: 'NO_MAILBOX' as 'FORBIDDEN'` — cast lies to TS; runtime string isn't a valid tRPC code ⇒ tRPC returns `INTERNAL_SERVER_ERROR`(500); server log-spam + TanStack retries. Use `'FORBIDDEN'`/`'NOT_FOUND'`, keep the message. | `trpc.ts:59` (committed `d35acfb0`) | C + main verified |
| 4 | P2 (ops) | **Adding a pilot user drops other users' stored passwords.** seed-prod `put-secret-value` replaces the whole secret JSON with only the changed creds. No lockout (recover via `--rotate`) but silent. | `scripts/seed-prod.ts:102` | B |
| 5 | P3 | **`bulkDelete` is a toggle, not idempotent** — a retried/second call flips trashed rows back and the "delete forever" path can hard-delete before undo. | `mail.ts:556-568` | B |
| 6 | P3 | `connections.setDefault` = 2 non-transactional UPDATEs; partial failure ⇒ momentarily no default (non-fatal fallback). Wrap in a tx. | `connections.ts:121-133` (uncommitted) | C |
| 7 | P3 (hygiene) | `.gitignore` only ignores one CE file; untracked `.claude/`, `.tmp-research/`, `.cursor/` exposed to `git add .` — `.tmp-research/` holds deploy artifacts. Verify before bulk-add. | repo root | C |

### LATENT — must be closed before real POP3/SMTP is enabled (hard gate)

| # | Sev | Finding | File:line | Source |
|---|-----|---------|-----------|--------|
| L1 | **P1** | **Stored-XSS on the render path.** `sanitizeEmailHtml` (real `sanitize-html`, 32 payloads neutralized ✔) is wired **only** into `processEmailContent` — *not* into ingest-store (stores raw `htmlBody`) nor `mail.get` (returns raw). AND `FORCE_FRONTEND_ONLY_DEMO=true` (runtime.ts:7) makes the FE render inbound HTML through `resolveMailHtml` — a **`<script>`-only regex** — into `shadowRoot.innerHTML` (shadow DOM, **not** an iframe sandbox), so `<img onerror>` executes. Gate: sanitize on `mail.get`/ingest **and** flip the demo flag **and** move to a sandboxed iframe before real mail. | `mail.ts:713,790`; `resolve-mail-display-html.ts:19`; `runtime.ts:7` | A + main verified |
| L2 | P2 | Sanitizer config allows `<style>` + unrestricted inline `style` ⇒ `@import`/`background:url()` fetch remote content **even with images off** (tracking-pixel bypass + CSS UI-redress). `sanitize-html` itself warns `style` is XSS-risky. New surface from the sanitizer fix. | `sanitize-email-html.ts` | A |
| L3 | P2 | **Poison-message quarantine is dead code.** The retry counter is a fresh per-cycle `Map` (`worker.ts:113`), never shared across cycles, so `POISON_MAX_RETRIES` is never reached ⇒ a parse-failing message retries **forever** + head-of-line starvation. Prior A8 not actually fixed. | `worker.ts:113,305` | B |
| L4 | P2 | **Memory-DoS limit is applied too late.** Message-size check runs *after* the full RETR buffer + S3 PUT (`worker.ts:145-156` before `parse-message.ts:79`) ⇒ doesn't prevent the RSS spike it targets. Prior N3 only partially fixed. | `worker.ts:145`, `parse-message.ts:79` | B |
| L5 | P1 | **Real POP3 client still non-functional (waves 6–7 not built).** No commit rewrote `pop3-client.ts`; prior A3 (readLine drops buffered bytes → hangs), A4 (UTF-8 corrupts raw MIME), A5 (password never sourced), A6 (no socket timeout) remain. `MAIL_TRANSPORT_MODE=real` cannot work yet. Expected (fixtures pilot) but a hard gate. | `mail/ingest/pop3-client.ts` | B + main (commit log) |
| L6 | P3 | X-Zero-Mailbox routing now reads `lastHeader` ✔ — safe **only if** the relay strips inbound stamps and **appends** its own. Documented as a required gate in `deferred-real-mail-readiness.md` / `exchange-smoke.md`. Residual trust; confirm relay behavior at handoff. | `parse-message.ts` | A |
| L7 | P3 | Keyset `COALESCE(ts,epoch)` vs `ORDER BY DESC` (NULLS FIRST) disagree — a NULL-timestamp row could drop from page 2+. No null producer today (ingest falls back to `new Date()`). Prior B19 still latent. | `mail.ts:283` vs `mail-helpers.ts:73` | B |
| L8 | P3 | Attachment S3 orphans on every ingest retry (fresh `messageId`), amplified by L3's infinite retry. | `worker.ts:146` | B |
| L9 | P3 | Signup allowlist hook gates only `/sign-up*`, **not** OAuth `/sign-in/social` + `/callback`. If Google is ever enabled, first-time Google users bypass the allowlist (blast radius small: 0 `mailbox_access` ⇒ NO_MAILBOX). Google is absent now. | `lib/auth.ts` | A |
| L10 | P3 | `drizzle.config.ts` migration path still `sslmode=require` (encrypt, no CA verify) — dev/VPN only, not the runtime pool. | `drizzle.config.ts` | A |

### Security fixes — CONFIRMED FIXED (do not re-litigate)

`sanitize-html` is a real library, not hand-rolled regex (32-payload test clean) · RDS TLS `rejectUnauthorized:true` + bundled committed CA on **all** runtime/seed/test paths, **fail-closed** (throws if CA missing), no `false` anywhere · outbound `to/cc/bcc/subject` reject CR/LF/NUL + email-validated pre-transport, `from` forced to `transportEmail` (spoof ⇒ FORBIDDEN) · attachment `Content-Disposition` strips `"`+control chars, RFC 5987 for unicode, applied at the real presign site · signup allowlist is a **real throwing `before` hook**, `allowDifferentEmails:false`, deployed config blocks open signup, seeded users unaffected · **tRPC auth-injection bypass now gated on `NODE_ENV==='test'`** (prod context sets only `{auth,reqHeaders}`; request can't set NODE_ENV ⇒ triple-safe) · **X-Zero-Mailbox reads `lastHeader`** · mailbox isolation intact (transport scoping, `resolveMailboxContext`, attachment re-verify).

### Correctness fixes — CONFIRMED FIXED

`allowMethodOverride:true` (tRPC 405 gone) · wire contract B3/B4/B5/B6/B8/C1/C10 aligned to real FE call sites · soft-delete `trashedAt` + `isNull` filter on all non-bin folders + restore + cascade on empty-bin · seed-prod lockout D4 (secret-first, create-or-put, rotate-gated) · benchmark prod-guard D8 · threading A1/A9/A13 + thread-metadata A10 + Date-header A2 · keyset pagination B2 (cursor in WHERE, token from post-filter last row, id tie-break) + drafts keyset · `toggleImportant` B9 · graceful shutdown D14 · env quoting D7 (uncommitted) · nginx `35m` C5 + security headers N5 (uncommitted) · `setDefault` persistence C2 (uncommitted) · bonus: A7/A11/A14/A15/D3/D9/D15/B10/B11/B12/B18.

### Still-open prior findings NOT touched by the fixes
C4 zero-mailbox sign-out loop — *now* handled via NO_MAILBOX (finding #3) but with the 500 bug · B13 `mail.send` non-transactional (ghost thread on SMTP fail) · most E1–E8 frontend-cache privacy items (E1 anon-bucket cross-user hydrate, E2 logout race, E3 QueryClient recreate) · D6 btree-on-jsonb settings index (long `customPrompt` ⇒ save fails) · prior C8 cookieCache — *made worse*, see finding #1.

---

## Main-thread cross-plan observations (recorded before agent reports — from reading the two fix-plans)

These come from reading `2026-07-02-ec2-pilot-bug-fixes.md` + `-autonomous.md` (the plans that drove the fix commits). Agents see the code, not the plan intent — so these are captured here to not be lost:

- **[SECURITY — HIGH] 400-day `cookieCache.maxAge` kills session revocation.** The plans (Task 11, "Cache policy locked") deliberately set Better Auth `session.cookieCache.maxAge = 400 days` **equal to** `expiresIn = 400 days` (rationale: "skips DB on routine requests"). `cookieCache.maxAge` is how long the signed session cookie is trusted **without re-checking the DB session row** — so deleting a session (logout-everywhere, compromised-account kill, staff offboarding) is **invisible for up to 400 days**. Prior bug-hunt C8 already flagged the *30-day* value as too long; this change made it **13× worse**. On **shared hotel front-desk workstations** (the actual deployment) this is a real risk: a revoked/offboarded user's cookie keeps working. **Correct shape:** long `expiresIn` (400d) is fine, but `cookieCache.maxAge` should be short (minutes) so revocation is observed. → Agent C is verifying the committed/uncommitted `auth.ts` value; confirm on synthesis.
- **[SCOPE] Waves 6–7 not committed → real POP3 still non-functional.** Commit log ends at wave 3 (`79d1793b`, mail core). Wave 6 (Task 16 RealPop3Client byte-safe rewrite; fixes prior A3–A6) and wave 7 (Task 19 `MAIL_TRANSPORT_MODE` + RealSmtp) show **no commits** touching `pop3-client.ts`. So the prior bug-hunt's A3 (readLine loses buffered bytes → real POP3 hangs), A4 (UTF-8 corruption of raw MIME), A5 (password never sourced), A6 (no socket timeout) are **[latent] still-open** — real Exchange POP3 cannot work yet. This is expected (fixtures-only pilot) but must be a hard gate before IT enables real mail. → Agent B confirming what's unpatched.
- **[PROCESS RISK] Fixes were auto-generated (composer-2.5) + auto-deployed overnight to real EC2/RDS** with `--rotate`-gated seed and forward-only migrations on prod RDS. Elevated regression risk on the reshaped queries — exactly why the tenant-scope regression hunt (Agents A/B) is the priority.
- **[INTENT vs BUG disambiguation for synthesis]** The plan states these are **intentional**, so do NOT flag as bugs: FE AI routes 404 (`trpc.ai.*` not ported); bulk inputs accept FE's `{ ids }` shape via wire-compat; `staleTime` stays 60s while persist TTL is Infinity; fixture transport is the default on prod. Real findings must be *outside* these documented decisions.

## Consolidated findings (rolling — most severe first)

_security/correctness findings pending Agents A/B…_

### Uncommitted working tree (Agent C — COMPLETE) · no tenant-scope drop found

Reviewed working-tree-vs-HEAD + new untracked files. All UNCOMMITTED WIP. **No cross-mailbox leak in any changed query.**

- **[P1 · SECURITY · MAIN-THREAD VERIFIED] Session revocation dead for 400 days.** `apps/server-pilot/src/lib/auth.ts:98` — `cookieCache: { enabled: true, maxAge: SESSION_TTL_SEC }`, `SESSION_TTL_SEC = 60*60*24*400`. Better Auth trusts the *signed session cookie without a DB lookup* for `cookieCache.maxAge`; setting it to 400d means deleting a session row (logout-everywhere, compromised-account kill, staff offboarding) is **inert for up to 400 days**. The Task-11 plan intended `maxAge ~300s`; the fix set it 400d — the wrong direction, and **13× worse than the pre-existing 30d** that bug-hunt C8 already flagged. `expiresIn`/`updateAge` (400d / 7d) are fine — *only `cookieCache.maxAge` is the defect.* **P0 on shared hotel front-desk workstations.** Fix: `cookieCache: { maxAge: 300 }` (keep `expiresIn` 400d). ⚠️ **Test-locked:** `apps/server-pilot/tests/auth-session-ttl.test.ts` asserts the 400d value → green-locks the regression; that test must change with the fix. *(verified against source by main thread.)*
- **[P2 · MAIN-THREAD VERIFIED] `NO_MAILBOX` → HTTP 500 for benign users.** `apps/server-pilot/src/trpc/trpc.ts:59` — `new TRPCError({ code: 'NO_MAILBOX' as 'FORBIDDEN' })`. The `as 'FORBIDDEN'` cast only silences TypeScript; the runtime code string `'NO_MAILBOX'` is not a valid tRPC code, so tRPC maps it to `INTERNAL_SERVER_ERROR` → **HTTP 500** whenever a signed-in user has no mailbox access. FE toast still fires (matches `err.message`), but `main.ts` onError log-spams and TanStack Query retries the 500s. This is a regression from the Task-12 zero-mailbox fix. Fix: use a real code (`'FORBIDDEN'` or `'NOT_FOUND'`) and keep the `NO_MAILBOX` message for the FE to match. *(verified against source by main thread.)*
- **[P2-when-real / latent] Worker `autorestart:false` masks crashes.** `apps/server-pilot/deploy/pm2.config.cjs:20` — `worker.ts:302` is a persistent poll loop; with `autorestart:false`, a crash halts POP3 ingest **permanently, silently**. Chosen to mask prior D5 restart-churn, but the correct fix is `min_uptime` + `max_restarts`, not disabling restart. Latent now (POP3 deferred) → P2 once real ingest lands. (HTTP app keeps autorestart — good.)
- **[P3] `connections.setDefault` = 2 non-transactional UPDATEs** (`connections.ts:121-133`): partial failure → user momentarily has no default (non-fatal, falls back to highest-role). Wrap in a tx.
- **[P3 · client-only] `cache-ttl.ts` `Infinity` gcTime + persist maxAge**: unbounded client memory growth over a long-lived session; stale mail lingers in the browser after logout (mitigated by the IDB cleanup, but Infinity persist means nothing ages out). Deliberate per plan — noted as tradeoff, not a bug.
- **[hygiene] gitignore gap:** only `.compound-engineering/config.local.yaml` is ignored; sibling untracked dirs (`.claude/`, `.tmp-research/`, `.cursor/`) are exposed to a careless `git add .`. No secret in the tracked diff, but `.tmp-research/` holds deploy artifacts — verify before any bulk add.

**Verified OK (no finding), incl. prior findings now confirmed FIXED in the working tree:**
- `context.ts` — requested-transport path scoped `userId + transportId` (FORBIDDEN on miss); default path scoped `userId`, ordered `isDefault → role`. No leak.
- `connections.ts` — **prior C2 FIXED**: default now persists (`is_default` column); all queries `userId`-scoped.
- `mail.ts` — snooze-clear / inbox / markUnread all `transportId`-scoped; `toggleImportant` now uses literal `'IMPORTANT'` matching `labels.ts:18` synthetic id → **prior B9 no-op FIXED**.
- `smtp.ts` — fake-only ring buffer; from-forcing + real/fake switch unchanged (spoof block intact).
- `main.ts` — SIGTERM/SIGINT graceful shutdown added (**prior D14 FIXED**); auth/route mount order unchanged.
- `write-ec2-env.sh` — **prior D7 FIXED**: all values single-quote-escaped.
- `nginx.conf` — **prior C5 FIXED** (`client_max_body_size 35m`); security headers already present (**prior N5 FIXED**).
- `schema/mail.ts` — `is_default` + quarantine unique index; matches migrations 0002/0003.

### Ponytail / over-engineering (Agent D — COMPLETE) · net −120 lines, −0 deps

Over-engineering only; none are bugs. Ranked biggest-cut-first:

| # | Tag | Cut | Path | Conf |
|---|-----|-----|------|------|
| D-1 | delete | `driver/types.ts` — whole file is a TODO placeholder shell, **zero importers** (~33 lines) | `apps/server-pilot/src/lib/driver/types.ts` | high |
| D-2 | delete | `requireMailboxAccess` + `requireMailboxAccessFactory` — **zero call sites**; every route already uses `mailboxProcedure` middleware (~58 lines incl. barrel exports) | `apps/server-pilot/src/trpc/trpc.ts` | high |
| D-3 | delete | `customProviders`/`isCustom`/`customRedirectPath` — always-empty array + dead branches, multi-provider scaffolding for a 1-provider pilot (~10 lines + `main.ts` block) | `apps/server-pilot/src/lib/auth-providers.ts` | high |
| D-4 | delete | dead re-export `export { and, eq, desc, … }` — nobody imports operators from here | `apps/server-pilot/src/trpc/routes/mail-helpers.ts:53` | high |
| D-5 | yagni | `RealSmtpTransport` — `send()` just throws, gated behind `SMTP_ENABLE_REAL` nothing sets. Pure stub for out-of-scope work (unlike the working `RealPop3Client`) | `apps/server-pilot/src/mail/send/smtp.ts` | high |
| D-6 | yagni | `schema-contract.test.ts` — 12 brittle "table X is undefined" census assertions, no behavioral value | `apps/server-pilot/tests/schema-contract.test.ts` | med |
| D-7 | yagni | `deploy-config.test.ts` — 5 `readFileSync + toContain` string-greps against nginx/shell, not behavior | `apps/server-pilot/tests/deploy-config.test.ts` | med |
| D-8 | shrink | duplicated `spawn('aws', …)` helper — merge into one (~25 lines) | `scripts/load-50-users.ts` + `scripts/seed-prod.ts` | med |
| D-9 | shrink | 4 near-duplicate JSON-credential-parse blocks — extract one normalizer (~15 lines) | `scripts/load-50-users.ts:loadPasswords()` | med |
| D-10 | — | unused indexes `note_is_pinned_idx`, `user_settings_settings_idx` (borders perf lens; also flagged separately by prior bug-hunt D6 as a *correctness* risk — btree on jsonb can overflow) | `apps/server-pilot/src/db/schema/*` | low |

**Approved as lazy-correct (do not re-litigate):** `wire-compat.ts` (genuine translation, not needless shim), hand-rolled `pop3-client.ts` (no good POP3 lib exists), `storage/s3.ts` Real+Fake pair (both real, used by tests), `sanitize-email-html.ts` (**correctly delegates to `sanitize-html` dep — not a hand-rolled regex sanitizer**), `parse-message.ts` (uses `mailparser` dep), `ssl-config.ts` (4 lines), `trpc/index.ts` barrel (real package boundary).

---

## Recommended action order (no code changed by this audit — this is the fix queue)

**Before merging the current branch (live bugs):**
1. `auth.ts:98` → `cookieCache: { maxAge: 300 }` (keep `expiresIn`/`updateAge` 400d) + update the untracked `auth-session-ttl.test.ts` to assert the short value. *(finding #1 — the one true security fix in the live set.)*
2. Draft body: make `drafts.create` persist + `get`/`list` read the **same** column as the FE's `draft.content`. *(finding #2 — data loss.)*
3. `trpc.ts:59` → real tRPC code. *(finding #3 — stop 500s.)*
4. seed-prod: merge into the existing secret JSON instead of replacing it. *(finding #4.)*

**Hard gate before `MAIL_TRANSPORT_MODE=real` (do not enable real POP3/SMTP until all green):**
- [ ] Sanitize on `mail.get` + ingest-store, not just `processEmailContent`; drop `<style>`/inline-style from the allowlist; render in a sandboxed iframe; flip `FORCE_FRONTEND_ONLY_DEMO=false`. *(L1 + L2 — the top blocker.)*
- [ ] Build waves 6–7: RealPop3Client byte-safe rewrite (A3–A6) + `RealSmtpTransport` + transport-mode factory. *(L5.)*
- [ ] Share the poison-retry counter across cycles so quarantine actually fires; move the size check before RETR-buffer/S3-PUT. *(L3 + L4.)*
- [ ] Confirm the Exchange relay strips inbound `X-Zero-Mailbox` and appends its own stamp. *(L6.)*
- [ ] Deterministic raw-mime S3 key to stop retry orphans. *(L8.)*

## Ponytail (separate track, not blocking)
Cut ~120 lines of dead/speculative code (Agent D table above): `driver/types.ts`, unused `requireMailboxAccess` facade, `customProviders` scaffolding, `RealSmtpTransport` stub, dead barrel re-exports. Zero dependency removals — deps are all in genuine use.

## Coverage / confidence
- 46 commits (`4b4a728c..d35acfb0`) + uncommitted wave-5 ops, all audited across 4 domains.
- Every **P1** claim (findings #1, #2, L1, L5) and both verified **P2s** (#3) re-read against source by the main thread. P2/P3 latent items are agent-verified at ~95%; a few marked residual.
- **No P0, no cross-mailbox leak** in the committed tree — the isolation model held through every reshaped query (the primary risk for this system).
- Sub-agent detail: `audit-A-security-fixes.md`, `audit-B-correctness-fixes.md`, `audit-C-uncommitted.md`, `audit-D-ponytail.md` (same directory).

*No code was modified by this audit. Report only.*
