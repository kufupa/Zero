---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
plan_depth: standard
date: 2026-08-22
---

# fix: Restore mail content and message-header containment

## Goal Capsule

Restore usable mail reading despite transient remote-admin failures, without weakening HTML safety. Make mail-content processing failures observable and retryable. Keep every newest-message Reply, Reply All, and Forward control inside its actual reading pane, including a narrow desktop split.

- **Authority:** User-visible safe rendering and pilot-RDS safety override implementation convenience. Never render unprocessed HTML to recover from an API fault.
- **Execution profile:** U2 removes a duplicate latest-message prefetch and adds visible safe-content states. U3 changes message-header containment. U1 is an operational prerequisite using existing guarded deployment tooling; execute production recovery only with explicit deployment authorization.
- **Stop conditions:** Stop live recovery if target health contradicts the documented dual-plane failure, the host-forward lifecycle is unknown for any reason other than a verified absent rule with `unused` target, the live checkout differs from the approved immutable commit, or required access is unavailable. Do not guess at a server-side fix.
- **Tail ownership:** An implementation run owns targeted tests and code review; deployment, commit, and merge remain user-directed.

---

## Product Contract

### Summary

Staff must see safe processed email content or an honest retryable state. Every visible per-message response control must remain usable inside the reading pane.

### Problem Frame

Three linked failures produce misleading mail-reader behavior:

- Screenshot evidence captured an HTTP 502 on the remote-admin path. A public `/api/public/providers` probe now succeeds, so the edge is currently reachable; a recorded prior incident shows that a missing private `:8443` Nginx listener can produce the historical symptom while local `:8789` remains healthy. Exact processor-request failure is not currently reproduced.
- Non-demo `MailContent` requires `mail.processEmailContent` before it renders any body. The query exposes neither pending nor error state; both leave `processedData` absent and select the same intentionally safe “Unable to load message content safely” placeholder.
- `useThread` also launches an unobserved `email-content-v2` query for only the latest message. When its theme and image-trust key match `MailContent`, its failed result enters the same query cache before the visible reader mounts; both queries disable mount refetch. This latest-only prefetch can make an ordinary top message show the safe fallback until an explicit retry.
- The visual first row is the chronological latest message. Only its `Message reply actions` receive visible `r` / `a` / `f` shortcut badges, gated by browser `md` rather than the narrower resizable reading pane. Long recipient strings and an incomplete shrink chain push this wider latest-only header past the clipped pane edge.

This plan does not change MIME parsing, stored-XSS policy, image-trust policy, message reply targets, or intentional no-raw-HTML behavior.

### Requirements

- **R1. Public API verification.** The deployed remote-admin edge must route public `/api/` traffic through the ALB-only private `:8443` Nginx plane to `:8789`, with no regression to legacy hotel ingress. Public remote `/health` remains intentionally unavailable; the ALB health probe uses its private-IP host route. Recovery runs only if this verification fails.
- **R2. Honest safe-content states.** `MailContent` is the single visible owner of its processing query. Disable automatic processing retries so failures become explicit. While processing is pending, show polite announced loading state. On failure, show an announced non-sensitive manual-retry state. Retry enters an announced busy state and prevents duplicate activation. Render no raw mail HTML in non-demo mode.
- **R3. Pane-contained message actions.** Per-message Reply, Reply All, and Forward controls must remain visible and operable within the reading pane at a narrow desktop split. Latest-message hotkey hints must not create a layout-only difference from lower messages.
- **R4. Regression proof.** Tests must distinguish safe success, loading, and failure paths, and must assert message-header geometry rather than only Tailwind source tokens.

### Acceptance Examples

- AE1. When processing succeeds for a normal booking email, its sanitized processed HTML replaces loading state without exposing raw source HTML.
- AE2. When processing fails, staff hear and see concise safe failure copy with Retry. Retry becomes busy and disabled immediately; successful retry replaces failure state without changing focus unexpectedly.
- AE3. When visual latest message has a long recipient address in a narrow desktop pane, Reply All remains fully visible and actionable.

