# Centurion Responded Detection + Conversation-Link Precision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship **revenue-grade answered/unanswered detection** aligned to the exhaustive EOD gold ledger (**Act 483 / Rsp 282 / Un 201 / uEPV R891k**), then harden UI conversation links so template mega-clusters die. Product value = know when Centurion answered a commercial ask (quote / voucher / PoP / auto-confirm) vs missed revenue. UI polish deferred.

**Non-goals:** Rewrite `thread_id`. Gmail-style subject merge. Layer D LLM linker this ship. Stub/hex UI redesign.

**Authority gold (exact paths on this VPS):**
- Chart: `.private/connected-mailbox-corpus/follow-up/defensible-daily-chart-2026-09-01-eod.md`
- Totals JSON: `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01-eod.json` → `{totals: {actionable:483, responded:282, unanswered:201, uepv:891413}}`
- Per-thread ledger: `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01-eod-threads.json` (fields: `threadId`, `fullThreadId`, `responded`, `responseSignals[]`, `threadClass`, `intent`, `decision`, …)
- Corrections / FP-FN queues: `.private/connected-mailbox-corpus/follow-up/_work/exhaustive-*-2026-09-01-eod.json`, `exhaustive-label-corrections-2026-09-01-eod.json`
- Signal-port reference Python: `.private/connected-mailbox-corpus/follow-up/_work/regen-defensible-eod-exhaustive.py`, `exhaustive-response-audit.py`, `defensible-daily-chart-2026-09-01.py`
- Method chat (optional context): `93ca17e9-95dd-4c35-9114-aac87dcc250e`
- **Supersedes** older gold `defensible-daily-chart-2026-09-01.json` (**438/246/192**) — do not keep those constants.

**Product lock (do not reopen):** KPI = binary `responded` only. No new voucher/PoP enums. `threadClass` / `intent` may filter later; v1 ships Un/Rsp/Act/uEPV vs EOD ledger.

---

## Global Constraints

- Pilot RDS: never Vitest against `nava-zero-mail-pilot`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- No PII in Git, web search, or remote MCP. Subagents get local paths + purpose only.
- Client-authorized corpus may be read unredacted locally.
- Primary checkout may be dirty/detached — implement from **clean worktree** branched off `origin/main`.

---

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions. No “which approach?” pause. Resume until done criteria evidenced or true blocker.

**Front door:** follow `/nava-run` (`~/.cursor/skills/nava-run/SKILL.md`) on **this plan file**. Overlay: `.cursor/skills/overnight-autonomous-zero/SKILL.md`. REQUIRED SUB-SKILLS: `subagent-driven-development`, `test-driven-development`, `verification-before-completion`; end with `ce-code-review` + `ce-compound`. Full standard `/autonomous-plan` + `/nava-run` skill/MCP surface is allowed.

### Model lock (binding)

- **All coding, orchestration, reviews, and every subagent:** **GPT 5.6 Luna Max only** (harness slug: use whatever this environment names Luna Max / `gpt-5.6-luna*` — pick the Max/highest Luna 5.6 variant available; never Fast).
- **Forbidden models:** any non-Luna, any Fast variant, Composer/Claude/Grok/other families for implementers or reviewers.
- If Luna Max unavailable for a subagent slot → **work inline on Luna Max**; do not fall back to another family.
- Skills, MCP, deploy wrappers, corpus tools: use freely (not a model swap).

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| This VPS / laptop repo | `/home/ubuntu/projects/zero` (agent cwd) |
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Centurion transport | `transport-centurion` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| Guts | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate, read-only SSM, PM2 logs, health curl, disposable non-prod DB tests.

**Forbidden:** force-push main, `--no-verify`, destructive git, Vitest against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into test shells.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

### Decision authority

- Choose best safe reversible option; log divergences.
- Better route to accepted goal OK if requirements preserved.
- Subagents: **GPT 5.6 Luna Max only** (see Model lock); else inline on Luna Max.
- Locked: binary `responded` KPI (no voucher/PoP enums this ship).

### RCA loop

FAIL → reproduce → root cause (file:line) → smallest correct fix → test → resume.

### Cursor execution-backend flake

`Execution backend unavailable...` → `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md` — not a human gate.

### Done criteria

- [x] Layer B eval vs EOD gold **483/282/201**: recall ≥95% of 282 responded (≥268 TP), FP ≤2% of 201 unanswered (≤4 FP) — or documented residual with RCA + gold-edge evidence.
- [x] Signal taxonomy ports EOD prefixes used for revenue (quoted_* family, in_reply_to_hotel_msgid, orphan_*, cross_thread_conf, staff_inbound_commercial_reply, in_thread) without loose orphan/cross FPs that exhaustive audit flipped.
- [x] Layer C: no template mega-component ≥8 (bounce/handover/Nedbank/quotation); Zuko-class ≤5; Breakfast Pack staff RE still links.
- [x] Pilot: deactivate superseded unsafe edges + re-backfill; bounce/Zuko screenshots fixed; health OK.
- [x] No LLM; no `thread_id` rewrite; UI polish not required this ship.
- [x] Handoff updated with before/after KPI + link totals.

