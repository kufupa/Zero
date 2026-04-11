# Handoff note
- Tasks 1–6 are implemented in plan `frontend-demo-backend-decoupling_94bd12d0`.
- Task 7 adds only verification and doc updates for Task 7 scope.

# 2026-04-11 Upgraded Model Backend Review

Reviewed file:
- `docs/superpowers/2026-04-11-hotel-demo-backend-slowdown-audit.md`

Scope:
- `apps/mail` frontend-only demo behavior
- Demo mode assumptions: `ZERO_DEMO_MODE=1` and `VITE_FRONTEND_ONLY=1`

Method:
- Parallel review across 3 independent domains:
  1) backend-claim precision
  2) slowdown-claim precision
  3) false positives + omissions
- Then direct code spot-checks in disputed files.

---

## Executive verdict

- The prior audit is **directionally correct** (backend is still reachable in multiple places).
- It is **not 100% precise**:
  - some entries were overclaimed as active blockers but are latent/gated.
  - several important backend-reachable paths were omitted.
- Slowdown section is mostly **plausible scaling risk**, not “currently severe” in the present small demo corpus.

Practical grading:
- **Core thesis correctness:** High
- **Line-by-line precision:** Medium
- **Ready-to-implement as-is without correction:** No

---

## 1) Backend claim verification matrix

Legend:
- **CONFIRMED** = statically backend-reachable in demo mode.
- **CONDITIONAL** = reachable only after specific user action/route flow.
- **INCORRECT/OVERSTATED** = currently gated, latent, or not mounted in active tree.

### A) Claims from prior audit (re-scored)

| Prior claim | Verdict | Notes |
|---|---|---|
| `create-email.tsx` `trpc.mail.send` | CONDITIONAL | Unguarded mutation, executed on send action. |
| `reply-composer.tsx` `trpc.mail.send` | CONDITIONAL | Unguarded, action-triggered. |
| `email-composer.tsx` (`trpc.ai.compose`, `trpc.drafts.create`, `trpc.ai.generateEmailSubject`) | CONDITIONAL | Unguarded handlers/autosave path. |
| `thread-context.tsx` (`trpc.mail.delete`, `trpc.labels.create`) | CONDITIONAL | Unguarded context actions. |
| `note-panel.tsx` notes CRUD/reorder | CONDITIONAL | Unguarded, user-driven. |
| `command-palette-context.tsx` `trpc.ai.generateSearchQuery` | CONDITIONAL | Unguarded mutation path. |
| `recipient-autosuggest.tsx` `trpc.mail.suggestRecipients` | CONDITIONAL | Query enabled by debounced input; no demo guard. |
| `nav-user.tsx` `trpc.mail.forceSync` | CONDITIONAL | Still callable by action path. |
| `settings/general` and `settings/appearance` `trpc.settings.save` | CONDITIONAL | Direct submit mutation in route file. |
| `use-templates.ts` `trpc.templates.list` | CONDITIONAL | No demo fallback branch. |
| `use-notes.tsx` `trpc.notes.list` | CONDITIONAL | Enabled by connection/thread, no demo guard. |
| `use-drafts.ts` `trpc.drafts.get` | CONDITIONAL | Enabled by session+id, no demo guard. |
| `mail-content.tsx` trust sender -> `trpc.settings.save` | CONDITIONAL | Triggered by trust action. |
| `prompts-dialog.tsx` as active blocker | INCORRECT/OVERSTATED | Only used from `ai-sidebar`; not proven mounted in current route tree. |
| `nav-main.tsx` label create as active blocker | INCORRECT/OVERSTATED | UI create path shown for `providerId === 'google'`; demo active connection is `providerId: 'demo'`. |
| `ai-sidebar.tsx` as currently active P0 | INCORRECT/OVERSTATED | Feature appears latent/not mounted in current main route composition. |

### B) Major omissions in prior audit (important)

These should be considered backend-reachable and were missing or underreported:

- `apps/mail/components/mail/mail-display.tsx`
  - `trpc.ai.webSearch` in `MoreAboutPerson` and `MoreAboutQuery`.
