---
title: "feat: every workflow wired end to end on both hotels (Centurion + Da Vinci) — autonomous 7.5 h run"
type: feat
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: owner voice asks 2026-10-23 00:10–01:00Z (OWNER-ASKS 185–195)
---

# Workflow × property grid — autonomous run (2026-10-23)

## Goal Capsule

- **Outcome:** for each cell (workflow × hotel) the run passes one proof on the **current build**: U0 pane-path runner → HMS → readback → screenshot. Quote cells pass on a price score instead.
- **Hotels:** Centurion (HRCEN, slot 19223) and Da Vinci (HRDAV, slot 19225).
- **Workflows in scope:** quote PDF/Excel, create provisional, amend unpaid provisional, cancel unpaid provisional (quote release), multi-stay (one mail → N bookings), POP/voucher attach (Centurion).
- **No-HMS lanes:** 66 h follow-up and the context-dataset linker.
- **Coding window:** 7.5 h from T0. The final deploy lands at T0+450 min. The whole grid needs ~12.5 h (D1 = yes) or ~20 h (serial), so proofs continue after the final deploy (D6).
- **Writes:** Labtest only (`Proof Labtest`, arrival ≥ 2027-01-01). Every `PANE_WRITE_*` stays `lab`. No real-guest write.
- **Done** = the proof grid in §7 is green on the final SHA. Anything not green is reported with its evidence and its next fix. Merged code is progress, not done.

---

## 0. Grok 4.7 xhigh review — integrated (14 findings, 2026-10-23)

Verdict before fixes: "autonomous run **no**". Each P0/P1 was checked against the code; resolution below.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | P0 | No invocable pane-equivalent proof path; `hms-job.sh` doesn't exist; a raw `.mjs` skips target, lock and digest | **New U0** (§4): `src/ops/hms-proof-run.ts`, modelled on `src/ops/hms-job-proof.ts` (AE5: queues via the pane's `queueUserHmsJob`, reads via `readHmsJobView`). Pass cells must go through U0, never a raw `.mjs` |
| 2 | P0 | P1 would cancel `66865808-1` before U7 exists; penalty "else OK"; Labtest identity taken from args | P1 = **read-only**: find + open the cancel dialog, dump, close, no OK. Penalty clicks (owner-approved, ask 189) only after an **HMS re-read** shows surname Labtest + arrival ≥ 2027, and only in U7 code. Grok wanted "no OK ever"; the owner approved accept on Labtest, so OK stays, behind the re-read |
| 3 | P0 | `HMS_DAVINCI_MAKE_QUOTE` not in the `write-ec2-remote-env.sh` allowlist → webmail DV quote stays off | U2b adds the key to the allowlist + `deploy-config.test.ts`; flip after D-B; `/proc` on all 4 |
| 4 | P0 | ETA ignores the solution doc's ≥ 180 min to the first confirmed number per new write type; proofs scheduled before their code is deployed | §8 recomputed with 180 min per **new** write type; §9 proofs only after the deploy that holds their code. Result: grid-green ≫ 7.5 h; cut line moved |
| 5 | P1 | Shell `flock` / raw key won't match the app's `sha256(tenant\0property)` advisory key | U0/U6 call `createPostgresPropertyReadLock({tenantId: paneStayTenantId(), propertyCode})`, so there's one lock. No `flock` |
| 6 | P1 | Ownership holes: `pane-hms-write.ts:440` (amend spawn) also needs a target; U2b misses other `CENTURION_HOTEL_RULES` callers | U1 owns every spawn in `pane-hms-write.ts` (attach 383, amend 440). U2b's first step is a CodeGraph sweep of every `CENTURION_HOTEL_RULES` / Centurion-rate-text caller (Grok named `reservationist-draft-source.ts`, `extract.ts`, `inbound-run.ts`, `reservationist-agent.ts`) |
| 7 | P1 | Stale citations | Fixed inline: refusal reason = `errorCode` only (`hitl-tool-run.ts:241-243`); `runProofReadback` ≈ 819; blank loss in `toPaneStayFields` (`pane-stay-lookup.ts:305-306`); `hmsReadTargetForTransport` maps unknown → HRCEN, so fail-closed lives in the **new** resolver, not that helper |
| 8 | P1 | `amend-stay.mjs` / `cancel-stay.mjs` take no `--property`; `AMEND_ROOM_TYPES` also in `src/ai/aop/amend-cancel-payload.ts:5` | U2a adds `--property` to both CLIs and replaces **both** allow-list copies |
| 9 | P1 | The blank-deposit fix belongs in the mapper | U5 = keep `''` through `toPaneStayFields`; `null` still refuses (test) |
| 10 | P1 | No worktree guard in `ops-deploy.sh`; ACTIVE cites two live SHAs (`e5231310a`, `5851aa930`) | T0 reads the live SHA from EC2 and records it as last-good. U6 adds a guard: refuse unless cwd = `.worktrees/recover-parse-failure` |
| 11 | P1 | 66 h: regex claim false; copy lives in `follow-up.ts:73` | U10 corrected; the regex is untouched |
| 12 | P1 | D1 silent → global lock, but the waves assumed parallel | Default **serial**; parallel only after a written D1 = yes in the executing chat |
| 13 | P2 | Quote bar unlikely in one loop (5/8 plan, 2/8 price); keep P8 | Quote = score and report, doesn't block the grid; P8 stays (party code changed) |
| 14 | P2 | U4 needs evidence before a new Save; no delete CLI | U4's evidence comes from a **read-only** readback of existing `66865808-1` (SR3 Save, `committed_unverified`). Cleanup cancels only Labtest rows confirmed by HMS re-read; "delete" = cancel |

---

## 1. Problem frame

Most workflows have code, and some have tests. Almost none are proven end to end on the build that is live. The evidence below is scoped to after the 2026-10-20 18:01Z `ARCHITECTURE.md` cut-off (owner, ask 186).