### True blockers

Missing credentials, disposable DB absent for required tests, destructive ambiguity on gold labels, safety conflict, external outage blocking proof.

## Execution Mode

Autonomous overnight. **Invoke `/nava-run` on this plan.** Clean worktree from `origin/main`. Resume first incomplete task. `/continue-autonomously` is fail-safe, not a pause.

---

## Zero-context bootstrap (read before coding)

### Baseline already shipped

- Layers A–E live on **`origin/main` @ `28249c5c`** (`feat(centurion): conversation linking…` + Breakfast Pack staff-internal fix).
- Prior plan/handoff (context only): `docs/superpowers/plans/2026-09-02-centurion-thread-matching-implementation.md`, `docs/superpowers/plans/handoff-reports/2026-09-02-centurion-thread-matching.md`.
- **This plan upgrades Layer B gold + Layer C precision.** Do not re-ship A/E from scratch.

### Current Layer B gap (why Task 0 fails)

| Item | On `main` today | Required |
|------|-----------------|----------|
| Gold totals | `GOLD_*` = **438 / 246 / 192**, recall≥221, FP≤4 | **483 / 282 / 201**, recall≥268, FP≤4 |
| Gold files | `…/defensible-daily-chart-2026-09-01.json` | `…-eod.json` + `…-eod-threads.json` |
| `ConversationSignal` union | `in_thread_outbound`, `cross_thread_conf`, `orphan_auto_confirm`, `orphan_centurion_human`, `quoted_hotel_header`, `quoted_hotel_phrase` | + EOD prefixes listed in signal table below |
| Eval CLI exit gate | hardcodes `goldTotal !== 438` | EOD 483 |

### Commands (package `@zero/server`)

```bash
cd /home/ubuntu/projects/zero   # or clean worktree
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

# unit
pnpm --filter @zero/server exec vitest run tests/conversation-signals.test.ts tests/conversation-signals-gold.test.ts tests/conversation-link.test.ts

# offline Layer B eval (confusion matrix stdout; no PII)
pnpm --filter @zero/server exec tsx scripts/eval-centurion-conversation-signals.ts

# Layer C backfill (pilot) — dry-run then apply
pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts --transport=transport-centurion --confirm-pilot-rds
pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts --transport=transport-centurion --apply --confirm-pilot-rds

# after implementing --deactivate-unsafe (does not exist yet on main):
# …backfill… --deactivate-unsafe --confirm-pilot-rds   # dry-run default
# …backfill… --deactivate-unsafe --apply --confirm-pilot-rds
```

### Deploy land pattern

```bash
# from clean worktree with plan-owned commits
GIT_BRANCH=<feat-branch> apps/server-pilot/deploy/ops-deploy.sh   # --migrate only if schema changed
```

### Offline smash evidence (Layer C)

- Replay report (if present): `/tmp/centurion_conversation_link_report_full.json` — `subject_cluster` ~79% of links; mega-components bounce/handover/Nedbank/Zuko.
- If missing: regenerate via existing linkage audit / discover replay used in prior handoff; do not invent counts.

### Related schema

- `apps/server-pilot/src/db/schema/mail-conversation-link.ts` — edges include `supersededAt`; grouper must ignore superseded.
- Do **not** rewrite `thread_id`. Overlay only (`conversationId` / links).

---

## Problem split (do not conflate)

| Layer | Job | User value | Current bug |
|-------|-----|------------|-------------|
| **B — Conversation signals** | Detect **responded** for KPI / triage / uEPV | Revenue: unanswered = missed money | Ported early gold (438/246); EOD gold is **483/282** with richer signals + FP purge |
| **C — Conversation links** | Overlay `conversationId` for inbox merge | UX: split RE as one conversation | `subject_cluster` + orphan fan-out smash (99/71/47/39) |

**Other LLM did Layer B, not Layer C.** It labeled each actionable thread responded/unanswered via multi-pass **body/header signals**, then exhaustive FN/FP review. It did **not** invent Outlook mega-threads from identical subjects.

---

## How the EOD linker worked (evidence)

**Window:** Act **483** / Rsp **282** / Un **201** / uEPV **R891k**. Audit PASSED (132 external unanswered, 0 quote leaks).

**Correction note (from gold JSON):** SynXis/channel-auto excluded; Gmail/Apple/From-Date quoted hotel + staff commercial replies; **31+ ambiguous orphan/cross FPs flipped to unanswered**; Vision Travel / Apple-Mail / staff-rate FNs flipped to responded.