### Scope Boundaries

#### Included

- Current remote-admin ingress verification and conditional recovery proof.
- Removal of the latest-only unobserved content prefetch.
- Safe content pending/error/retry UX.
- Latest-message header containment and geometry regression coverage.

#### Deferred to Follow-Up Work

- Persisting pre-rendered display variants per trust/theme.
- Replacing the Shadow DOM reader with sandboxed iframe architecture.
- General mail-shell refactors unrelated to header geometry.

#### Non-Goals

- MIME parser changes.
- Relaxing stored-XSS sanitization or external-image policy.
- Changing reply target selection.
- Sending, deleting, or modifying pilot mail as part of visual verification.

---

## Planning Contract

### KTD1. Verify availability before changing ingress

Treat the screenshot 502 as a recorded availability incident, not a currently confirmed root cause. First prove current public API routing and then trace a reproduced `mail.processEmailContent` failure if one remains. If verification fails, recover with the already-tested dual-plane Nginx deployment contract. Do not add a permissive client fallback: a standard booking email does not become unsafe because its processing request failed.

### KTD2. Preserve server-authoritative HTML processing

Do not use `decodedBody` or wire `processedHtml` as a client-side fallback. Delete the duplicate unobserved latest-message prefetch so `MailContent` owns its visible query lifecycle. Keep `resolveMailDisplayHtml` unchanged as the hosted-mode security backstop. Disable automatic retries; one user-initiated, in-flight-guarded retry invokes the same server contract without exposing error classification to staff.

### KTD3. Make message-header layout depend on pane capacity

Keep keyboard handling thread-scoped, but remove latest-only visual shortcut badges from message-header buttons. Make recipient summary and action-group flex children shrink and wrap within their parent pane. Do not use browser-width breakpoints as a proxy for reading-pane width; a desktop viewport can still contain a narrow split pane.

---

## Implementation Units

### U1. Verify remote-admin API ingress before recovery

**Goal:** Establish whether the live remote-admin edge currently blocks content processing and invoke guarded recovery only on a measured ingress failure.

**Requirements:** R1  
**Dependencies:** None  
**Files:** No source edit expected. Operate through existing `apps/server-pilot/deploy/deploy-ec2.sh`, `apps/server-pilot/deploy/post-boot-smoke.sh`, `apps/server-pilot/deploy/remote-admin-cutover.sh`, and dual-plane/lifecycle checks in `apps/server-pilot/tests/`.

**Approach:**
1. Measure public API routing, current ALB target state, exact host-forward rule, and host-routed private `:8443` health. If all are healthy, record result and do not deploy.
2. Before any recovery, pin the approved immutable commit, compare it with the live EC2 checkout, and stop if the live box is ahead or dirty. Merge/retain live-only work before bundle sync; the sync path force-checks out and hard-resets its supplied commit.
3. Confirm the pinned candidate still contains both legacy `:443 → :8788` and IP-scoped remote `:8443 → :8789` blocks plus the candidate refuse gate. With explicit deployment approval, deploy it and prove both loopbacks plus host-routed private remote health before touching public routing.
4. If the exact host-forward rule exists, leave it in place and wait for target health after private-plane proof. If the rule is absent and target is `unused` or lifecycle `unknown`, do not call `remote-admin-cutover.sh restore`: manually recreate the exact priority-10 host-forward rule, wait for target health, then prove public API. Any other unknown lifecycle state is a manual stop.
5. Public remote `/health` returning 404 is expected; prove public `/api/public/providers` instead. Record only status/health evidence, not mail payloads or credentials.

**Patterns to follow:** Dual-plane recovery order in `docs/solutions/workflow-issues/remote-admin-legacy-only-nginx-wipe-502.md`; existing semantic deploy assertions in `apps/server-pilot/tests/deploy-config.test.ts`.

