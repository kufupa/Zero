No `-o` path was supplied and the sandbox is read-only, so this is inline. No tests, HMS, or prod were touched. LOC is `+/-` product lines per [L5:35](/tmp/shape1025/L5.md:35); estimates are `[U]`, capped at 200. Treat S0 as serial child slices: the source files are 2,370 and 2,596 lines [speed:45](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-26-dev-speed-analysis.md:45).

Generic gate: use the active property config [panel:1854](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1854); ship Outlook and webmail [PRODUCT:11](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/PRODUCT.md:11). Canaries below are `[U]` proposals; real writes stay off, Labtest only [PRODUCT:48](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/PRODUCT.md:48).

| S0-P1 · Field | Value |
|---|---|
| Missing / needs / steps | Agency/company picker is inline [panel:494](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:494); lift its field renderer into `quote-people-step.tsx`, behavior unchanged. |
| Depends / files / LOC / test | —; panel, new `quote-people-step.tsx`, new `quote-people-step.test.tsx`; [U] 140–180; test one Agency HMS pick patches the selected profile. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · same Agency pick in both shells · [U] unrun; callback loss → restore inline; mechanical only; luna. |

| S0-P2 · Field | Value |
|---|---|
| Missing / needs / steps | Step 1 wrapper remains inline [panel:1800](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1800); move it into `quote-people-step.tsx`, leave panel as host. |
| Depends / files / LOC / test | S0-P1; panel, `quote-people-step.tsx`, `quote-people-step.test.tsx`; [U] 110–160; test Agency section and Continue action render. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · same step order · [U] unrun; prop/order regression → restore wrapper; no hotel defaults; luna. |

| S0-S1 · Field | Value |
|---|---|
| Missing / needs / steps | Extra error and base charge-row helpers stay inline [panel:570](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:570); lift to `stay-extras-fields.tsx`. |
| Depends / files / LOC / test | S0-P2; panel, new `stay-extras-fields.tsx`, `quote-workflow-panel.test.tsx`; [U] 130–180; test one extra patch targets its stay [test:1257](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/quote-workflow-panel.test.tsx:1257). |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · extras unchanged · [U] unrun; lost field error → keep helper inline; no hotel-specific branch; luna. |

| S0-S2 · Field | Value |
|---|---|
| Missing / needs / steps | Shuttle/lunch conditional controls are inline [panel:629](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:629); lift to `stay-extras-fields.tsx`. |
| Depends / files / LOC / test | S0-S1; panel, `stay-extras-fields.tsx`, `quote-workflow-panel.test.tsx`; [U] 60–100; test enabling Shuttle reveals Trips. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · Trips stays per stay · [U] unrun; wrong toggle scope → restore branch; no property strings; luna. |

| S0-S3 · Field | Value |
|---|---|
| Missing / needs / steps | Dinner/Other controls are inline [panel:654](/home/ubuntu/projects/zero/ds) [panel:654](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:654); lift as one helper. |
| Depends / files / LOC / test | S0-S2; panel, `stay-extras-fields.tsx`, `quote-workflow-panel.test.tsx`; [U] 170–195; test Dinner unit remains selected. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · Dinner/Other values unchanged · [U] unrun; lost required-dinner state → keep branch inline; no board/property assumptions; luna. |

| S0-S4 · Field | Value |
|---|---|
| Missing / needs / steps | Remaining extras state/wrapper is inline [panel:586](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:586); finish `StayExtrasFields` and caller move. |
| Depends / files / LOC / test | S0-S3; panel, `stay-extras-fields.tsx`, `quote-workflow-panel.test.tsx`; [U] 120–180; test extras patch only the addressed stay [test:1257](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/quote-workflow-panel.test.tsx:1257). |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · extras still per stay · [U] unrun; stale keys → keep wrapper in panel; do not change behavior; luna. |

| S0-S5 · Field | Value |
|---|---|
| Missing / needs / steps | Stay map/card is inline [panel:1837](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1837); move to `quote-stay-step.tsx`, leave extras position unchanged. |
| Depends / files / LOC / test | S0-S4; panel, new `quote-stay-step.tsx`, `quote-workflow-panel.test.tsx`; [U] 130–190; test second stay patches only its extras [test:1281](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/quote-workflow-panel.test.tsx:1281). |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · same Stay rows/dates · [U] unrun; missed props → restore section; D then owns this file; luna. |