**Signal prefixes on 282 responded threads (count of signal occurrences):**

| Prefix | Count | Role |
|--------|------:|------|
| `quoted_outlook_legacy_from` | 163 | Guest reply quotes Outlook “From: …@legacyhotels” |
| `in_reply_to_hotel_msgid` | 159 | Header points at hotel Message-ID |
| `quoted_hotel_header` | 145 | Quoted Centurion/Martha/Isaac From block |
| `quoted_staff_sig` | 139 | Staff signature in quoted body |
| `orphan_auto_confirm` | 122 | Confirmation Letter on other thread to same guest |
| `in_thread` | 114 | Same-thread hotel outbound |
| `cross_thread_conf` | 98 | Conf# / guestNorm ↔ auto confirm index |
| `quoted_hotel_phrase` | 60 | “please find attached quotation…” class |
| `staff_inbound_commercial_reply` | 40 | Staff replies into commercial thread |
| `quoted_gmail_hotel` | 26 | Gmail quote format |
| `orphan_centurion_human` | 8 | Human Centurion outbound other thread |
| `quoted_from_centurion_date` | 4 | From-Date style quote |
| `quoted_applemail_hotel` | 1 | Apple Mail quote |

**192 / 282** responded threads have **no** `in_thread` — revenue truth is mostly **cross-thread / quoted**.

**Commercial outcomes → signals (how gold encodes user-asked tracking):**

| User cares about | How gold marks “answered” | Primary signals |
|------------------|---------------------------|-----------------|
| Quote sent | Hotel outbound / quoted hotel phrase in guest reply | `in_thread`, `quoted_hotel_phrase`, Outlook/Gmail quoted From |
| Auto confirmation (Info/SynXis letter) | Confirmation Letter on other thread to same guest/conf# | `orphan_auto_confirm`, `cross_thread_conf` |
| Voucher / PoP / payment proof in chain | Often `threadClass=voucher_drop` (73 in ledger) + responded when hotel/staff reply/quoted block exists; EPV tier separate | `in_thread`, `staff_inbound_commercial_reply`, quoted hotel blocks |
| Missed revenue | `responded=false` after FP purge | Un bucket (201) |

Gold labels **binary responded** + EPV; it does **not** emit separate voucher/PoP enums. Downstream dashboards can refine outcome classes later; v1 KPI = Un/Rsp/Act/uEPV vs this ledger.

**Implication:** Ship Layer B to match this taxonomy + FP discipline. Layer C must **not** use loose subject clustering for “responded.”

---

## Architecture (locked)

```text
Layer A  ingest     RFC headers → thread_id                    AUTHORITATIVE
Layer B  signals    EOD-aligned responded detector → KPI       PRIMARY PRODUCT
Layer C  links      precision overlay → conversationId         SECONDARY UX
Layer D  LLM        residual                                   OUT OF SCOPE
Layer E  UI         reads B badge + C grouping; polish later   MINIMAL
```

