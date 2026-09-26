# Fast live `hms_find_reservation` + PMS video

Date: 2026-09-11.
Type: feat.
**Superseded for programme continuation by** `2026-09-11-centurion-pms-tools-robust-catalogue.md` (payload gate + full catalogue + Wave 0 HITL). This file remains the historical packaging-video plan; do not treat its done criteria as field-complete tool success.
**Replaces execution of** `2026-09-06-reservation-revenue-triage-drafting-plan.md` L1–L4 for this run only. That file stays historical; do not edit it while the Codex session is alive.

**Human gate (once):** pause/stop the Codex session `01a0773e-bb39-7542-8de6-6387e1aa7841` so it stops writing this worktree. Then this plan runs autonomously.

## Goal Capsule

- Run **one** live read-only Guest Stay search (`hms_find_reservation` / `createLiveGuestStayDriver.searchExact`) against real Infor HMS.
- Deliver **one** private playable Playwright video of real Chromium + real PMS row + returned search result.
- Do **not** rebuild isolated EC2 copies, admission-issuer theater, trace-ZIP sanitizers, or independent Luna review as a completion gate.
- After that video: remaining existing read tools reuse the same live session factory. Writes stay in `2026-09-11-write-tools-kickoff-from-3949-gold.md`.

## Why this plan exists

Codex (same worktree, 2026-09-06 → 2026-09-11) spent five days on live auth/runtime packaging. At 2026-09-11T12:46Z it authenticated to live PMS, then failed **before lookup-start**. The tool search itself (`OSRESS.search` via `live-guest-stay-driver.ts`) already exists. Fixture `InforReadAdapter.findReservation` already posts the same path. The missing deliverable is a live search + video, not a new tool contract.

## Global Constraints

- PMS **reads only**. `view_only`. No save/create/amend/payment/cancel/send/document generate.
- No Nava deploy/restart. No worker start/stop. No production-registry mutation.
- No Vitest against `nava-zero-mail-pilot`. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before every test run. Never `VITEST_ALLOW_PILOT_RDS=1`.
- Secrets, cookies, database URLs out of Git, videos, SSM, CI. Client PII stays in `.private/` mode 0600.
- Do not hijack Codex files **until its session mtime is frozen**. Then reuse useful diffs (`waitForAuthenticatedShell`, live driver) and drop packaging-only work.
- Do not parallel a second live PMS browser against the same `.hms-live-operation.v2.lock`.

## Cuts (this is the speed)

| Keep | Cut (Codex spent days here) |
|---|---|
| Existing `createLiveGuestStayDriver` + `searchExact` | Isolated checksummed EC2 source copy as a proof prerequisite |
| Existing `waitForAuthenticatedShell` + `view_only` secrets | Independent Luna review as a done-gate |
| Playwright `recordVideo` on the live page | Trace ZIP CRC/sanitizer as a blocker |
| One real confirmation/external-ref search + not-found canary | Worker/tRPC enqueue, issuer tickets, copied “application composition” |
| Compare visible search row vs returned JSON | 210-test packaging gate before every live attempt |
| `hms_find_reservation` contract already in `read-tools.ts` | Promoting `productionActiveReadToolIds` in this run |
| Private video under `.private/` | Building the other eleven tools in this run |

## Implementation

### T1. Freeze Codex, then inspect (no live PMS yet)

1. Confirm Codex JSONL mtime stopped.
2. `git status` / diff stat. Keep runtime/auth fixes; do not revert `waitForAuthenticatedShell` blindly.
3. Note EC2 copy path if present; **do not** use it as the runner. Run from this worktree.
4. Confirm operation lock is free.

### T2. Smallest live runner

Reuse in-repo pieces:

- `createLiveGuestStayDriver` (`apps/server-pilot/src/hms/live-guest-stay-driver.ts`)
- `buildExactOsressSearchManifest` / `LIVE_GUEST_STAY_SEARCH_PATH`
- `createHmsLiveProofRuntime` / Playwright 1.52.0 Chromium 1169
- Existing Secrets Manager path that already authenticated at 12:46 (in-memory, not vendor resolver if that failed)

If `hms-live-proof.ts` `proof-video` / `runProofVideo` can invoke `searchExact` without isolated-copy and without worker enqueue, use it. If composition (`issuePhaseAProofAuthorization`, mail-anchor selection, cleanup masking) is what failed before lookup-start, **bypass that wrapper**: login → binding check → `searchExact` on a known live confirmation → close with video.

Do not invent a second Playwright stack.

### T3. Live proof (the actual tool)

1. Login, `waitForAuthenticatedShell`, property binding match.
2. Optional not-found canary (`liveNotFoundCanaryCandidate`) — skip if it costs another hour; record skip reason.
3. `searchExact` with one real exact candidate (confirmation or external ref already on this property).
4. Parse/correlate HTML. Compare confirmation/name/dates on screen vs returned matches.
5. Video must show PMS UI and the result payload (separate viewer OK; no `setContent` into PMS DOM; no canned JSON).
6. Fail closed on mutation/blocked/download/websocket in the audit receipt.

### T4. Evidence handoff

Private dir `.private/hms-find-reservation-live-YYYYMMDD/`:

- playable `video.webm`
- receipt with digests only in any git-tracked note
- source/result comparison (no secrets)
- one paragraph: command, revision, what was cut vs Codex

Handoff path goes in `docs/superpowers/plans/handoff-reports/` **without** PII.