| Workflow | Code | Last live result (post cut-off) | Blocker |
|---|---|---|---|
| Quote HRCEN | ✅ | 0 runs on live `e5231310a`. On earlier builds since the cut-off: 15 ok / 36 refused runs (14 / 28 messages). **The refusal reason is not stored** (`src/ai/hitl-tool-run.ts:209` keeps only `PRECONDITION_FAILED`) | No reason, no score |
| Quote HRDAV | ✅ #482/#484/#473 | 0 runs, flag unset | Centurion-only hotel rules and rate-policy text (`reservationist-decision.ts:54`, `reservationist-rate-policy-source.ts`) |
| Create HRCEN | ✅ | 3 Saves, all `committed_unverified` (SR3) | Readback; the root cause was not captured |
| Create HRDAV | ✅ | 7 runs, 2 Saves, 0 bookings (DV retro) | Reservation Note is required on DV and is optional in the code; Save mask hangs |
| Amend | ✅ | 0 commits | `stay-lookup.mjs:88-107` + `pane-stay-lookup.ts:302-327` turn a blank deposit into "missing" → `payment_unknown`. Synchronous SSM timed out at 10/15 min. Room allow-list is HRCEN-only (`amend-stay-rules.mjs:4`) |
| Cancel | ✅ pane UI | HRCEN 1/2 via CLI; HRDAV never | No HRDAV target (`pane-stay-cancel.ts:212,272`). Penalty dialog is left open |
| Multi-stay | Extraction + combined PDF ✅ | none | Per-stay action (M2) and per-stay durable results (M3) not built (`work-items.ts:480-495`, `pane-stay-save.ts:53-71`) |
| POP attach | `attach-document.mjs` ✅ | #143 upload showed a row but returned `upload_unconfirmed`; no rerun after the fix | No pane → attach-form bridge |
| 66 h follow-up | ✅ #461 merged, flag off | n/a | Quotes only. Starvation past 200 rows (`SWEEP_BATCH`) |
| Mail linking | pieces | n/a | No context dataset (owner: "context, not gold") |

**Root pattern:** the server code that calls the HMS tools treats the property as optional and falls back to HRCEN. Each fix so far added routing to one more call site. Cancel, amend-prepare, attach and availability were missed (§3 audit).

---

## 2. Value gate (read-only prod SQL, 2026-10-23 00:30Z)

Inbound mail over the last 14 days, latest succeeded extraction per message.

| Class | HRCEN n=2,038 | DV side (6 mailboxes) n=1,223 |
|---|---:|---:|
| booking (create) | 15.9% | 16.8% |
| voucher/POP | 12.1% | 6.9% |
| amendment | 6.8% | 10.0% |
| quote | 4.5% | 2.1% |
| cancellation | 2.1% | 2.9% |
| multi-stay (stays > 1, any class) | 1.8% | 4.9% |

- **Live extraction coverage, last 48 h:** 81–97% per mailbox. The many DV messages without an extraction are history-only backfill, by design.
- **Usage, 7 days, `actor_kind='user'`:** `pane.opened` 2,143, `hms.lookup.started` 988, `quote.prepared` 37, `pdf.created` 4. Staff have not been released, so these are owner/testing events (memory `project-staff-not-using-pane`).
- **Users tomorrow:** Faith (DV, `fkhumalo@`) and Bongi (`centurion@`) (ask 191).
- **Anti-over-index:** every in-scope class is ≥ 2% on at least one hotel. Groups and paid money flows are deferred (owner).

---

## 3. Key technical decisions

| # | Decision | Why / evidence |
|---|---|---|
| KTD1 | **Property target is required.** `paneStaySpawnEnv`, `paneStayPropertyLock` and every tool spawner take a non-null `HmsReadTarget`. One server resolver turns a mailbox transport into a target (`hmsReadTargetForTransport`, `src/hms/hms-read-target.ts:79`). Callers never supply the property. | Audit: cancel `pane-stay-cancel.ts:212,272`; amend prepare + attach `pane-hms-write.ts:245,383`; availability `hms-availability.ts:560` pass no target. Lookup and party default to `'HRCEN'`. Create already does it right (`pane-stay-save.ts:271-303`). Owner picked option B (ask 187) |
| KTD2 | **Property settings live in `tooling/playwright-quote/property-profiles/<CODE>.json`**: room codes (amend allow-list = the `roomCapacity` keys), create required fields, hotel rules text, and the confirmation-letter identity pattern for rate terms | Profiles already exist for both hotels and are validated by `property-profile.mjs`. A third hotel = new JSON + a registry row |
| KTD3 | **Read-only preflight before any first write on a cell** (create screen, availability + restrictions, required fields, duplicate search in the same context, nav visible), plus a **dump mode** that saves sanitised DOM + screenshot | SR3: first clean Save 3 min after a fresh page + shop; DV: 7 runs found one blocker each. `docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md` |
| KTD4 | **All live HMS jobs go through one EC2 runner:** `systemd-run`, a per-property `flock`, and a result file the orchestrator polls. Never synchronous SSM | SR3 amend 0/2 from 10/15 min SSM timeouts; SR3 had two jobs at once on HRCEN (§9c breach) |
| KTD5 | **Lock scope:** with the owner's OK (Decision D1), the two HMS slots run in parallel, one lock per property. Otherwise one global lock, serial | Separate browser, login, secret and tenant per property (`property-registry.mjs`; `hms-slot@.service`). Halves the HMS critical path (§8) |
| KTD6 | **Readback is a pass bar.** `committed_unverified` with a number on screen counts as a bug | SR3 retro rule 8 |
| KTD7 | **Labtest penalty dialog:** for a Labtest stay only, the tool picks the waive/no-charge option if one exists, otherwise accepts. **Real guests: no change** (refuse, leave for staff) | Owner ask 189. No waive control is captured in the repo yet, so the cleanup cancel of `66865808-1` captures the dialog DOM first |
| KTD8 | **Unpaid rule:** a deposit field that is present but blank, or zero, plus status Reserved/Provisional plus a non-paying guarantee = unpaid. Missing or unreadable = unknown → refuse. **No Folio check this run** | `amend-stay-rules.mjs:83-99` already encodes it; only the lookup loses "present but blank". `hms_read_folio` returns `manual_required` today, so a Folio gate would block every amend. Folio is deferred with the paid flows |
| KTD9 | **Cancelling an unpaid provisional = quote release, no penalty.** Paid cancel/amend stays human (deferred) | Owner ask 190 |
| KTD10 | **LLMs never drive live HMS, Labtest included.** Codex GPT-6.1 Sol and Grok read the **saved** dumps/screenshots offline to design selectors | PRODUCT.md hard rule; `building-hms-playwright-tools` skill. The owner's Sol computer-use idea is met offline (§11 D5) |
| KTD11 | **Evidence cut-off:** only data since the current deploy SHA counts toward a pass. Older runs are history | Owner ask 186; MISTAKES 2026-10-22 |
| KTD12 | **DV quote flag:** `HMS_DAVINCI_MAKE_QUOTE=on` after U2b is deployed (owner approved). It stays on unless the score shows a wrong price with no HMS-side reason; then off + report | Owner ask 195; PRODUCT quote bar |

