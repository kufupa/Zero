---
title: Folder-First Spam via spam_at — Folder Transition Matrix and Orphan Prevention
date: 2026-07-27
last_updated: 2026-07-31
category: architecture-patterns
module: server-pilot mail-spam
problem_type: architecture_pattern
component: email_processing
severity: high
applies_when:
  - "Implementing or extending server-pilot spam folder behavior where mail_thread.spam_at is the sole spam truth"
  - "Adding bin, trash, archive, or emptySpam transitions that must clear spam_at to avoid invisible orphans"
  - "Wiring auto-triage never-spam allowlist without blocking manual mark-spam or sender block preferences"
  - "Freezing AI spam flips after user not-spam via spam_user_locked_at"
  - "Deploying spam MVP on EC2-pilot while 30-day hard purge remains deferred / unimplemented"
tags:
  - spam-at
  - folder-first
  - orphan-prevention
  - never-spam
  - spam-user-locked
  - empty-spam
  - sender-preference
  - ec2-pilot
  - server-pilot
  - image-trust
---

# Folder-First Spam via spam_at — Folder Transition Matrix and Orphan Prevention

## Context

Hotel mail pilot (`apps/server-pilot` + `apps/mail`) shipped a night-1 spam MVP on branch `EC2-pilot` (commits `982c82f7` through `d4800a1b`). Folder placement is **folder-first**: `mail_thread.spam_at` is the sole truth for whether a thread lives in the Spam folder. User labels named `SPAM` are legacy noise and must not contradict folder state.

Earlier live-pilot work already treated spam as a thread flag distinct from hotel AI categories, and inbox listing required `spam_at IS NULL`. False positives were mitigated with `refineTriageOutput` (short personal notes) and an explicit **no auto-unspam** rule (settled spam never silently clears on later triage). Operators sometimes cleared `spam_at` by hand after bad triage. (session history)

That left a gap: folder *exits* from spam. Threads could hold **both** `spam_at` and `trashed_at`. `listThreads` filters are mutually exclusive per column: non-bin folders require `trashed_at IS NULL`; non-spam folders require `spam_at IS NULL`. A row with both timestamps matched **neither** Spam nor Bin — an invisible orphan. Archiving spam without clearing `spam_at` had the same class of bug (archive requires `spam_at IS NULL`).

Night-1 closes the gap architecturally: clear `spam_at` on every transition out of spam (bin, archive via `moveThreads`, delete-to-trash, label TRASH, `emptySpam`). Auto-triage spam is gated by never-spam allowlist + heuristics and an apply belt; user corrections persist via `spam_user_locked_at` and `mail_sender_preference`. Manual mark-spam remains allowed even for never-spam senders. Thirty-day hard purge remains deferred — plans mention `SPAM_PURGE_ENABLED`, but no consumer exists in `apps/` yet; use `emptySpam` for deliberate clears.

## Guidance

### Frozen folder matrix predicates

`listThreads` in `apps/server-pilot/src/trpc/routes/mail.ts` applies these rules (all non-bin folders also require `trashed_at IS NULL`; all non-spam folders require `spam_at IS NULL`):

| Folder | Predicate |
|--------|-----------|
| **spam** | `spam_at IS NOT NULL` AND `trashed_at IS NULL` |
| **bin** | `trashed_at IS NOT NULL` AND `spam_at IS NULL` (bin is a non-spam folder — list filter requires clear `spam_at`; **always clear** `spam_at` when entering bin) |
| **inbox** | `trashed_at IS NULL`, `spam_at IS NULL`, `is_archived = false`, plus inbound/snooze rules |
| **archive** | `is_archived = true` AND `spam_at IS NULL` AND `trashed_at IS NULL` |

**Rejected:** keeping `spam_at` when archiving spam. `moveThreads` archive must set `spamAt: null` or threads disappear from archive lists. **Gap:** `bulkArchive` currently sets only `isArchived=true` and does **not** clear `spamAt` — prefer `moveThreads` archive (or fix `bulkArchive`) when exiting spam.

### Clear `spam_at` on every exit-from-spam path

Every mutation that moves a thread to trash/bin must null `spam_at`:

- `moveThreads` destination `bin` — `trashedAt = now()`, `spamAt = null`, `isArchived = false`
- `moveThreads` destination `archive` — `isArchived = true`, `trashedAt = null`, `spamAt = null`
- `modifyLabels` when TRASH added — same as bin
- `bulkDelete` / `delete` soft-trash — `trashedAt = now()`, `spamAt = null`
- `emptySpam` — bulk soft-trash all spam-folder threads