**Test scenarios:**
- Existing deployment contract rejects a legacy-only candidate before replacing a live site.
- Existing deployment contract rejects a remote-only candidate before replacing a live site.
- Existing lifecycle coverage keeps `unused` target state classified as `unknown` and refuses automated restore.
- Recovery proof confirms legacy and remote loopbacks, IP-scoped `:8443` ALB health routing, host-rule restoration, target health, and public remote API routing independently.
- Public `/api/` is reachable without changing legacy behavior; recovery is exercised only if this check fails.

**Verification:** Public remote-admin API route is healthy; ALB target is healthy; legacy hotel ingress remains healthy. Public remote `/health` remains 404 by design. If all checks are already healthy, U1 makes no production change. Recovery uses only the pinned commit after live-checkout comparison. No Vitest invocation may point at pilot RDS.

### U2. Model safe mail-content loading and failure explicitly

**Goal:** Keep no-raw-HTML protection while replacing the ambiguous permanent-looking placeholder with honest pending and retryable error states.

**Requirements:** R2, R4. Covers AE1, AE2.  
**Dependencies:** None; U1 is required only for live proof.  
**Files:** `apps/mail/hooks/use-threads.ts`; `apps/mail/components/mail/mail-content.tsx`; `apps/mail/tests/mail-content-fallback.test.ts`; new `apps/mail/tests/mail-content-rendering.test.tsx`; `apps/mail/vitest.config.ts`; `apps/mail/package.json`; lockfile

**Approach:**
1. Delete `useThread`’s unobserved latest-message `email-content-v2` prefetch and now-unused trust/theme/mutation imports. `MailContent` remains the only owner of the visible content-processing query.
2. Keep `resolveMailDisplayHtml` unchanged as the security fallback. In `MailContent`, branch on React Query pending, success, terminal error, and retry-fetching before exposing the Shadow DOM host; no branch passes raw HTML to it.
3. Set query `retry: false`. Render loading with `role="status"` and terminal failure with `role="alert"`. Give Retry an explicit accessible name, preserve focus on that button, and disable/mark it busy while `refetch` is active. Keep failure copy free of backend internals and message content.
4. Add the smallest direct DOM test harness needed for this component (`@testing-library/react` plus `happy-dom` as app dev dependencies) and enable `.test.tsx` discovery. This is justified by the Shadow DOM and query-state assertions; do not add a broader test framework.
5. Preserve blocked-image behavior and update it only from successful processed output.

**Execution note:** Start with the component test using a deferred processing promise. Keep `mail-content-fallback.test.ts` as the hosted-mode raw-HTML security contract.

**Patterns to follow:** `resolveMailDisplayHtml` security boundary; server processing in `apps/server-pilot/src/trpc/routes/mail.ts` and `apps/server-pilot/src/mail/process-email-html.ts`; existing workspace DOM-test dependencies in `packages/testing/package.json`.

**Test scenarios:**
- A successful processing response renders its sanitized, processed HTML.
- `useThread` no longer starts `mail.processEmailContent`; only the mounted `MailContent` query owns that key.
- While processing a normal message, UI exposes polite loading state rather than unsafe-content failure.
- A rejected or timed-out processing request exposes `role="alert"` and Retry, and never renders raw HTML, scripts, or backend exception text.
- The initial processing failure performs no automatic retry. Manual Retry immediately enters busy/disabled state with focus retained, invokes processing again with the same message ID, trust state, and theme, and success replaces error state.
- The component test proves the host is withheld during pending/error, the Shadow DOM never receives its raw test HTML, and sanitized success becomes visible.
- A message switch cannot show prior message’s processed HTML or failure state.
- Frontend-only demo keeps its deliberate local behavior.

**Verification:** Targeted mail tests prove distinct states and safe rendering; a read-only pilot browser check shows a normal booking email transitions from loading to rendered content after U1 confirms API availability.

### U3. Contain latest-message header reply actions

**Goal:** Make latest-message header controls fit within pane bounds without changing reply semantics or hiding response actions.

**Requirements:** R3, R4. Covers AE3.  
**Dependencies:** None  
**Files:** `apps/mail/components/mail/mail-display.tsx`; `apps/mail/tests/mail-reply-actions-contract.test.ts`; `apps/mail/tests/e2e/real-mail-launch-readonly.spec.ts`