---

## 4. Implementation units

Size = product lines (tests separate), from the 8 scoping reports (`/tmp/plan1023`, summarised in §12). **Lane min** = lane start → merged, including Grok review + Greptile. Basis is SR3 measured unit times (W1 42, D1 32, W4 22, W2 25, D2 43, W3 19, D3 27, D4 63, M1 21; median 27 min for 48–330 lines), padded by ~1.5× for the DV-day gate overhead (#488 19 min of gate tooling). Rule of thumb: S ≤ 80 lines = 30 min, M 80–200 = 45, L 200–350 = 70.

### U0. Pane-path proof runner (Grok #1, #5)
- **Files:** new `apps/server-pilot/src/ops/hms-proof-run.ts` + `tests/hms-proof-run.test.ts`; pattern from `src/ops/hms-job-proof.ts` + `tests/hms-job-proof.test.ts`.
- **Approach:** subcommands `create|amend|cancel|attach|find --transport <id> --request <json> --mode preview|commit --out <dir>`. It resolves the target with the U1 resolver, takes `createPostgresPropertyReadLock`, and calls the **same** server functions the tRPC routes call (`runPaneStay`, `spawnPaneStayCancel`/`commitCancel`, `prepareAmend`/`spawnAmendStay`, `runPaneHmsWriteOnce`). It refuses unless the request is Labtest + arrival ≥ 2027 and `PANE_WRITE_*=lab`. Output is one JSON line plus screenshots. If the `queueUserHmsJob` path supports the write kind, use the queue (truer to the pane); otherwise call directly. The lane decides from the code.
- **Size:** 120–200 + 80–140 → **M, 50 min**. Depends on the U1 signature (it starts against the U1 branch).
- **Tests:** a non-Labtest request is refused before any spawn; an unknown transport is refused; a DV transport gets the HRDAV lock key; `commit` without a preview digest is refused.

### U1. Property target required everywhere (KTD1)
- **Files:** `apps/server-pilot/src/ai/pane-stay-spawn-env.ts`, `pane-stay-save.ts` (`paneStayPropertyLock`), `pane-stay-cancel.ts`, `pane-hms-write.ts`, `hms-availability.ts`, `pane-stay-lookup.ts`, `pane-party-lookup.ts`, `src/trpc/routes/pane-stay-cancel.ts`. Tests: `tests/pane-stay-cancel.test.ts`, `tests/pane-hms-write.test.ts`, `tests/pane-stay-spawn-env.test.ts` (new if absent), `tests/pane-stay-lookup.test.ts`.
- **Approach:** the target becomes non-optional, so the compiler (remote typecheck) lists every caller. Each route derives the target from the message's transport on the server. An unknown transport is refused (fail closed). Remove the `'HRCEN'` defaults in the spawn, lock and lookup paths. Keep `create` as the pattern.
- **Size:** 100–150 + tests 100–150 → **L, 60 min**, Greptile `--apex` (HMS write gate).
- **Tests:** a DV transport cancel/amend-prepare/attach/availability gets the HRDAV slot, secret and lock key; a Centurion transport gets HRCEN; an unknown transport is refused before any spawn; a caller-supplied property is ignored.
- **Verify:** `grep "paneStaySpawnEnv()"` → 0 hits. Remote typecheck 0 errors.

### U2a. Property profiles carry room codes + required create fields (KTD2)
- **Files:** `tooling/playwright-quote/property-profile.mjs`, `property-profiles/HRCEN.json`, `HRDAV.json`, `amend-stay-rules.mjs`, `create-lab-stay.mjs` (required-field check), tests `property-profile.test.mjs`, `amend-stay-rules.test.mjs`, `create-lab-stay.test.mjs`.
- **Approach:** the amend allow-list = `Object.keys(profile.roomCapacity)`, and both `AMEND_ROOM_TYPES` copies are deleted (`amend-stay-rules.mjs:4`, `src/ai/aop/amend-cancel-payload.ts:5`). Add `--property` to `amend-stay.mjs` and `cancel-stay.mjs`. Add `requiredCreateFields` to the profiles (HRDAV: `reservationnote`), validated by `property-profile.mjs`. The create static blank-check reads it and also checks textareas. Pane validation follows (`apps/mail/lib/quote-workflow/pane-stay-bind.ts` already maps the note).
- **Size:** 40–80 + 40–70 → **S, 30 min**.
- **Tests:** HRDAV `EXKNGB` is accepted for amend and HRCEN `EXKNGB` refused; HRCEN `STQN` accepted; an HRDAV create with a blank note is refused before Save; HRCEN with a blank note is allowed.

### U2b. Quote is property-aware (hotel rules + rate-policy source)
- **Files:** `src/ai/reservationist-decision.ts` (`CENTURION_HOTEL_RULES` → per-profile text), `src/ai/quote-workflow-llm.ts`, `src/ai/agent-pane-adapter.ts` (hard-coded `HRCEN`), `src/ai/reservationist-rate-policy-source.ts` (Centurion letter regex → profile pattern), `src/ai/staff-quote-installation.ts`. Tests `quote-workflow-llm.test.ts`, `reservationist-rate-policy-source.test.ts`, `staff-quote-installation.test.ts`.
- **Prereq probe (no HMS, ~15 min, orchestrator):** read-only SQL to pull the first 400 chars of 3 DV confirmation-letter PDF texts from `fkhumalo@`/`davinci@` outbound, with guest names redacted, to get the identity sentence.
- **Also:** add `HMS_DAVINCI_MAKE_QUOTE` to the `deploy/write-ec2-remote-env.sh` allowlist + `deploy-config.test.ts` (Grok #3). The first step is a CodeGraph sweep for every Centurion hotel-rule / rate-text caller.
- **Size:** 90–180 + 130–240 → **M, 60 min** (after the probe).
- **Tests:** a DV quote prompt contains Da Vinci rules and no "Centurion"; a DV letter qualifies DV terms; a Centurion letter does not qualify DV terms (no fallback); HRCEN output is unchanged.

### U3. Create preflight + dump mode (KTD3)
- **Files:** new `tooling/playwright-quote/create-preflight.mjs` + `.test.mjs`; reuse `create-request.mjs`, `property-profile.mjs`, the `stay-lookup.mjs` search, and the `create-lab-stay.mjs` nav helpers.
- **Approach:** one read-only run per property and date. Fresh page/login → exact-date room + rate availability and restrictions → open the create screen without Save → list every required/blank field and visible message box → duplicate search in the same context → nav-node visibility. Output `preflight.json` with all blockers + a sanitised DOM dump + screenshot. Exit 0 = clear. **Never clicks Save.** The `hms-read-only-guard.mjs` request guard stays on.
- **Size:** 120–220 + 60–100 → **L, 60 min**.
- **Tests (fixtures):** all-clear; restricted date → `blocker:availability`; DV note blank → `blocker:required_field reservationnote`; nav off-screen → `blocker:nav`; the guard blocks any write request.

### U4. Create readback fix (KTD6) — after first evidence
- **Files:** `tooling/playwright-quote/create-lab-stay.mjs` (`runProofReadback`, lines ~283–348, 819–847), `create-proof-rules.mjs`, maybe `stay-lookup.mjs`. Tests `create-proof-rules.test.mjs`, `create-lab-stay.test.mjs`.
- **Approach:** evidence first, **read-only**: run the readback reader against the existing SR3 Save `66865808-1` (`committed_unverified`) and capture the mismatch fields + screenshot. Fix the real mismatch in the reader, not the rule, **before** P2's new Save (Grok #14). Lands in D-A if the evidence is in by T+60, otherwise D-B.
- **Size:** 30–80 + 30–60 → **S, 35 min**, conditional on the evidence.

### U5. Amend keeps "present but blank" (KTD8)
- **Files:** `tooling/playwright-quote/stay-lookup.mjs` (lines 88–107, `fillBlankPaymentFields`), `src/ai/pane-stay-lookup.ts` (302–327), tests `stay-lookup.test.mjs`, `tests/pane-stay-lookup.test.ts`, `amend-stay-rules.test.mjs`.
- **Approach:** keep `''` through `toPaneStayFields` (`pane-stay-lookup.ts:305-306` turns it into null today); `stay-lookup.mjs` `fillBlankPaymentFields` (99–108) reports a present-but-blank field. `amend-stay-rules.mjs:92-98` already treats `''` as unpaid.
- **Size:** 20–40 + 25–50 → **S, 30 min**.
- **Tests:** present + blank + Reserved + non-paying guarantee → unpaid → amend allowed; field absent → unknown → refuse; `0.00` → unpaid; `500.00` → paid → refuse.

### U6. EC2 HMS job runner (KTD4, KTD5)
- **Files:** new `apps/server-pilot/deploy/hms-job.sh` (start/poll/result; runs **U0** under `systemd-run`) + an `ops-deploy.sh` worktree guard, new `apps/server-pilot/tests/hms-job-runner.test.ts` (shell contract), docs line in `docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md`.
- **Approach:**
  - `hms-job.sh start --property HRCEN|HRDAV --tool <mjs> --args-file f` → `systemd-run --unit hms-job-<id>` (the lock is taken inside U0 via `createPostgresPropertyReadLock`, no shell `flock`). Prints the job id.
  - `poll <id>` → state + `result.json` path.
  - Only runs U0 (no raw `.mjs`).
  - Logs to `/var/log/nava/hms-jobs/<id>/`.
  - `ops-deploy.sh` refuses unless cwd is `.worktrees/recover-parse-failure`.
- **Size:** 50–90 + 40–70 → **M, 40 min**. **Starts at T0; everything live depends on U0 + U6.**
- **Tests:** two starts on the same property → the second waits; HRCEN + HRDAV run together only when `HMS_LOCK_SCOPE=property`; a tool outside the allowed dir is refused; poll on an unknown id returns `unknown`.

### U7. Cancel: Labtest penalty handling + pane result
- **Files:** `tooling/playwright-quote/cancel-stay-rules.mjs` (254–349, `parsePenalty` 380), `cancel-stay.mjs` (502–505 recovery), `src/ai/pane-stay-cancel.ts`, `apps/mail/lib/quote-workflow/amend-cancel.ts`, `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`. Tests `cancel-stay-rules.test.mjs`, `tests/pane-stay-cancel.test.ts`, `apps/mail/tests/amend-cancel-copy.test.ts`.
- **Prereq:** the dialog DOM from P1 (cleanup cancel of `66865808-1`).
- **Approach:**
  - Labtest identity **re-read from the open HMS record** (surname Labtest + arrival ≥ 2027), not from args → pick the waive option if present, else OK (owner, ask 189).
  - Non-Labtest → unchanged `refused_penalty` / `cancel_penalty_pending`.
  - Pane shows the result + screenshot in every state, including the penalty states.
  - Stale screen: return to a known page and re-find once (no longer timeout).
- **Size:** 85–150 + 100–170 → **M, 50 min**.
- **Tests:** Labtest + penalty with waive → waive clicked, status Cancelled, balance 0; Labtest + penalty with no waive → OK; real guest + penalty → refused, dialog left, nothing clicked; stale screen → one recovery then a clear failure.

### U8. Multi-stay M2 + M3
- **M2 files:** `src/ai/work-items.ts` (480–495), `apps/mail/lib/quote-workflow/session.ts`, `apps/mail/components/quote-workflow/quote-workflow-panel.tsx`; tests `tests/work-items.test.ts`, `apps/mail/tests/quote-workflow-multi-stay.test.ts`. **35–65 → S, 30 min.**
- **M3 files:** `src/ai/pane-stay-save.ts`, `src/trpc/routes/quote-workflow.ts` (266–287), `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `apps/mail/components/quote-workflow/booking-card.tsx`; tests `tests/pane-stay-save.test.ts`, `apps/mail/tests/quote-workflow-multi-stay.test.ts`. **90–150 → M, 50 min.** Depends on M2.
- **Approach:**
  - Each stay card has its own action and its own Preview → Commit.
  - The result (confirmation, status, screenshot) is stored against the stable stay id, so it survives a reload.
  - Commit refuses a stay that already has a confirmed number.
  - After an unknown outcome it reads HMS before allowing a retry.
  - Rooms on the same dates stay one stay; a mixed-room single booking is held (owner ask 168; pane says "Book each room in Infor").
  - More than 8 stays → visible refusal, not truncation (`schema.ts:199,321`).
- **Tests:** 2 stays → 2 commits → 2 numbers mapped right after reload; second commit fails → first kept, second retryable after a read; a retry of a confirmed stay is refused; 9 stays → visible error.

### U9. POP/voucher attach bridge (Centurion)
- **Files:** `src/ai/voucher-find.ts`, `apps/mail/components/quote-workflow/voucher-find-card.tsx`, `apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx`, `src/ai/hms-approval.ts`, `src/ai/pane-hms-write.ts`; tests `apps/mail/tests/voucher-find-card.test.tsx`, `tests/hms-approval.test.ts`, `tests/pane-hms-write.test.ts`.
- **Approach:** after "Find" matches exactly one stay, the card offers **Attach to HMS booking**. It creates the existing attach form (stay + PDF hash), the staff approval, and one run via the `hms-attach-once.ts` path. The result shows the Documents-row readback + screenshot. An uncertain outcome → "Check in Infor", no retry. Uses the U1 target, so DV works the moment a DV Documents probe passes (DV proof deferred).
- **Size:** 120–220 + 180–300 → **L, 60 min**.
- **Tests:** one match + PDF → form bound to that stay + hash; two matches → no attach button; a changed PDF hash → refused; `upload_unconfirmed` → no success copy.

### U10. 66 h follow-up: harden + provisional bookings
- **F1 files:** `src/ai/quote-followup.ts`, copy "3 business days" in `follow-up.ts:73` (Grok #11); tests `tests/quote-followup.test.ts`, `apps/mail/tests/follow-up-card.test.tsx`. **60–110 → M, 40 min.**
- **F2:** provisional-booking eligibility (anchor = Nava/staff HMS confirmation sent); same files + work-item query. **110–190 → M, 50 min.** Depends on F1.
- **Tests:** "deposit within 72 hours" alone → no trigger; "valid for 3 days" quote → trigger at 66 h; client reply at 65 h → cancelled; 250 non-qualifying open quotes + 1 qualifying → the qualifying one still fires; a provisional booking with no reply 66 h after the confirmation → Needs-you + draft; an HRDAV transport fires too.
- **Flag:** stays off (owner flips at go-live). No HMS.

### U11. Context-dataset linker (offline, no schema)
- **Files:** new `apps/server-pilot/scripts/mail-context-linker.ts`, new `src/ai/mail-context-link.ts`, test `tests/mail-context-link.test.ts`.
- **Approach:**
  - inbound ask → staff outbound reply (same thread)
  - → HMS confirmation mail within +0…+30 min of that reply, same recipient domain or same thread, conf# in subject/PDF name
  - → PDF facts (guest, arrival, departure, room, adults) compared to the ask
  - Output JSONL (private dir, ids masked) with a `link_confidence` and per-field match flags. Label it **context**, not gold.
  - Read-only prod; both hotels (the HRDAV letter filename comes from the U2b probe).
- **Size:** 120–220 + 150–240 → **L, 60 min**. No HMS. Durable table (G2) deferred.
- **Tests:** link inside the window; a letter 45 min after → not linked; conf# mismatch → not linked; facts mismatch → linked with `fields_match=false`; DV filename format parsed.

### U12. Dual-hotel quote price scorer
- **Files:** new `apps/server-pilot/scripts/quote-price-gold-replay.ts`, test `tests/quote-price-gold-replay.test.ts`.
- **Approach:**
  - Picks the **most recent** quote asks per hotel (since the cut-off where possible) that have a staff-sent PDF/Excel/reply.
  - Input = prod path (`readQuoteAttachments` → the live `PANE_BRAIN` prompt path; the lane confirms which).
  - Runs the quote **one at a time** through the U6 runner/queue.
  - Compares rate plan + price per night to what staff sent; reports the plannable denominator and the reason per miss; masked ids only.
- **Size:** 220–350 + 140–220 → **L, 70 min**.
- **Tests:** an exact match passes; a price differing with no HMS reason → fail; a named HMS refusal (fully booked) → counted as a pass per PRODUCT; a non-plannable ask → excluded with a reason.

### U13. Store the quote refusal reason
- **Files:** `src/ai/hitl-tool-run.ts` (209), `src/ai/staff-quote-run.ts`, test `tests/hitl-tool-run.test.ts`.
- **Approach:** add a closed catalog of refusal reason codes (no thrown text, no guest data) to `result` on refusal.
- **Size:** 15–30 + 20–40 → **S, 20 min**.

### U14. Labtest cleanup + inventory (orchestrator, no code unless needed)
- A read-only find of `66865808-1`, `25526053-1` and any `Labtest` 2027–2028 stays.
- Then cancel each through the U7/U6 path. A delete probe is part of the P1 dump (owner: "delete them"; no delete action exists in the code). Report the final inventory.

**Totals:** 18 PRs, **~1,600–2,800 product lines** + ~1,500–2,500 test lines. Lane minutes ≈ 790 (sum of the above). Largest unit L ≤ 350 lines, under the 500-line PR cap.

---

## 5. File ownership (one owner per shared file; queue in this order)

| Shared file | Order |
|---|---|
| `src/ai/pane-hms-write.ts` | U1 → U9 (U0 imports only) |
| `src/ai/pane-stay-cancel.ts`, `amend-lookup-panel.tsx`, `amend-cancel.ts` | U1 → U7 |
| `src/ai/pane-stay-save.ts` | U1 → U8-M3 |
| `src/ai/pane-stay-lookup.ts`, `stay-lookup.mjs` | U1 → U5 |
| `create-lab-stay.mjs` | U2a → U4 (U3 only imports it) |
| `property-profile.mjs`, `property-profiles/*.json` | U2a → U2b |
| `src/ai/staff-quote-run.ts` | U13 → U2b |
| `quote-followup.ts` | U10-F1 → U10-F2 |
| `work-items.ts` | U8-M2 → U10-F2 |

Disjoint at T0: **U1, U2a, U3, U6, U10-F1, U11, U13** (7 lanes). U0 and U9 are queued behind U1 (`pane-hms-write.ts`, spawn signatures).

---

## 6. Run contract

| Item | Rule |
|---|---|
| Roles | **Orchestrator:** decided with the owner (D4). Default Grok 4.6 high in Orca terminal `g-orch`. Merges, deploys, runs the HMS queue via `hms-job.sh`. **Coders:** Grok 4.6 high, one Orca child worktree + terminal per unit (`g-U<n>`). **Reviewer per PR:** Grok 4.7 xhigh, headless, diff from a **file**, never argv. **Greptile:** Plus by default; `--apex` for U1, U7, U9 (write gate). **Watchdog:** Opus planning chat |
| Watchdog | Every **30 min** (SR3: 5/5 hourly steers found a real problem; idle stretches of 51 and 35 min). It reads `/tmp/g1023/state.md` + the orchestrator screen and steers by writing `/tmp/g1023/steer-HHMM.txt` |
| Monitor tick = act | Every orchestrator tick counts lanes running, PRs untouched > 15 min, and units left. **0 lanes + units left → launch the next unit in that turn.** "check-in continues" with 0 lanes is banned (SR2/SR3 lesson) |
| Gates | push → `remote-typecheck.sh` (ships the SHA) → remote tests on **that** SHA → `greptile review --branch origin/main` → Grok 4.7 xhigh. Run them in parallel after the push. 2 Greptile rounds max; a 3rd fresh P1 on the same design → split/strip |
| Deploys | Only from `.worktrees/recover-parse-failure` via `ops-deploy.sh`. Record the live SHA read from EC2 at T0 as last-good. Planned (§9): **D-A ≈ T+130**, **D-B ≈ T+220**, **D-C ≈ T+340**, **Final ≈ T+450**. Proofs run only on a deploy that contains their code. Extra deploys only to unblock a proof cell. After each: health, 4 procs, `/proc` flags |
| Flags | `PANE_WRITE_*` = `lab` on all 4 procs, unchanged. `HMS_DAVINCI_CREATE=lab`, `HMS_DAVINCI_READS=on`. `HMS_DAVINCI_MAKE_QUOTE=on` after D-B (KTD12). Flip procedure: back up both env files → `write-ec2-remote-env.sh --validate` → `ops-restart.sh` → `/proc` on http, worker, ai-worker, remote-http |
| HMS | Only via `hms-job.sh`. Lock scope per D1. **No LLM drives HMS.** Labtest only. Every first write on a cell runs U3 preflight first. Pre-Save failures don't count against the budget |
| Budget | Per cell: up to 3 Save/commit clicks; up to 2 fix loops (fix lane + deploy + rerun). Then **park the cell** with evidence and take the next item. Never end the run early while units or cells remain |
| State | `/tmp/g1023/state.md`, append-only, timestamp on every phase change. Hand off at ~150k context |
| Stop | New merges stop T+435. Final deploy T+450. Proof queue continues per D6. Report into ACTIVE.md + the run retro |

### 6a. Break → fix protocol (in every lane brief verbatim; owner ask 188)

> When something breaks, the job is to find and ship the best, cleanest fix, not to stop or report "blocked".
> 1. **Capture**: result.json, screenshot, DOM dump, exact error, SHA. No guessing from a screenshot alone.
> 2. **Root cause**: trace the failing path end to end; grep every caller of the function you'd change; fix it where all callers route through (one shared guard beats N call-site patches).
> 3. **Look first**: `docs/solutions/`, `docs/context/MISTAKES.md`, `docs/infor-hms/`. Reuse an existing helper before writing a new one.
> 4. **Fix** in the smallest PR that removes the cause, with a test that fails without it. Deterministic only; no LLM in the HMS path.
> 5. **Prove** on the current build (rerun the same cell via `hms-job.sh`).
> 6. **Stop and write `/tmp/g1023/HOLD.txt` only for:** a real-guest write path, money (paid amend/cancel, charge), a flag other than those in §6, a deploy outside recover-parse-failure, deleting data, or GitHub Actions. Everything else is yours to decide; log it in state.md and keep going.
> 7. After 2 failed fix loops on one cell, park it with the evidence + your best next fix, then take the next unit.

### 6b. Lane brief template (required fields; the orchestrator checks them before sending)

Unit section copied verbatim · owned files · test files to update · "never open live mail, never copy guest names" · 6a verbatim · gates order · "you do not deploy, do not touch HMS, do not flip flags".

---

## 7. Proof grid (Verification Contract)

Each cell: U3 preflight → one action via the **pane-equivalent server path** (the same server function the pane calls, run as an EC2 script under `hms-job.sh`) → HMS readback → screenshot → state.md row with SHA. Quote cells use U12.

| Cell | HRCEN | HRDAV |
|---|---|---|
| P1 inventory + penalty dump (**read-only**) | find `66865808-1`, `25526053-1` + any Labtest 2027–28; open the cancel dialog on one, dump, close, **no OK** | — |
| P2 create provisional | 1 Labtest, readback `committed` | 1 Labtest (Reservation Note filled), readback `committed` |
| P3 amend unpaid | +1 night on the P2 stay, readback | same |
| P4 cancel unpaid (release) | cancel the P2 stay, no penalty clicked on non-Labtest logic, readback Cancelled | same |
| P5 multi-stay | 1 request, 2 date sets → 2 numbers, reload keeps both, cancel both | 1 request, 2 stays (stretch) |
| P6 POP attach | synthetic PDF → Documents row +1 on a P2-style Labtest stay | deferred (probe only) |
| P7 quote score | ≥10 most-recent plannable threads | as many as exist since the cut-off (est. 6–10) |
| P8 party retest | same 42 mails, read-only, compare to 20/22 | — |
| P9 pane UI | owner clicks once per workflow in the morning (both surfaces) | same |
| No-HMS gates | U10, U11, U13: unit tests + remote typecheck + Greptile | |

**Pass bars:**
- Create/amend/cancel/attach: readback `committed` and fields match.
- Quote: rate plan + nightly price = staff on every plannable row (named HMS refusals pass).
- Party: 0 wrong binds.
- A cell parked under 6a.7 = not done and reported.

---

## 8. Critical path and ETA

### 8a. Measured HMS operation times (prod `hitl_tool_run`, 7 d, `duration_ms`)

| Op | n | p50 s | p90 s |
|---|---:|---:|---:|
| quote | 110 | 133 | 242 |
| stay_lookup | 103 | 18 | 57 |
| guest_search | 65 | 13 | 44 |
| stay_preview | 3 | 16 | 17 |
| stay_commit | 1 | 35 | 35 |
| cancel_preview | 1 | 23 | 23 |

The actions themselves take seconds to minutes. **The time sink was discovery + fix loops** (SR3 184 min to the first number; DV 73 min, 0 bookings). A fix loop = lane 35 + deploy 10 + rerun 10 = **55 min** (DV retro: #487 merged 10 min after open, deploy ~9, rerun ~10).

### 8b. Per-cell HMS budget (Grok #4: a **new** write type = 180 min to the first confirmed number, per the solution doc / SR3 184 min / DV 73 min with 0 bookings)

| Cell | New write type? | Budget min | Basis |
|---|---|---:|---|
| Create HRCEN | no (SR3 Save `66865808-1` exists; readback gap only) | 90 | U4 readback fix + 1 Save + readback |
| Cancel HRCEN | no (1/2 via CLI) | 60 | pane path + penalty states |
| Amend HRCEN | **yes** (0 commits ever) | 180 | rule |
| Multi-stay HRCEN | no (= create ×2 once create passes) | 60 | 2 Saves + reload + 2 cancels |
| POP attach HRCEN | **yes** (#143 `upload_unconfirmed`) | 180 | rule |
| Quote score HRCEN (≥ 10) | read | 25 | quote p50 133 s |
| Party retest (42) | read | 20 | p50 29 s |
| Create HRDAV | **yes** (0 bookings) | 180 | rule |
| Cancel HRDAV | same tool, new property | 120 | ⅔ rule |
| Amend HRDAV | same tool after HRCEN | 120 | ⅔ rule |
| Quote score HRDAV | read | 20 | |
| **HRCEN slot** | | **615** | |
| **HRDAV slot** | | **440** | |

Code before the first proof: U1 60 → U0 50 (on the U1 branch) + U6 in parallel → D-A ≈ **T+130**.

### 8c. Totals

| | One global lock (default) | Per-property locks (D1 = yes) |
|---|---:|---:|
| Coding (all units, 7 lanes) | ~T+330 (fits) | same |
| Whole grid green | 130 + 615 + 440 = **~1,185 min (~20 h)** | 130 + 615 = **~745 min (~12.5 h)** |
| Best case (no new type needs its full 180) | ~12 h | ~8 h |

Ledger: live-hms median 0.88 (n=33) would shave ~10%, but the 180-min rule *is* the measured value, so it is not scaled. Orchestration 1.25 is not stacked on top: the per-cell budgets already include fix loops.

**Answer: everything ≈ 12.5 h (parallel) or ≈ 20 h (serial). It does not fit in 7.5 h.** Coding fits easily (~5.5 h incl. reviews). HMS proof time is the whole gap. That is yesterday's lesson: the code is cheap, and the first confirmed number per new write type is expensive.

### 8d. What fits in 7.5 h (T+130 → T+450 = 320 HMS-min per slot)

| Slot | In order | Cum min |
|---|---|---:|
| HRCEN | create 90 → cancel 60 → quote score 25 → party 20 → amend (starts, 125 of 180) | 320 |
| HRDAV (D1 = yes) | create 180 → cancel 120 → quote 20 | 320 |
| HRDAV (D1 = serial) | nothing in the window; DV create starts after HRCEN amend | — |

**In 7.5 h with D1 = yes:** create ✅✅, cancel ✅✅, quote scored on both, party retested, HRCEN amend probably finishes ~T+505. **Out of the window:** POP proof, multi-stay proof, DV amend. Their **code** merges and is deployed in the final deploy; the proofs run after it.

**Proposal (decision D6):** coding and deploys stop at T+450 as asked, and the **read-and-prove queue keeps running** after the final deploy until empty (≈ +5 h with D1 = yes). It needs no code, only Labtest writes that are already approved. A failure after T+450 gets a fix PR left **open for the morning**, not deployed.

Never cut (code): U0, U1, U2a, U3, U5, U6, U13, U7, U8, U9. Cut order for proofs if the queue is still behind at go-live: DV amend → POP → multi-stay HRDAV → party.

## 9. Waves

| Time | Lanes start | HMS |
|---|---|---|
| T0 | U1, U6, U2a, U3, U13, U10-F1, U11, **U4-evidence (read-only readback of `66865808-1` via existing lab tooling, orchestrator)** | kickoff checks + live SHA |
| T+15 | U2b probe (SQL) | P1 inventory + penalty dump (read-only) |
| T+60 | U0 (on U1 branch), U5 (after U1), U2b, U4 | — |
| T+90 | U7 (from P1 dump), U8-M2, U12 | P8 party (read) |
| T+130 | **D-A** (U0 U1 U2a U3 U4? U5 U6 U13) | P2 create HRCEN; HRDAV preflight → create (if D1) |
| T+150 | U9 (after U1), U8-M3, U10-F2 | |
| T+220 | **D-B** (U2b U7 U8 U9 + fixes) | DV quote flag on; P4 cancel both; P7 quote both |
| T+260 | fix lanes per 6a | P3 amend HRCEN |
| T+340 | **D-C** (U10 U11 U12 + fixes) | |
| T+435 | merge stop | |
| T+450 | **Final deploy** | queue continues (D6): amend, multi-stay, POP, DV amend; re-run of any cell whose code changed in the final deploy |

## 10. Scope boundaries

**In:** the units above; ask rows 185–195.

**Deferred (owner):**
- multi-mailbox (ask 179, lowest)
- paid amend/cancel and charging (human in the loop; log the questions to ask staff)
- Folio read
- groups
- POP attach on HRDAV (probe only)
- a durable context-dataset table (G2)
- the full backtest harness (#218 picker + Labtest transform, 680–1,040 lines; scoped in `/tmp/plan1023` Unit H). Tonight's per-workflow end-to-end check is the proof grid + quote scorer + party retest

**Outside rules (unchanged):**
- no real-guest writes
- no penalty acceptance on real guests
- no LLM driving HMS
- no GitHub Actions
- no local tsc or test runs

---

## 11. Decisions for the owner before kickoff

| # | Decision | Recommend | If no answer |
|---|---|---|---|
| D1 | One HMS lock per **property** (two browsers, two logins) instead of one global lock | **Per property**: saves ~2–3 h on the expected path (§8c) | **Serial** (the run starts serial; parallel only after a written yes) |
| D2 | Write switches at go-live for Faith/Bongi | Keep `lab` until each cell passes on the final SHA; owner flips per workflow in the morning | `lab` |
| D3 | Watchdog cadence | **30 min** (evidence §6) | 30 |
| D4 | Orchestrator model | Grok 4.6 high (SR3: code 0.4× plan; failures were idle + wrong-tree deploys, now guarded by the tick rule + D-A check) | Grok 4.6 high |
| D6 | Proofs continue after the final deploy (no more deploys; failures → open PR for the morning) | **Yes**: grid needs ~12.5 h, coding ~5.5 h | Stop at T+480 with partial grid |
| D5 | Codex Sol computer-use | Offline only: Sol reads the saved dumps/screenshots to design selectors. Driving live HMS, even Labtest, needs an explicit rule change | Offline only |

---

## 12. Sources

- **Scoping reports (Sonnet-slot → Luna max, 8 lanes, 2026-10-23 00:35–00:55Z):** quote, create, amend, cancel, multi-stay, POP+Sol, linking+66 h, backtest. Their file:line evidence is cited per unit above.
- **Prod SQL:** read-only, `BEGIN READ ONLY … ROLLBACK`, scripts `/tmp/plan1023/value*.sh`.
- **Docs:**
  - `docs/context/ledger/2026-10-22-dv-install-retro.md`
  - `docs/context/ledger/2026-10-22-sr3-overnight-retro.md`
  - `docs/research/2026-10-22-sr3-proofs.md`
  - `docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md`
  - `docs/research/2026-10-22-stagehand-hms-decision.md`
  - `docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md`
  - `docs/research/2026-10-22-quote-expiry-followup.md`
  - `docs/plans/2026-10-20-006-stay-request-build-plan-v2.md`
- **PRs:** #461, #463, #475, #476, #482, #484, #487, #488, #218, #143.
- **ETA ledger medians (n):** code-server 0.82 (142), live-hms 0.88 (33), orchestration 1.25 (23), deploy 0.83 (42).
