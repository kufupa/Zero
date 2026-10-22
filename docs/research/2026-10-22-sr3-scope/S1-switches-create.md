> 🧠 **From Hindsight memory (U8 unpaid amend in place)** — U8 kept amend Labtest-only; current code still requires `RESERVATIONIST_PANE_SAVE=lab` for that writer ([pane-hms-write.ts](apps/server-pilot/src/ai/pane-hms-write.ts:87)).

**Verdict (95):** Ready to scope, not to enable real-guest create. Static read only: worktree `HEAD=origin/main=db4abaca4`; live `b11e5ac52` is the supplied/recorded revision, not rechecked. No files changed; no tests, tsc, Vitest, prod, or HMS touched. CodeGraph’s main-checkout index may lag; evidence below is from this worktree.

### 1. Current state

| Area | Evidence |
|---|---|
| Recorded flags | `ACTIVE.md` records `SAVE=lab` on `http`, `worker`, `ai-worker`, unset on `remote-http`; dated state, not a live check ([ACTIVE.md](docs/context/ACTIVE.md:7)). |
| Shared gate | One `SAVE` parser gates create; cancel also uses it and `on` passes `--allow-real-guest`; amend’s shared writer only accepts `lab` ([pane-stay-save.ts](apps/server-pilot/src/ai/pane-stay-save.ts:134), [pane-stay-cancel.ts](apps/server-pilot/src/ai/pane-stay-cancel.ts:246), [amend-stay-rules.mjs](apps/server-pilot/tooling/playwright-quote/amend-stay-rules.mjs:15)). |
| Create guards | Server refuses children; HRCEN is fixed; commit checks duplicates under one property lock ([pane-stay-save.ts](apps/server-pilot/src/ai/pane-stay-save.ts:24), [guard](apps/server-pilot/src/ai/pane-stay-save.ts:165), [commit](apps/server-pilot/src/ai/pane-stay-save.ts:371)). |
| Duplicate rule | Current reader blocks a non-cancelled same-surname/date row; missing departure also blocks. It does not compare first name ([pane-stay-lookup.ts](apps/server-pilot/src/ai/pane-stay-lookup.ts:530)). |
| Save proof gap | Pane launches `--pane-commit`, not `--proof`; only proof mode snapshots existing rows and reconciles after save. Ordinary pane commit returns `committed` after HMS confirmation, without independent readback ([pane-stay-save.ts](apps/server-pilot/src/ai/pane-stay-save.ts:281), [create-lab-stay.mjs](apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:611), [readback](apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:659)). Saved screenshot link appears after “booked”; review is optional ([booking-card.tsx](apps/mail/components/quote-workflow/booking-card.tsx:353)). |
| Capabilities/UI | API and mail expose one `paneSave`/`paneSaveMode`; it gates create, CHECK cancel/amend, and generic booking writes. Room cards save individually ([brain.ts](apps/server-pilot/src/trpc/routes/brain.ts:25), [driver types](apps/server-pilot/src/lib/driver/types.ts:170), [nava-pane.tsx](apps/mail/components/nava-pane/nava-pane.tsx:323), [booking-card.tsx](apps/mail/components/quote-workflow/booking-card.tsx:683)). |
| Property / multi-room | HRCEN-only create; explicit HRDAV is refused. But runner checks the secret’s HRCEN property only in proof mode. Da Vinci writes are not built ([property guard](apps/server-pilot/src/ai/pane-stay-save.ts:327), [runner check](apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:524), [readiness](docs/research/2026-10-22-client-readiness.md:32)). Owner’s same-date/different-room rule says one booking; current UI sends one stay per room ([OWNER-ASKS.md](docs/context/OWNER-ASKS.md:309)). |
| Labtest/data | Field note is actually `docs/infor-hms/labtest-booking-state-fields.md`, not under research: values pending; `send_on_save` unknown. Last create-prefill snapshot: 26 messages / 23 threads, selected 10; strict confirmation-linked truth `n=0` ([field note](docs/infor-hms/labtest-booking-state-fields.md:7), [backtest](docs/research/2026-10-20-booking-prefill-backtest.md:8), [truth count](docs/research/2026-10-20-booking-prefill-backtest.md:31)). |
| Excluded PRs | Treat #458, #460, #461, #462, #451 as landing soon; don’t re-plan. #451 is outbound-gold, not create truth. |

