# Tier 5 Backlog Doc Update Implementation Plan

> **Superseded (2026-07-03):** User promoted all Tier 5 items to code. Use [`2026-07-03-ec2-pilot-tier5-implementation.md`](2026-07-03-ec2-pilot-tier5-implementation.md) instead. Doc-update steps live in U8 of that plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Tier 5 backlog section in the EC2 pilot bug-fixes plan up to date with verified post-wave status (fixed / partial / open / untested) so a solo supervisor can trust what shipped vs what remains deferred.

**Architecture:** Docs-only. No application code changes. Cross-reference bug-hunt IDs, gate report, and code @ `1a3e0d98` (last code commit) / `c0a21bd1` (docs gate commit). Update one primary plan file; optional one-line pointer in progress ledger.

**Tech Stack:** Markdown, git read-only verification.

**Origin:** `/95` audit request after 7-wave bug-fix execution on `EC2-pilot`.

## Global Constraints

- Branch: `EC2-pilot` (do not merge to main from this task).
- No Tier 5 code fixes unless explicitly promoted in a separate plan.
- Repo plan path convention: `docs/superpowers/plans/`.
- C8 documented as **intentional 400d session** (user decision), not bug-hunt's 300s sketch.
- Do not overwrite or conflate with `docs/superpowers/plans/2026-07-03-nava-live-mail-test-harness.md` (parallel work by another agent — unrelated scope).

---

## Freshness Check (2026-07-03)

Verified before writing this plan:

| Check | Result |
|-------|--------|
| Branch | `EC2-pilot` @ `c0a21bd1` (HEAD) |
| Code commits | Unchanged since audit: `4b173f5e` … `1a3e0d98` (7 waves) + `c0a21bd1` (gate docs) |
| Uncommitted code diffs | **None** on Tier 5 touch files (`mail.ts`, `auth.ts`, `labels.ts`, `s3.ts`, `query-provider.tsx`) — `mail.ts` shows CRLF-only dirty flag |
| Other agent artifacts | New `2026-07-03-nava-live-mail-test-harness.md`, compound-engineering dirs — no overlap with Tier 5 doc task |
| Tier 5 table in bug-fixes plan | Still stale (2-column, no status) |
| EC2 gate | 101 server tests pass; 53 skipped; signup 403; `MAIL_TRANSPORT_MODE=fixture` |

**Conclusion:** Prior `/95` audit conclusions remain valid. Safe to proceed with doc update only.

---

## Key Technical Decisions