**SOTA (/95):** JWZ/RFC headers for ingest; hospitality conf# + quoted body for response detection; subject last and guarded for UI only. Outlook parity ≠ Gmail subject smash. Sources: jwz.org/doc/threading.html; RFC 5256; Nylas Gmail-vs-Outlook threading; corpus smash report + EOD ledger.

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/mail/conversation-signals.ts` | Port EOD signal detectors; tighten orphan/cross FP rules; expand `ConversationSignal` |
| `apps/server-pilot/src/ops/centurion-conversation-signals-eval.ts` | Retarget gold constants + paths to EOD 483/282 ledger |
| `apps/server-pilot/scripts/eval-centurion-conversation-signals.ts` | CLI gate must use EOD totals (drop hardcoded 438) |
| `apps/server-pilot/tests/conversation-signals.test.ts` | Unit fixtures per new signal family |
| `apps/server-pilot/tests/conversation-signals-gold.test.ts` | Gold contract assertions → 483/282/201 + recall/FP gates |
| `apps/server-pilot/src/mail/conversation-link.ts` | P1–P5 precision guards (system overlap, template refuse, bucket cap, conf#-gated auto orphan) |
| `apps/server-pilot/src/mail/conversation-group.ts` | Ignore `supersededAt IS NOT NULL` edges when resolving `conversationId` |
| `apps/server-pilot/tests/conversation-link.test.ts` | Smash fixtures + Breakfast Pack staff-internal RE |
| `apps/server-pilot/scripts/backfill-centurion-conversation-links.ts` | Add `--deactivate-unsafe` (set `supersededAt`, shared predicates w/ discover) + recompute |
| `apps/server-pilot/src/ops/centurion-thread-linkage-audit.ts` | Offline C precision gates |
| `docs/superpowers/plans/handoff-reports/2026-09-02-centurion-thread-matching.md` | Append B KPI + C smash before/after (or new dated handoff sibling if cleaner) |

---

## Policy

### Layer B (revenue)

1. Port missing detectors used by gold: Outlook/Gmail/Apple quoted-from, `in_reply_to_hotel_msgid`, `staff_inbound_commercial_reply`, `quoted_staff_sig`, `quoted_from_centurion_date`.
2. Keep existing: `in_thread_outbound`, `cross_thread_conf`, `quoted_hotel_header/phrase`, `orphan_auto_confirm`, `orphan_centurion_human`.
3. **FP discipline from exhaustive audit:** orphan/cross alone insufficient when ambiguous — require conf# **or** guestNorm (≥5) **or** strong quoted hotel block; do not mark responded on weak guest-email orphan alone without auto-confirm subject or human Centurion From.
4. Eval harness reads EOD threads JSON; gate on 282/201.

### Layer C (UI links) — same as prior precision plan

- P1 `isSystemAddress`; P2 template/low-entropy refuse; P3 non-system overlap; P4 bucket >8 skip; P5 auto orphan requires conf# + cap 1.
- Deactivate uses `supersededAt`; grouper ignores superseded; shared predicates with discover.

---

## Tasks

### Task 0: Gold contract lock

- [x] **Step 1:** Point eval at EOD paths; set `GOLD_ACTIONABLE=483`, `GOLD_RESPONDED=282`, `GOLD_UNANSWERED=201`, `GOLD_RECALL_MIN=268`, `GOLD_FALSE_POSITIVE_MAX=4`. Prefer loading labels from `…-eod-threads.json` (`responded` field).
- [x] **Step 2:** Failing eval against current detector (expect miss vs 282 / FP vs correction set). Update CLI hardcoded 438 gate.
- [x] **Step 3:** Commit constants + failing eval baseline note.

### Task 1: Layer B signal port (TDD)

**Files:** `conversation-signals.ts`, `tests/conversation-signals*.ts`, eval ops

- [x] **Step 1: Failing tests** per new signal family (Outlook quoted From, In-Reply-To hotel MID, staff inbound commercial, Apple/Gmail variants) + FP cases (loose orphan flipped in audit).
- [x] **Step 2: Implement detectors** (deterministic regex/header only — no LLM).
- [x] **Step 3: PASS unit tests** with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- [x] **Step 4: Run eval vs EOD ledger** — iterate until done-criteria recall/FP met.
- [x] **Step 5: Commit**

### Task 2: Layer C precision harden (TDD)

**Files:** `conversation-link.ts`, `conversation-link.test.ts`

- [x] **Step 1: Failing tests** — bounce×3, handover×9, quotation×9 → 0 SC; agency 5 auto confs different conf# → 0; one conf in inbound → 1 link; Breakfast Pack → 1 SC.
- [x] **Step 2: Implement P1–P5**; ensure grouper skips `supersededAt IS NOT NULL`.
- [x] **Step 3: PASS vitest**; offline audit gates (SC ≤10% baseline, no template component ≥8, Zuko ≤5).
- [x] **Step 4: Commit**

### Task 3: Pilot ship

- [x] **Step 1:** Land on branch from `main`; deploy `GIT_BRANCH=… ops-deploy.sh`.
- [x] **Step 2:** `--deactivate-unsafe` dry-run → apply; backfill `--apply --confirm-pilot-rds`.
- [x] **Step 3:** Verify bounce=1, Zuko≤5, Breakfast Pack linked; health OK; triage still gets `conversationResponded` from Layer B.
- [x] **Step 4:** Handoff + commit

### Task 4: CE review

- [x] **Step 1:** ce-code-review on diff.
- [x] **Step 2:** Confirm done criteria checklist green.

---

## Review disposition

| Gate | Result |
|------|--------|
| /95-exa-subag | Met: EOD method = signal detection; SOTA = headers + hospitality keys; subject guarded |
| eng | MUST: B/C split; `supersededAt`; shared predicates; EOD gold paths |
| ponytail | KEEP: signal port + SC guards; CUT: new policy file, second CLI, LLM, UI redesign |
| design | Skipped (UI deferred) |
| autonomous-plan | Mandate merged above |

---

## Sources

- EOD gold MD/JSON/threads (local private)
- `conversation-signals.ts` / `conversation-link.ts` (worktree/main)
- https://www.jwz.org/doc/threading.html
- https://www.rfc-editor.org/rfc/rfc5256.html
- https://developer.nylas.com/docs/cookbook/email/threads/gmail-vs-outlook-threading/
- Corpus smash: `/tmp/centurion_conversation_link_report_full.json`