**Approach:**
1. Remove `r` / `a` / `f` visual shortcut badges from `Message reply actions`; keyboard shortcuts remain thread-level and keep their existing latest-message behavior.
2. Complete the recipient-header shrink chain: make each To/Cc/Bcc value breakable, keep each action button whole, and make the action group an unconditional pane-width wrapped row rather than switching to `sm:w-auto`.
3. Keep Reply, Reply All, and Forward as visible native buttons. Preserve selected-message semantics for this group and existing context-menu/hotkey paths.
4. Add a separate read-only geometry case to existing launch proof. Before browser actions, require `REAL_MAIL_READ_ONLY=1`, a designated pre-read `REAL_MAIL_MESSAGE_HEADER_THREAD_ID`, and a non-PII minimum recipient-length input. The fixture owner provisions that long-recipient thread outside the test; the test neither seeds nor alters pilot mail.
5. Use fixed `1050×640` desktop viewport at 100% scale with inbox split visible, assert a bounded thread-pane client width before measurement, scroll the latest message header into view, and compare every action rectangle’s top, bottom, left, and right edge with the thread viewport.
6. Replace denylist-only request capture for this case with an exact, source-documented allowlist of tRPC procedures required by the read-only page. Treat `mail.processEmailContent` as an allowed read operation; reject `mail.markAsRead`, every other mail write, all `drafts.*`, and every unclassified procedure. Record only procedure names, status codes, and geometry values.

**Execution note:** Add geometry assertion first. Run this live proof from a clean environment: never source `.env.production`; unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; inject only approved browser-test inputs through the operator path.

**Patterns to follow:** Existing `Message reply actions` group in `apps/mail/components/mail/mail-display.tsx`; read-only request capture in `apps/mail/tests/e2e/real-mail-launch-readonly.spec.ts`.

**Test scenarios:**
- Extend existing static action contract only with recipient/action containment and no latest-only visual-badge assertions; retain existing handler/label assertions unchanged.
- With live UI gate off, the geometry test skips. With `REAL_MAIL_UI_GATE=1`, missing fixture inputs fail configuration before login or browser actions. The read-only geometry test runs only under `REAL_MAIL_READ_ONLY=1` against a dedicated pre-read long-recipient thread. At `1050×640`, it proves a bounded visible split pane and every `Message reply actions` button has top, bottom, left, and right bounds inside the thread viewport.
- Geometry test confirms Reply All remains visible beside or on a wrapped line, never clipped.
- Existing action contract continues to prove the three action labels, selected-message semantics, and thread-level hotkeys.

**Verification:** Targeted contract tests pass; opt-in read-only browser geometry proof runs from clean environment against healthy endpoint; classified requests contain only allowlisted reads and no `mail.markAsRead`, forbidden mail mutation, send, or draft operation.

---

## System-Wide Impact

- **Staff:** Real message bodies remain usable across transient edge failure; latest-only cache poisoning no longer turns normal mail into an ambiguous safe fallback. Latest messages no longer lose Reply All on narrow panes.
- **Security:** No change to server-side sanitization, message authorization, CID attachment scoping, or remote-image trust gates.
- **Operations:** Remote-admin API availability becomes a prerequisite for mail reading, so deploy recovery must prove the public API edge rather than only loopback process health.

---

## Risks and Mitigations

- **Risk:** Rendering wire HTML after a processor failure would bypass trust-time image filtering.  
  **Mitigation:** U2 never substitutes raw or wire HTML for successful processor output.
- **Risk:** A browser-width breakpoint passes in full screen but fails in wide split.  
  **Mitigation:** U3 removes the latest-only viewport-based badge difference and tests actual message-header geometry at a constrained pane width.
- **Risk:** Treating a historical 502 as a current outage causes an unnecessary production deploy.  
  **Mitigation:** U1 changes production only after private-target and public-API verification fail; any recovery uses a dual-plane candidate guarded by existing contract checks.