1. **Update in place** — Edit `docs/superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md` § Tier 5 rather than a forked plan (single source of truth for bug-fix program).
2. **Status vocabulary** — `fixed` | `partial` | `open` | `open (latent)` | `open (meta)` plus a **Test coverage** column (`none`, test file names, or `untested in browser`).
3. **Wave overlaps section** — Document C10, D14, D15, A17, E1/E2/E5 as fixed outside Tier 5 table (were never listed there).
4. **Verification gaps section** — Separate from Tier 5: manual UI, browser pagination, real mail, load-50-users 2xx, EC2 integration tests with `TEST_DB_AVAILABLE=1`.
5. **No code LOC in this plan** — Doc edit ~120–180 markdown lines; Tier 5 code fixes deferred (see summary table in this plan's appendix for rough LOC if promoted later).

---

## Implementation Units

### U1. Replace Tier 5 table with audited status columns

**Goal:** Replace the flat 24-row backlog with Status + Test coverage columns reflecting code @ `1a3e0d98`.

**Files:**
- Modify: `docs/superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md` (§ Tier 5 backlog, ~lines 541–571)

**Approach:** Replace table body with audited rows:

| ID | Status | Test coverage |
|----|--------|---------------|
| B15 | open | none |
| B16 | open | isolation NOT_FOUND only |
| B17 | open | wire-contract shape only |
| B18 | fixed (main) / partial (secondary) | `toParsedMessage` unit; no `mail.get` integration; UI untested |
| B19 | open (latent) | none |
| B20 | open | create in isolation test; duplicate-rename untested |
| C6 | open (latent) | FakeS3 only |
| C8 | fixed (different) | `auth-session-ttl.test.ts` — 400d not 30d/300s |
| C9 | open | none |
| C11 | open | none |
| C12 | open | none |
| D6 | open | none |
| D10 | open | not in CI |
| D11 | open | none |
| D12 | open | none |
| D13 | open | ops-only |
| D16 | open | fragile global-count test exists |
| D17 | open | vitest aliases bypass exports |
| E3 | open | deferred per Task 11 note |
| E4 | partial | `query-cache-policy.test.ts`; browser cold-load unverified |
| E6 | open | none |
| E7 | open (latent) | none |
| E8 | partial | legacy key delete on mount; migration unverified |
| A16 | open | none |
| A18 | open (meta) | meta-gap |

Update prod pull order note: B18 code fixed but UI unverified; C8 semantics = 400d sliding session.

- [ ] **Step 1:** Open `docs/superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md` § Tier 5
- [ ] **Step 2:** Replace 2-column table with 4-column table (ID | Bug | Status | Test coverage)
- [ ] **Step 3:** Update "Pull into scope if hit in prod" bullet to reflect B18 partial + C8 intentional fix

**Verification:** Table has 24 rows; every ID from bug-hunt Tier 5 present; no row left as undifferentiated backlog.

---

### U2. Add wave overlaps and verification gaps subsections

**Goal:** Document fixes that happened during waves but were never in the Tier 5 table; list post-gate untested areas.

**Files:**
- Modify: `docs/superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md` (insert after Tier 5 table)

**Wave overlaps (fixed, not Tier 5):**

| ID | Status | Evidence |
|----|--------|----------|
| C10 | fixed | `user.getIntercomToken` → bare `null` |
| D14 | fixed | SIGTERM graceful shutdown |
| D15 | fixed | seed user+account in transaction |
| A17 | fixed | POP3 UIDL cache |
| E1/E2/E5 | fixed | scoped IDB, Infinity TTL, legacy delete |

**Verification gaps (post-gate, not Tier 5 bugs):**

- Manual UI smoke: login → inbox → thread → delete/undo → settings
- Browser: `nextPageToken` `{iso}|{id}` pagination past page 1
- Real POP3/SMTP TCP (IT blocked; fixture mode on EC2)
- `load-50-users.ts` 2xx gate on EC2
- Integration tests with `TEST_DB_AVAILABLE=1` on EC2 (53 skipped locally/EC2)
- Signup still 403 (unchanged guard)

- [ ] **Step 1:** Insert `### Wave overlaps (fixed during waves, not Tier 5)` subsection
- [ ] **Step 2:** Insert `### Verification gaps (post-gate)` subsection
- [ ] **Step 3:** Cross-link to `docs/superpowers/plans/handoff-reports/2026-07-02-bug-fix-gate-report.md`

**Verification:** Reader can distinguish shipped waves, deferred polish, and untested E2E without reading git log.

---

### U3. Optional progress ledger pointer

**Goal:** Single-line pointer so progress ledger readers find updated Tier 5 status.

**Files:**
- Modify: `docs/superpowers/plans/handoff-reports/progress-ledger.md` (bug-fix section only — one line)

**Approach:** Add: "Tier 5 status table updated 2026-07-03 — see bug-fixes plan § Tier 5."

- [ ] **Step 1:** Add pointer line under existing bug-fix gate entry
- [ ] **Step 2:** Do not duplicate full table in ledger (DRY)

**Verification:** Ledger links to authoritative table; no duplicate maintenance burden.

**Test expectation:** none — documentation only.

---

## Self-Review

- **Spec coverage:** `/95` audit + user request to update stale backlog table — U1–U3 cover fully.
- **Placeholder scan:** None.
- **Scope:** No code, no Tier 5 promotions, no nava harness edits.

---

## Execution Handoff

**Plan saved to:** `docs/superpowers/plans/2026-07-03-tier5-backlog-doc-update.md`

**Two execution options:**

1. **Subagent-Driven (recommended)** — Fresh subagent per unit, review between units
2. **Inline Execution** — Execute U1–U3 in this session with checkpoint after U1

**Which approach?**

---

## Appendix: Tier 5 item summary (for supervisor)

See chat response table — bug, why doc matters, importance, risks, rough LOC if promoted to code later.