```ts
// moveThreads bin branch (mail.ts)
if (input.destination === 'bin') {
  patch.trashedAt = new Date();
  patch.spamAt = null;
  patch.isArchived = false;
}
```

```ts
// emptySpam (mail.ts)
.set({
  trashedAt: new Date(),
  spamAt: null,
  isArchived: false,
  updatedAt: new Date(),
})
.where(
  and(
    eq(mailThread.transportId, transportId),
    isNotNull(mailThread.spamAt),
    isNull(mailThread.trashedAt),
  ),
)
```

Post-deploy DB smoke held: `orphan_spam_and_trash=0`, `orphan_archive_spam=0`.

Clearing on explicit user/folder actions does **not** violate the older “no silent auto-unspam on re-triage” rule — those are different exit channels. (session history)

### Never-spam vs manual mark-spam

**Auto-triage only.** `isAutoTriageNeverSpam` in `never-spam.ts` matches:

- Domains `legacyhotels.co.za` and `mail.legacyhotels.com` (case-insensitive, angle-address aware)
- Emails `aroransh17@gmail.com`, `coleddofficial@gmail.com`

```ts
export function isAutoTriageNeverSpam(fromRaw: string): boolean {
  const email = normalizeEmailAddress(fromRaw);
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex + 1);
  if (AUTO_TRIAGE_NEVER_SPAM_DOMAINS.has(domain)) return true;
  return AUTO_TRIAGE_NEVER_SPAM_EMAILS.has(email);
}
```

**Refine gate** (`refineTriageOutput`): if Nova returns `category: 'spam'` and sender is never-spam, remap before apply — `@legacyhotels.co.za` / `@mail.legacyhotels.com` → `ops`, pilot Gmails → `new-bookings`, flag `refine:never-spam-allowlist`.

**Dual use (not spam):** the same hotel domain allowlist seeds default **Image trust** in the mail reader. Spam auto-path and remote-image loading stay distinct product surfaces — see [email-html-images-cid-rewrite-and-trusted-sender-domains.md](../ui-bugs/email-html-images-cid-rewrite-and-trusted-sender-domains.md).

**Apply belt** (`applyDurableTriageResult`): even if refine is skipped, before writing `spam_at` check `preference === 'allow' || isAutoTriageNeverSpam(latestFrom)` and skip the spam write.

**Manual `moveThreads` destination `spam`** still sets `spamAt` for never-spam Froms — user intent wins. **Ingest block** (`mail_sender_preference.kind = 'block'`) also sets `spam_at` on persist, including never-spam addresses.

Precedence on auto path: never-spam allowlist and sender `allow` > AI spam category; sender `block` at ingest > never-spam (user blocked a sender explicitly).

Heuristic refine (short-personal, agency, guest-file, handover) remains the first false-positive gate; never-spam is the hard allowlist for known hotel/tester Froms. (session history)

### User lock (`spam_user_locked_at`)

Schema: migration `0012_mail_thread_spam_user_lock.sql`.

- **Settled** thread = has primary category OR `spam_at` OR `spam_user_locked_at`.
- Settled threads: AI apply is `urgency_only` — cannot flip `spam_at`.
- `moveThreads` inbox: `spamAt = null`, `spamUserLockedAt = now()`, upsert sender `allow`.
- `moveThreads` spam: `spamAt = now()`, `spamUserLockedAt = now()`, upsert sender `block`.

"Not spam" + lock means later triage cannot re-stamp spam on that thread — the durable answer to “settled spam never auto-unflips” when the user *did* correct. (session history)

### Sender preferences (`mail_sender_preference`)

Migration `0014_mail_sender_preference.sql` — unique `(transport_id, email)`, `kind ∈ {block, allow}`.

Mark-spam/not-spam upserts preference for latest inbound `fromAddress` on the thread (multi-sender threads: latest inbound only). `moveThreads` returns `{ updated, preferences }` for FE Undo.

### UI honesty

- `isVisibleUserLabel` in `use-labels.ts` hides user labels whose name is `SPAM` (case-insensitive). Migration `0013_strip_spam_label_ids.sql` strips legacy SPAM label IDs from `label_ids`.
- `showSpamUndoToast` — 5s Undo after mark-spam; Undo calls `moveThreads` inbox (restores folder + allow preference).

### Ops night-1

- Thirty-day hard purge deferred — `SPAM_PURGE_ENABLED` appears in plans/handoffs only; no runtime consumer in `apps/` yet. Do not treat the env name as a live kill-switch until a purge job lands.
- API name: `mail.emptySpam` (not Gmail `deleteAllSpam`).
- Drizzle through `0012`–`0014` (+ id 15 on deploy).