## Remaining tools (keep existing contracts — do not redesign)

After T4 video, same live factory, **one tool + one video each**. No isolated EC2 copy, no Luna-review gate, no worker enqueue.

### Wave A — already in `READ_TOOL_IDS` / siblings (live PMS)

| Order | ID | Change vs today | Why this order |
|---|---|---|---|
| 0 | `hms_find_reservation` | **This run.** Live `searchExact` + video | Unlocks every stay-scoped read |
| A1 | `hms_read_reservation` | Reuse find match → Guest Stay detail **read** only (`open_guest_stay_detail` stays denied on find) | Folio/docs/notes need a stay |
| A2 | `hms_read_folio` | Existing folio contract; 3949 named folio **763** | Money/ack mail |
| A3 | `hms_list_documents` / `documents_list_existing` | List only; no generate/upload | 1059 named |
| A4 | `documents_read_existing` | Authorized bytes already in HMS or mail | 354 named |
| A5 | `hms_quote_stay` | Existing quote contract; never CRS Check Availability | 582 named |
| A6 | `hms_group_block_read` | Keep; defer live if role blocked | 255 named |
| A7 | `hms_event_read` | Keep; defer live if blocked | 42 named |
| A8 | `hms_company_account_read` | Keep; defer live | 14 named |
| A9 | `hms_read_notes_traces` | Text only; not binary email | U15 sibling |
| — | `hms_sent_email_audit` | Keep registered, **do not promote** (3949 count = 2) | Not worth a live video |
| — | `mail_read_artifact` | Not an HMS screen; Nava mail bytes | Skip PMS video |

### Wave B — new reads (3949; not in live `READ_TOOL_IDS`)

| Order | ID | Why |
|---|---|---|
| B1 | `property_read_knowledge` | 141/3949; Astra U16 never shipped TS |
| B2 | `mail_parse_channel_payload` | 173; WebBeds/RateTiger “see below”; not HMS |

### Wave C — writes (HITL; after reads exist)

Canonical evidence: `2026-09-11-write-tools-kickoff-from-3949-gold.md`. Do not start in this run.

`mail.send_with_attachments` → `hms_attach_guest_stay_document` → generate/send quote/invoice/CL → `hms_post_payment` (pending 165) → `hms_refund` (40) → create (31) → cancel/amend.

Shared envelope: inert proposal → HITL execute → reread. Timeout ≠ retry charge.

### ETA after Wave 0 video (same cuts)

| Slice | Guess | Assumption |
|---|---|---|
| Each extra live HMS read | hours, not days | Session factory reused; one screen |
| Two new reads (B) | 0.5–2 days | Knowledge is files; channel is mail parse |
| First write (send-existing-PDF) | 1–3 days | HITL + no money |
| `hms_post_payment` | days + supervisor policy | Live write; not this week |

Codex 5-day cost was packaging, not OSRESS. Do not reintroduce it.

## Overnight Autonomous Execution Mandate

**User granted full autonomy after Codex is paused.** Continue until the video+comparison exist or a true blocker (missing live secret/access, PMS outage, safety conflict).

### Decision authority

- Choose the smallest safe reversible runner. Bypass `runProofVideo` composition if it cannot reach `searchExact`.
- Do not silently cut the live-PMS + video requirement.
- Standard non-fast subagents only; otherwise inline.

### RCA loop

FAIL → preserve private log → root cause at file:line → smallest fix → rerun live search. Do not add new packaging layers.

### Safety

Follow repository rules. Never force-push, bypass hooks, expose secrets/PII, or Vitest against pilot/production RDS.

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

Allowed: read-only SSM, existing pinned browser, Secrets Manager in memory, copy of development files if needed. **Forbidden for this run:** `ops-deploy.sh`, `ops-restart.sh`, worker lifecycle, production registry, Nava repo replace.

### Done criteria

- [ ] Codex session paused (mtime frozen) before this worktree is edited
- [ ] `searchExact` (or equivalent existing driver) returned a live Guest Stay match or an evidenced not-found with a known-positive retry
- [ ] Source/result comparison on a real record
- [ ] One private playable Playwright video of that run
- [ ] No mutation/save; `view_only`
- [ ] Handoff index with paths/digests/expiry; no unresolved prerequisite for the claimed tool

### True blockers

Missing HMS secret/access that cannot be obtained safely; human-only MFA; PMS outage; Codex still writing this worktree.

## Execution Mode

Autonomous after the pause. Resume T1. No “which approach?” checkpoint.

## Parallel / steer (rejected)

- **Steer Codex:** already tried 2026-09-11T11:39. It agreed, then kept EC2 copy + privacy review. Do not send another steer.
- **Parallel second Cursor on this worktree:** same dirty files (`worker.ts`, `runtime.ts`, `read-service.ts`, `browser-artifacts.ts`, `hms-live-proof.ts`) and the same live operation lock. Do not.
- **Parallel different tool in a new worktree:** only after this video exists.

Handoff prompt if someone later wants a second chat (folio), after find-reservation video:

```
Worktree: NEW git worktree off feat/centurion-dashboard-tools AFTER find-reservation video is merged or this worktree is idle.
Tool: hms_read_folio only. Live read, view_only. Reuse createLiveGuestStayDriver session factory + existing folio contract. One Playwright video. Do not touch worker.ts admission, isolated EC2 copy, or trace-privacy ZIP. Do not run Vitest with DATABASE_URL. Codex session 01a0773e must be stopped.
```
