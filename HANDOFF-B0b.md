# HANDOFF-B0b — pane edits + rates survive email switch

**Lane:** B0b. **Branch:** `feat/g-B0b-10160027`. **Time:** 2026-10-16 step 0.

**Owner report:** change fields → other email → back → looks reset every time.

**Prod pane not driven this step.** Diagnosis is from origin/main code (this worktree). Live proof after merge: screenshots + `ai_workflow_run` ids under `runs/proof/B0b/`.

---

## 1. What actually resets

The brief’s `nava-pane.tsx:507-512` `{type:'reset'}` is **mailbox/session scope**, not an email click.

Email switch is `dispatchQuote({ type: 'selection', binding })` at [nava-pane.tsx:530-542](apps/mail/components/nava-pane/nava-pane.tsx). Reducer:

```
admissionKey(binding) = digest|selectionEpoch|scopeEpoch
if key changed → initialQuoteSession() + new binding
```

[session.ts:1211-1220](apps/mail/lib/quote-workflow/session.ts). A→B→A wipes `groups`, `staffQuotes`, `runningStepId`.

Then analysis re-runs from stored read or live analyse ([nava-pane.tsx:629-672](apps/mail/components/nava-pane/nava-pane.tsx)).

---

## 2. The four failures (owner flow: quote mail, edit, Get rates, two other mails, back)

| # | Failure | Verdict | Why |
|---|---|---|---|
| 1 | **Edit lost** | **Broken** | Local groups die on `selection`. `recordGroups` no-ops without a stored work item ([use-work-item.ts:432-434](apps/mail/lib/quote-workflow/use-work-item.ts)). Stored read *does* overlay `work_item.state` ([work-items.ts:247, 353-375](apps/server-pilot/src/ai/work-items.ts)). Live analyse (common on first open) has nothing to overlay. Even stored: switch before the save lands loses the edit. |
| 2 | **Rates not re-attached** | **Broken on quote intent after manual Get rates** | Read-back effect is `create_booking` only ([nava-pane.tsx:781](apps/mail/components/nava-pane/nava-pane.tsx)). Manual Get rates calls `suppressAutoStaffQuoteForCurrentEmail()` → sessionStorage. Come-back: auto-start returns early. Quote mail never asks the server. Booking mails remount-restore via `bindReadBackStaffQuote` + input key. |
| 3 | **Duplicate run queued** | **Conditional** | Manual Get rates: auto-start suppressed → **no** second queue. Remount / unpinned Outlook: `staffQuoteAutoAttempted` empty, suppression maybe missing. Auto-start rebuilds from **unedited** analysis. `latestStaffQuoteRunFor` user path requires `hmsRequestKey` match (epochs stripped, occupancy **not**). Edited adults ≠ original → new `staff_quote`. |
| 4 | **Auto-start suppressed** | **By design, after Get rates** | sessionStorage `nava.staff-quote-auto-suppressed:<internetMessageId>` ([nava-pane.tsx:209-222, 604-608, 1426-1437](apps/mail/components/nava-pane/nava-pane.tsx)). Stops duplicate auto-start. Also stops reattach for quote intent. |

`staffQuoteAutoAttempted` (`useRef` Set, key = transport+messageId+sourceHash+stayKey) survives a switch **only while the pane stays mounted**. Unpinned Outlook remount forgets it.

Server lookup `latestStaffQuoteRunFor` ([hms-jobs.ts:3015-3105](apps/server-pilot/src/ai/hms-jobs.ts)): newest **user** run returned only if `hmsRequestKey` equals the rebuilt input. Price-equivalent match is for **prepared prefetch** only.

---

## 3. Causal chain (owner click path)

1. Quote mail open → live analyse or stored read → groups on screen.
2. Edit adults → React state only (no work item) **or** scheduled `recordFieldEvent` (stored).
3. **Get rates** → `queueStaffQuote` (one `staff_quote`) + `suppressAutoStaffQuoteForCurrentEmail`.
4. Click other mail → `selection` → `initialQuoteSession()`.
5. Click back → analysis from extraction again → adults original → no quote read-back → auto-start suppressed.
6. Screen looks reset. Run still in DB. Second Get rates would enqueue another job (manual path always `randomUUID` idempotency, [workstation.ts:860-862](apps/server-pilot/src/trpc/routes/workstation.ts)).

---

## 4. Build (only these)

1. **Edits:** module-level Map `transportId + internetMessageId` + sessionStorage. Save on stay edit. Re-apply after `analysis_ready`.
2. **Rates:** on open, `staffQuoteJob` by **messageId** (any state, this user). Show progress or finished rates. Skip auto-start when a run exists. Do not require client `staffQuoteAutoAttempted` or price-equivalent input.
3. **Toast:** poll this user’s in-flight `staff_quote`s. Success on a **other** message → one `Rates ready · <subject>` toast. Click opens that thread (`onOpenThread`) on webmail.
4. **UI:** calm progress + rates. No “cached” / “reattached” copy.

Keep `latestStaffQuoteRunFor` input-keyed path for auto-start **reuse** (same occupancy). New messageId path is attach-any.

**Out of scope:** stored-read overlay (already works when save landed). HMS job banner (already “Rates ready” while observer lives). Deploy.

---

## 5. Files

Allowed: `nava-pane.tsx`, `quote-workflow/`, `quote-workflow-panel.tsx`, `hms-jobs.ts`, `workstation.ts`, `work-items.ts`. Max 250 prod lines.

Tests first: `pane-edits`, session restore, `staffQuoteJob({ messageId })`, nava-pane switch-back (edit + no second queue + toast).

Typecheck: `bash /home/orca/bin/remote-typecheck.sh <wt> --app mail --baseline` and `--app server-pilot`.

---

## 6. Status

- [x] Step 0 written
- [ ] TDD + impl
- [ ] Focused vitest + remote typecheck
- [ ] PR + @greptileai ≤2 rounds
- [ ] `LANE_DONE PR=<n>`