| S0-Docs · Field | Value |
|---|---|
| Missing / needs / steps | Documents card is inline [panel:2300](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:2300); move to `quote-documents-step.tsx`. Notes step 2 and rates step 4 go directly to E/DS4-G, not throwaway files [shape:23](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/plans/2026-10-26-001-overnight-run2-shape.md:23). |
| Depends / files / LOC / test | S0-S5; panel, new `quote-documents-step.tsx`, new `quote-documents-step.test.tsx`; [U] 80–140; test Prepare PDF stays disabled before rates. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · same Documents gate · [U] unrun; lost reply content → restore section; do not split Steps 2/4 ahead of their moves; luna. |

| S0-Auto1 · Field | Value |
|---|---|
| Missing / needs / steps | Auto-start body is inside NAVA pane [nava:1902](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:1902); lift candidate logic to `use-staff-quote-autostart.ts`, unchanged. |
| Depends / files / LOC / test | —; `nava-pane.tsx`, new `use-staff-quote-autostart.ts`, `nava-pane-render.test.tsx`; [U] 140–190; test one valid stay starts once. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · current auto-start unchanged · [U] unrun; missed closure → keep body in pane; no debounce in split; luna. |

| S0-Auto2 · Field | Value |
|---|---|
| Missing / needs / steps | Trigger effect is inline [nava:1316](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:1316); move effect/dependencies to the hook. |
| Depends / files / LOC / test | S0-Auto1; `nava-pane.tsx`, `use-staff-quote-autostart.ts`, `nava-pane-render.test.tsx`; [U] 40–80; test current complete-pair start. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · same trigger behavior · [U] unrun; dependency drift → retain pane effect; A owns debounce after this; luna. |

| A · Field | Value |
|---|---|
| Missing / needs / steps | Incomplete-date block already exists [session:393](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/session.ts:393) and auto-start calls it [nava:1937](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:1937); debounce is missing [nava:1316](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:1316). Add brief trailing debounce (250 ms `[U]`), cancel on partial dates/change. |
| Depends / files / LOC / test | S0-Auto2; `use-staff-quote-autostart.ts`, `nava-pane-render.test.tsx`; [U] 60–130; test check-in alone queues 0 rate lookups; complete pair queues exactly 1. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · 0 reads after check-in, 1 after full pair · [U] unrun; delay feels slow → retain date gate, disable debounce; don’t duplicate gate or edit calendar clearing [dates:133](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/stay-date-range.tsx:133); luna. |

| C · Field | Value |
|---|---|
| Missing / needs / steps | Garbled “Still working” lacks separator [status:89](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/hms-queue-status.tsx:89); party picker may render lookup and job status surfaces together [party:964](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/party-picker.tsx:964). Select one readable line per active job. |
| Depends / files / LOC / test | —; `hms-queue-status.tsx`, `party-picker.tsx`, new `party-picker-status.test.tsx`; [U] 80–150; test overlapping party lookup emits one `role=status`. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · one readable line per job · [U] unrun; hidden failure state → keep queue/retry labels; retain aggregate count chip [chip:473](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/hms-job-notices.tsx:473), not “one status total”; luna. |

| D · Field | Value |
|---|---|
| Missing / needs / steps | Extras are a sibling after StayCard [panel:1865](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1865), outside its `<article>` [card:182](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/requirement-card.tsx:182); place them inside and rename label; event already `duplicate_stay` [card:213](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/requirement-card.tsx:213). |
| Depends / files / LOC / test | S0-S5; `quote-stay-step.tsx`, `requirement-card.tsx`, `quote-workflow-panel.test.tsx`; [U] 50–110; test extras descend from Stay article and button reads “Duplicate stay” (old containment only checked parent [test:1274](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/quote-workflow-panel.test.tsx:1274)). |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · extras/actions visibly inside Stay border · [U] unrun; clipping → adjust inner overflow, not move extras out; preserve duplicate event; DS4 waits; luna. |

| E1 · Field | Value |
|---|---|
| Missing / needs / steps | Current note builder maps room/rate [panel:1141](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1141), but formatter input has no extras [notes:203](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/rate-controls.tsx:203); extend shared formatter from final stay/rate/extras. |
| Depends / files / LOC / test | DS4-G1 data shape; `rate-controls.tsx`, new `reservation-note.ts`, new `reservation-note.test.ts`; [U] 80–160; test one final room/rate/extras selection appears in note. |
| Canary / risk+fallback / pushback / coder | HRDAV Labtest preview-only · pass note includes final values · [U] unrun; stale/missing extras → keep manual note path; generic formatter, no hotel branches; grok. |