## Why This Matters

Invisible threads destroy trust in a mail pilot faster than false spam classification. Folder predicates are **conjunctive** — dual state is not "show in both folders," it is **show in neither**. Clearing `spam_at` at trash/archive boundaries is cheaper and more reliable than widening list filters to OR-combine trash and spam.

Separating never-spam (auto-triage) from manual mark-spam preserves hotel operations: hotel-domain mail (`@legacyhotels.co.za` / `@mail.legacyhotels.com`) must never auto-vanish into spam, but front desk can still mark an abusive sender spam and block future ingest. Remap targets are current hotel categories (`ops` / `new-bookings`), not legacy `internal` / `individual`. `spam_user_locked_at` closes the loop when users correct Nova — without it, the next AI run re-spams corrected ham (the same class of stuck state that once required a manual SQL clear). (session history)

## When to Apply

- Adding any thread move mutation (new folder, bulk action, label sync) — ask: does this exit spam? If yes, null `spam_at`.
- Adding AI triage write paths — run through `refineTriageOutput` first; belt-check never-spam and sender `allow` in `applyDurableTriageResult`.
- Designing folder list queries — document predicates in a matrix; verify no OR-gap between spam and bin.
- User correction flows — set lock + preference, not just clear `spam_at`.
- Pilot deploy checklists — confirm 30-day purge still deferred (no live `SPAM_PURGE_*` consumer yet); run orphan counts after migrate.
- Do not invent silent re-triage unspam; prefer explicit user/folder exits + lock. (session history)

## Examples

**Orphan before fix:** thread has `spam_at` set, user deletes to bin → only `trashed_at` set → fails spam filter and fails or confuses bin listing depending on branch. Fix: always `spamAt = null` with `trashedAt`.

**Never-spam auto path:** Nova classifies `frontdesk@legacyhotels.co.za` as spam → refine remaps to `ops` with `refine:never-spam-allowlist` → apply never sets `spam_at` → thread stays inbox/ops.

**Manual mark on never-spam:** user marks thread from `aroransh17@gmail.com` spam → `moveThreads` spam sets `spamAt` + lock + block preference → allowed.

**User block overrides never-spam at ingest:** user previously blocked sender → new inbound from `@legacyhotels.co.za` → ingest sets `spam_at` despite never-spam on auto path.

**Not spam sticks:** user moves to inbox → `spamUserLockedAt` set, `allow` preference → subsequent AI spam apply returns `urgency_only`, `spam_at` stays null.

**Empty spam:** two threads in spam folder → `emptySpam` → both have `trashed_at`, `spam_at` null → visible in bin, absent from spam list.

**FE chip honesty:** thread has legacy `SPAM` user label id but `spam_at` null → `isVisibleUserLabel` filters chip → inbox row shows no SPAM badge.

**Undo toast:** mark spam returns `preferences: [{ email, kind: 'block' }]` → toast with Undo → inbox move clears spam, sets allow, removes block.

## Related

- Plan: `docs/superpowers/plans/2026-07-27-spam-mvp-heuristic-overnight.md`
- Handoff: `docs/superpowers/plans/handoff-reports/2026-07-27-spam-mvp-overnight.md`
- Placement plan: `docs/plans/2026-07-27-001-feat-spam-mvp-placement-and-persistence-plan.md`
- Related solutions: `docs/solutions/architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md` (triage/`spamAt` gates; refresh candidate), `docs/solutions/architecture-patterns/live-pilot-production-parity-real-mail.md` (inbox-first ingest), `docs/solutions/architecture-patterns/nava-fixture-loopback-e2e-harness.md` (stale direct-To→spam E2E row), `docs/solutions/ui-bugs/hotel-folder-ui-parity.md` (chip honesty), `docs/solutions/integration-issues/fe-pilot-trpc-wire-contract-drift.md` (`spam` folder slug), `docs/solutions/ui-bugs/email-html-images-cid-rewrite-and-trusted-sender-domains.md` (never-spam domains also seed Image trust)
- Key files: `never-spam.ts`, `triage.ts` (`refineTriageOutput`, `applyDurableTriageResult`), `trpc/routes/mail.ts`, `sender-preference.ts`, `use-labels.ts`, `spam-undo-toast.ts`
- Tests: `never-spam.test.ts`, `ai-triage-contract.test.ts`, `mail-empty-spam.test.ts`, `sender-preference.test.ts`, `use-labels-spam-filter.test.ts`