### 2. Gaps to fully built

1. Add `RESERVATIONIST_PANE_CREATE`, `_AMEND`, `_CANCEL`, each `off|lab|on`. Recommend legacy `SAVE` fallback only when all three are unset; once any is set, missing/invalid siblings mean `off`. Target config: create `on`, amend/cancel `lab`, explicitly on every process.
2. Expose per-flow modes in capabilities and UI. Keep legacy fields as compatibility aliases; never let create mode enable CHECK cancel/amend or generic attach. Keep attach Labtest-only unless separately scoped.
3. Real-create preflight: enforce HRCEN in the runner on every write; keep child refusal; require adults ≥1 (current validators allow 0); duplicate check must fail closed on ambiguity. Rename generic `create-lab-stay.mjs` honestly; keep `create-proof-rules.mjs` Labtest-only.
4. Every pane save needs pre-save snapshot, post-save independent readback of the intended active stay, exact supported-field comparison, and screenshot review before success. Fill R5: guarantee type, `send_on_save`, observed field record. No Nava mail send; prove any HMS-side email effect.
5. Current preview grant is one-use/in-memory and the UI disables while visibly busy, but an unknown save can be previewed and retried. Add durable retry/idempotency handling; don’t retry unknown outcomes blindly.
6. Same-date multi-room must become one HMS booking per owner decision. Current per-room commits can create partial/separate records; block grouped real create until the HMS multi-room contract is proven.

### 3. PR split and estimates

| PR / files touched | Product LOC; test LOC/files | Dependency, collision, P1 risk |
|---|---|---|
| **1. Flow gates + capability/env contract.** `apps/server-pilot/src/ai/{pane-stay-save.ts,pane-stay-cancel.ts,pane-hms-write.ts,pane-stay-spawn-env.ts}`; `src/trpc/routes/brain.ts`; `src/lib/driver/types.ts`; `tooling/playwright-quote/{amend-stay-rules.mjs,create-proof-rules.mjs}`; `apps/mail/lib/{pilot/capabilities.ts,quote-workflow/pane-stay-bind.ts,quote-workflow/amend-cancel.ts}`; `apps/mail/components/{nava-pane/nava-pane.tsx,nava-pane/blocks/booking-voucher-card.tsx,quote-workflow/booking-card.tsx,quote-workflow/amend-lookup-panel.tsx}`; `deploy/{pm2.config.cjs,write-ec2-env.sh,write-ec2-remote-env.sh}`; `PRODUCT.md`. | **+220–300 / −60–90**; tests **+160–240**: `pane-stay-save.test.ts`, `pane-stay-cancel.test.ts`, `pane-hms-write.test.ts`, `pane-stay-amend.test.ts`, `pane-stay-spawn-env.test.ts`, `deploy-config.test.ts`, `misc-wire-contract.test.ts`, `amend-stay-rules.test.mjs`, `pilot-capabilities.test.ts`, `booking-card.test.tsx`, `amend-find-panel.test.tsx`. | No dependency. Collides create/cancel/amend, attach, overlay/CHECK, DV read env. P1: legacy precedence, remote-http omission, capability leakage; rebase after #458/#460. |
| **2. Single-room preflight.** `pane-stay-save.ts`, `pane-stay-lookup.ts`, `create-lab-stay.mjs`→`create-stay.mjs`, `create-request.mjs`, `create-proof-rules.mjs`; update references in `scripts/luna-booking-proof.ts`, `tooling/playwright-quote/{lab-proof.sh,cancel-stay-rules.mjs,session-reuse.test.mjs}`, `tests/{create-lab-stay-track.test.ts,read-reservation-fields.test.ts}`. | **+90–150 / −20–45**; tests **+90–140**: `pane-stay-save.test.ts`, `pane-stay-lookup.test.ts`, `create-lab-stay.test.mjs`→`create-stay.test.mjs`, `create-proof-rules.test.mjs`. | Depends PR1. Collides create and HRCEN/DV boundary. P1: wrong property, zero adults, duplicate miss. |
| **3. Verified save + screenshot review.** `create-stay.mjs`, `create-proof-rules.mjs`, `read-reservation-fields.mjs`, `pane-stay-save.ts`, `pane-stay-bind.ts`, `apps/mail/components/quote-workflow/booking-card.tsx`. | **+130–220 / −30–55**; tests **+120–180**: `create-stay.test.mjs`, `create-proof-rules.test.mjs`, `read-reservation-fields.test.mjs`, `pane-stay-save.test.ts`, `apps/mail/tests/booking-card.test.tsx`. | Depends PR2 and completed Labtest field record. P1: false success, mismatched fields, unknown HMS side effect. |
| **Hold: retry/idempotency.** Known seam: `pane-stay-save.ts`; durable store/migration location unknown until design. | **LOC unknown**; test LOC/files unknown until storage choice. | Depends PR2–3. P1 duplicate on uncertain retry/process restart; size before coding, split to ≤500. |
| **Hold: grouped multi-room.** `booking-card.tsx`, `pane-stay-bind.ts`, `quote-workflow-panel.tsx`, `pane-stay-save.ts`, `create-request.mjs`, `create-stay.mjs`. | **LOC unknown**; `booking-card.test.tsx`, `quote-workflow-multi-stay.test.ts`, server/create tests need extension. | Depends PR2–3 and retry policy. No room-group HMS write contract in current evidence; size after Labtest-only probe, then split ≤500. |