- **Risk:** Bundle sync can erase newer live-only work.  
  **Mitigation:** U1 requires immutable-commit and live-checkout comparison before recovery, with stop/merge behavior on drift.
- **Risk:** A wrapped action row passes horizontal checks but falls below the visible scrollport.  
  **Mitigation:** U3 fixture asserts all four button edges after header scroll-into-view.
- **Risk:** Automatic retry amplifies an unavailable processing service.  
  **Mitigation:** U2 disables automatic query retry and permits only one user-initiated in-flight retry at a time.
- **Risk:** A “read-only” browser test changes pilot mail or inherits production credentials.  
  **Mitigation:** U3 uses a clean runner, purpose-built pre-read fixture, and fail-closed procedure allowlist.

---

## Verification Contract

| Scope | Proof | Safety boundary |
| --- | --- | --- |
| Mail UI states and header containment | `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/mail-content-fallback.test.ts tests/mail-content-rendering.test.tsx tests/mail-reply-actions-contract.test.ts` | No database-backed mail test. |
| Dual-plane deployment contract | `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/server exec vitest run tests/deploy-config.test.ts tests/remote-admin-lifecycle.test.ts tests/remote-admin-cutover.test.ts` | Fixture/local process only. |
| Live edge recovery | Existing guarded dual-plane recovery and private health proof from `docs/solutions/workflow-issues/remote-admin-legacy-only-nginx-wipe-502.md`, plus a public `/api/public/providers` status check | Health/status evidence only; no mail content or credentials. |
| Live header geometry | Clean operator runner only: never source `.env.production`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`; inject approved real-mail browser inputs plus dedicated pre-read fixture, then run `REAL_MAIL_UI_GATE=1 REAL_MAIL_READ_ONLY=1 pnpm --filter @zero/testing exec playwright test --config playwright.real-mail.config.ts real-mail-launch-readonly.spec.ts` | Fail closed on non-allowlisted mail procedures; record no payloads, credentials, or PII. |

Do not run Vitest with pilot RDS configuration or `VITEST_ALLOW_PILOT_RDS`.

---

## Definition of Done

- Remote-admin public API routing is verified or recovered without regressing legacy ingress; public `/health` remains intentionally 404.
- Standard booking mail body renders after processing succeeds, without a background latest-only processing query.
- Pending, terminal-failure, and retry-busy states are visually and programmatically distinct, have no automatic retry, and never render unsafe source HTML.
- Latest-message header Reply All is visible inside specified constrained reading pane fixture; clean read-only proof observes only allowlisted procedures.
- Regression tests cover content state and pane geometry, not only class-string presence.

---

## Sources & Research

- `apps/mail/components/mail/mail-content.tsx` and `apps/mail/lib/mail/resolve-mail-display-html.ts` — live renderer selects safe placeholder whenever processor data is absent.
- `apps/mail/hooks/use-threads.ts` — unobserved latest-only `email-content-v2` prefetch can share `MailContent` cache key.
- `apps/server-pilot/src/trpc/routes/mail.ts` and `apps/server-pilot/src/mail/process-email-html.ts` — processor authorizes message scope, projects CID assets, and applies active image policy.
- `apps/mail/components/mail/mail-display.tsx` — visual newest message alone receives `r` / `a` / `f` badges; recipient action group uses a browser-width layout rule.
- `docs/solutions/security-issues/ec2-pilot-pre-real-ingest-security-gate.md` — raw HTML fallback is intentionally forbidden.
- `docs/solutions/workflow-issues/remote-admin-legacy-only-nginx-wipe-502.md` — known dual-plane route-loss failure and safe recovery order.
- `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` and `apps/server-pilot/deploy/remote-admin-cutover.sh` — force-reset bundle behavior and `unused` target recovery constraints.
- Live status check on 2026-08-22 — public `GET /api/public/providers` succeeds while public remote `GET /health` returns intentional 404; this proves current API ingress but not an authenticated content-processing request.