- `apps/mail/components/create/template-button.tsx`
  - `trpc.templates.create` and `trpc.templates.delete` (writes, not just template list).
- `apps/mail/components/context/label-sidebar-context.tsx`
  - `trpc.labels.delete`.
- `apps/mail/hooks/driver/use-delete.ts`
  - `trpc.mail.delete` (hotkey/driver path).
- Additional settings route mutations not included in prior P0 list:
  - `settings/privacy`: `trpc.settings.save`
  - `settings/categories`: `trpc.settings.save`
  - `settings/labels`: `trpc.labels.create/update/delete`
  - `settings/connections`: `trpc.connections.delete`
  - `settings/danger-zone`: `trpc.user.delete`

### C) Network/external overclaims corrected

- `bimi-avatar.tsx` is demo-gated (`enabled: ... && !frontendOnlyDemo`) -> not an active demo blocker.
- `login/page.tsx` provider fetch is bypassed in frontend-only demo via early return.
- `lib/server-tool.ts` has backend fetch function, but currently no active caller in mounted flow (voice tooling is commented).

---

## 2) Slowdown claim verification matrix

Legend:
- **CONFIRMED ISSUE** = clear inefficiency/bug with present impact.
- **PLAUSIBLE (DATA-DEPENDENT)** = scales poorly but current demo data likely hides it.
- **WEAK/UNSUPPORTED** = claim too strong given current code/data.

| Prior slowdown claim | Verdict | Notes |
|---|---|---|
| `mail-list.tsx` `memo(..., () => true)` is immediate high-risk slowdown | WEAK/UNSUPPORTED (for perf) | `MailList` takes no props; comparator is mostly redundant rather than a proven active perf bug. |
| `MailLabels` `JSON.stringify` comparator | PLAUSIBLE (DATA-DEPENDENT) | Real O(n) compare cost; likely minor at current label sizes. |
| Startup parse/sort in `demo-data/adapter.ts` | PLAUSIBLE (DATA-DEPENDENT) | Synchronous module work exists; current dataset (12 threads) likely low impact. |
| Attachment decode loops in compose/display | PLAUSIBLE (DATA-DEPENDENT) | Heavy loops exist, but current demo corpus has no attachment-heavy path. |
| Thread attachment aggregation | WEAK/UNSUPPORTED (current demo) | Valid pattern concern, but little present cost with current data shape. |
| Command palette filtering + storage serialization | PLAUSIBLE (DATA-DEPENDENT) | Can scale with larger corpus/history; modest current impact. |
| HTML processing paths | PLAUSIBLE (DATA-DEPENDENT) | Mostly bounded in demo mode; larger bodies could hurt later. |
| `use-threads` flatten/filter | PLAUSIBLE (DATA-DEPENDENT) | Linear recompute; small current dataset. |
| Folder recursion validation | PLAUSIBLE (DATA-DEPENDENT) | Mostly future-scale concern unless folder trees get deep. |
| `hr.tsx` 1-second timer + overlap computation | PLAUSIBLE (LOW) | Continuous rerenders, but not likely a hot user path for mail demo. |

Bottom line on performance:
- The prior audit overstated immediate slowdown severity.
- Current biggest real risk remains **backend side-effects**, not CPU/memory bottlenecks at today’s demo scale.

---

## 3) What is 100% proven vs what needs runtime testing

### 100% statically proven (from code)

- Multiple unguarded backend mutations/queries remain reachable through user actions.
- Several settings routes still perform direct backend mutations.
- Some prior “active blocker” claims are overstated due to gating/non-mounted components.

### Needs runtime verification before final severity ranking

- Whether latent paths (`ai-sidebar` family) are mounted behind feature flags or hidden route entrypoints in real demo navigation.
- Actual UX impact of slowdown candidates under realistic demo load:
  - large thread corpus
  - attachment-heavy messages
  - fast typing in command palette
  - long HTML thread bodies

---

## 4) Final judgment on prior audit quality

- **Not completely wrong.**
- **Not precise enough to treat as authoritative without correction.**
- Best description: **“good directional triage, medium precision, missing key blockers, and a few overclaims.”**

If this doc is used to drive implementation, apply corrections from sections 1B and 1C first.