### 4. Test and live/replay plan

| Check | Scenario / proof |
|---|---|
| `pane-stay-save.test.ts` | Legacy fallback; malformed values fail closed; create `on` does not turn amend/cancel on; children, adults=0, property mismatch, duplicate, lock, one-use grant. |
| `pane-stay-cancel.test.ts` + `cancel-stay-rules.test.mjs` | `CANCEL=lab` never passes `--allow-real-guest`; penalty dialog always refuses. |
| `pane-hms-write.test.ts`, `pane-stay-amend.test.ts`, `amend-stay-rules.test.mjs` | Create switch cannot enable generic attach/amend; amend remains lab; paid/unknown payment follows #458 once landed. |
| `pane-stay-spawn-env.test.ts` + `deploy-config.test.ts` | Forward all workflow flags to HRCEN CLI; strip write flags for HRDAV; verify env writer, remote allowlist, PM2 config for `http`, `worker`, `ai-worker`, `remote-http`. |
| `create-proof-rules.test.mjs`, `create-stay.test.mjs`, `read-reservation-fields.test.mjs` | Wrong property/duplicate/missing readback/field mismatch never reports success; prove recorded fields and screenshot path. |
| `booking-card.test.tsx`, `amend-find-panel.test.tsx`, `pilot-capabilities.test.ts`, `quote-workflow-multi-stay.test.ts` | Create-only UI gate; CHECK split; visible/reviewable saved screenshot; unknown result cannot be reported booked; grouped rooms stay one booking. |
| Read-only replay, current data | Refresh Centurion `new_booking` source via read-only SQL; replay production-parity body+attachments (`readQuoteAttachments` + `selectionToAgentPrompt`); count distinct thread IDs, not messages. Last snapshot n=23 threads but strict truth n=0, so no accuracy claim; ≥100 independent truth IDs needed for a rate. |
| Read-only HMS + Labtest write | DOM-verify one read-only HRCEN Guest Stay probe; count distinct confirmation IDs for duplicate controls. Any write: isolated HRCEN `Proof Labtest` only, n=1 behavior check; save/read back fields, inspect screenshot, mailbox-watch `send_on_save`. Also verify all four `/proc/<pid>/environ` values match capability response. Not authorized/run here. |

### 5. Open questions

| Question | Recommended default |
|---|---|
| Legacy `SAVE` compatibility? | Fallback only when all three new flags are absent; explicit siblings win, unset/invalid siblings off. |
| Generic HMS attach gate? | Keep separate, Labtest-only; never derive it from create. |
| Should `AMEND=on` be live-capable in this slice? | No; current target is amend lab, and payment/field proof is incomplete. Fail closed until separately approved. |
| Does HMS auto-email on Save fit “Nava never sends mail”? | Nava never sends; first prove HMS `send_on_save` effect with Labtest and disclose it before real create. |