| E2 · Field | Value |
|---|---|
| Missing / needs / steps | Book already has editable Reservation Note [booking:997](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:997); HRDAV marks it required [hrdav:77](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-25-hrdav-dom-read.md:77). Bind E1’s final note there; remove Step 2. |
| Depends / files / LOC / test | E1, P2b, DS4-G2b; `booking-card.tsx`, `quote-workflow-panel.tsx`, `reservation-note.ts`, `booking-card.test.tsx`; [U] 100–190; test generated note prefills Book field and remains editable. |
| Canary / risk+fallback / pushback / coder | HRDAV Labtest write/readback only · pass saved reservationnote matches final values · [U] unrun; overwrite of staff edit → preserve dirty text / explicit regenerate; keep requiredness config-driven [booking:640](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:640); grok. |

| P1 · Field | Value |
|---|---|
| Missing / needs / steps | Contact is separate from Step 1; it is PDF-labeled [contact:42](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/blocks/contact-block.tsx:42) and sender-fallback is supported [contact:35](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/blocks/contact-block.tsx:35). Put Contact + Agency into People card; remove duplicate pane surface. |
| Depends / files / LOC / test | S0-P2, S0-Auto2, S0-Docs; `nava-pane.tsx`, `quote-workflow-panel.tsx`, `quote-people-step.tsx`, new `quote-people-step.test.tsx`; [U] 90–170; test Contact edit remains request-scoped. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · Contact still PDF-only, Agency still HMS profile · [U] unrun; identity leakage → keep current surfaces; Product keeps Company separate from Agency [PRODUCT:38](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/PRODUCT.md:38), but 3-row spec omits Company `[U]`; luna. |

| P2a · Field | Value |
|---|---|
| Missing / needs / steps | Booking uses sender/booker and parsed guest names are available [types:192](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/types.ts:192). Add Guest row: direct = Contact; agent/different guest = parsed name or “Guest name?”. |
| Depends / files / LOC / test | P1; `quote-people-step.tsx`, `quote-people-step.test.tsx`; [U] 70–140; test agent sender is not substituted when guest is missing. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only · parsed guest or prompt, never agent sender · [U] unrun; bad classification → explicit prompt; don’t infer from email sender alone; luna. |

| P2b · Field | Value |
|---|---|
| Missing / needs / steps | Book first/last fields still seed from request [booking:702](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:702), separate from Contact/booker [booking:626](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:626). Feed chosen Guest into Book fields. |
| Depends / files / LOC / test | P2a; `quote-people-step.tsx`, `booking-card.tsx`, `booking-card.test.tsx`; [U] 60–130; test Guest prefills editable first/last. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only preview · pass correct staying guest, distinct from contact · [U] unrun; ambiguous name split → keep fields editable and ask; Book mapping is Grok-owned; grok. |

| R · Field | Value |
|---|---|
| Missing / needs / steps | “Showing rates for” filters HMS options [panel:793](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:793); room rate code is separate [panel:2148](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:2148). Add `Other rate…` at bottom of actual room selector, pencil edits typed code; keep Authorised by [controls:449](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/rate-controls.tsx:449). |
| Depends / files / LOC / test | —; new `stay-rate-choice.tsx`, new `stay-rate-choice.test.tsx`; [U] 80–160; test Other rate selection then pencil edit retains custom code. |
| Canary / risk+fallback / pushback / coder | HRCEN+HRDAV+next · read-only HMS lookup · typed code stays selected and authorization remains · [U] unrun; no match → retain manual code; do not put custom code in filter or override control; grok. |

DAG: `S0-P1→P2→S0-S1→S2→S3→S4→S5→S0-Docs`; `S0-Auto1→Auto2→A`; `S0-S5→D→DS4-F2→G1→G2a→G2b`; `P1→P2a→P2b`; `P1→G2b`; `R→G2a`; `G2b+E1+P2b→E2`; C independent. DS4 ownership: F1 server-only files (`hms-jobs.ts`, `hms-availability.ts`, `routes/rates.ts`), F2 owns Stay-step bind; G1 owns `session.ts`, G2a new `stay-rate-grid.tsx`, G2b owns panel/Stay integration. Original F/G estimates exceed cap [L5:44](/tmp/shape1025/L5.md:44); keep shared files sequential: D→F2→G2b, P1→G2b, G2b→E2.

T0: S0-P1, S0-Auto1, C, R, DS4-F1. Longest chain `[U]`: panel S0 chain → P1 → P2a → P2b → E2 (about 12 slices; DS4-G2b gates E2).