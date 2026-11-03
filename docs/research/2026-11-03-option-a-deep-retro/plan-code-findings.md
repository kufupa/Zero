# Bounded adversarial plan/code review

Snapshot: 2026-11-03, cutoff 19:14 UTC. Main under review: dc26b38636cd37b6af90fd6cfbacdb5c7c2d545b. Root checkout was stale/dirty (6bb282a); left untouched. Read-only review: no tests, browser, DB, live HMS, deploy, or flag changes.

## Verdict

Main now has a real connected HRCEN Create path for existing guests, including sequential multi-room, behind the Create gates. This is materially more than exposing the existing deterministic HMS tools: source-bound review/Go, native write admission, recovery, and fresh readback were not one connected path. The U1 size is high but mostly justified by those contracts and the explicit multi-room requirement; the 2,103 added lines are not 2,103 product lines.

Release is not proven. At cutoff the handoff still reported production at 0da451e, no deploy/flag cutover; only U0, U1, and U4 preparation were merged. Do not call flags a Filing/Amend/Cancel route. Best speed correction: release Create through its own exact-head checks and authorized canary; keep absent/unmerged workflow executors and their flags held. Plan 002's single U4 dependency on U1+U2+U3 recreates the queue that already left ready U1 idle.

## Version and size evidence

| Slice | Product diff | Tests | Other |
|---|---:|---:|---:|
| #988 U0, base 0da451e → merge b44f134 | +529/-92 (6 files) | +452/-40 (7) | docs +411/-4; ops +4/-35 |
| #989 U1, branch 22b14c3 → merge 2664b31 | +1,052/-326 (19 files) | +1,051/-50 (15) | 34 files total; +2,103/-376 overall |
| #990 U4 prep, branch e79b9dc → main dc26b38 | +58/-8 (1 file) | +275/-5 (2) | ops +113/-7 |
| Merged U0–U4 prep, 0da451e → dc26b38 | +1,639/-426 | +1,778/-95 | — |

Evidence: PR #988/#989/#990 metadata and immutable diffs; main tree dc26b38. U1's +2,103 is product + tests; not a product-only count and not an ETA proxy.

## Is U1 scope justified?

| Work added | Evidence | Assessment |
|---|---|---|
| Exact source/selection, actor/session, stay and request binding; preview grant and recheck | apps/server-pilot/src/ai/pane-cloud-preview.ts:497–579; apps/mail/lib/workstation/web-pane-bridge.ts:122–159, 227–240; apps/mail/components/mail/mail.tsx:770–776 | Necessary source→pane→Go boundary; code exists, but does not prove deployed prefill. |
| Real-vs-Labtest admission, native identity/guarantee, preimage, Save, recovery/readback | pane-cloud-preview.ts:115–124, 582+; Plan 002 U1 native call-chain table:127–144 | Legit generalization of Labtest-only tools. Not new guest-profile creation; that is U5. |
| Batch serialization, per-room outcome, stop on uncertain write, invalidate later previews | apps/mail/components/quote-workflow/booking-card.tsx:1535–1618 | Product.md:25 explicitly requires multi-room under one Go with partial results. Not arbitrary scope. |
| Safety regression coverage | #989: +1,051/-50 test lines | Large, but tied to new write contracts. No evidence these are dormant helper-only tests. |

The old ~180-line “wire tools” sketch was not a valid size estimate: it priced native tool calls, not the missing connected authority/source/recovery/readback path. Still, U1 is a sizeable vertical slice; no measured line-to-time relationship exists. Do not silently drop multi-room to hit a line target; it is an owner feature.

## Owner-feature coverage at cutoff

| Owner feature | Main/code state | Gap / honest proof state |
|---|---|---|
| Triage + Quote (PRODUCT.md:23–24) | Existing paths retained. Mounted quote stays native fetch-quote.mjs, not the separate modular quote-read path (override:20; systems review:32–38). | No newly proved deployed quote/prefill. Do not label existing Quote route missing; do not claim live parity. |
| Prefill/source (PRODUCT.md:21,40; Plan 002 R1–R2) | mail.tsx passes selected sourceMessageId; bridge rejects unresolved/ambiguous source instead of substituting a different email; Create preview binds source and digest (refs above). | Implementation is not a pane-output or deployed canary receipt. This is a proof gap, not missing source wiring. Per latest owner correction relayed by coordinator: inspect pane output/component evidence; do not load/click around in GUI for speed. Exact original wording was not recovered; do not invent its locator. Plan 002:40 asks to distinguish installed Outlook evidence from a mocked bridge; treat that as evidence provenance, not a mandatory Outlook GUI visit. |
| Create, existing guest (PRODUCT.md:25; Plan 002 R3:44) | #989 merged. Existing native guest, real dates/guarantee, one-Go sequential multi-room; runtime gates include PANE_CLOUD_CREATE_DISPATCH (Plan 002:129–130,203). | Not deployed or canaried at cutoff. New-profile creation is U5, not a Create bug. Keep CMS/send off. |
| Filing (PRODUCT.md:26; Plan 002 U2:151–169) | No real-guest Cloud Filing executor merged by cutoff. | U2 still unmerged. A flag cannot provide source/hash-bound upload, Go route, or Documents readback. No PDF byte-redownload project needed; approved metadata/hash limit is already stated in Plan 002:165. |
| Amend (PRODUCT.md:27; Plan 002 R5/U3:46,171–189) | #987 / U3 work not on main at cutoff. Native retain observations are not merged workflow proof. | U3 covers multi-night date + adult changes with retained-rate proof; child/other occupancy, room/rate shopping, and non-retain price are not proven here (U6 holds room/rate shop). Keep unsupported cases manual. |
| Cancel (PRODUCT.md:28; Plan 002 R6:47,56) | No U2 executor merged. Plan 002 records later owner scope for unpaid Cancel, superseding the product default only within that authority. | Handoff says NGI-only; deposit=0 does not prove no payment/folio charges (19:05 handoff:27–29). Do not flip a flag without connected route and bounded fresh unpaid proof. |
| New profile / room-rate shop / custom rates | U5/U6 and PRODUCT.md:30 explicitly defer them. | Correctly outside first Create release; do not count as first-deploy regressions. |

## U0 lock and release-plan risks

U0 is real safety work, not ceremony only: target-scoped claims plus alias/legacy-history handling avoid one uncertain stay holding all HRCEN while retaining old holds. But apps/server-pilot/src/ai/hms-labtest-dispatch.ts:202–204 reads all dispatch history; :189–199 computes transitive alias closure; :262–270 repeats it per entry. This is potentially quadratic over append-only history. Pilot blocker only if volume/latency evidence says so; measure before adding an index/compaction design. Same file :347–356 warns old writers/direct SQL bypass this helper: cutover must inventory/hold alternate writers. Do not infer universal lock coverage from U0.

U4 preparation (#990) adds env writer/parser/hold support; it did not perform flag cutover. Plan 002:193–211 couples launch to all U1/U2/U3. Handoff 19:10: U0 plan/actual 20/34m; U1 ready after 95m then idle 89m before merge; U2 45m target/226m+; U3 65m/258m+; U4 not started (lines 36–47). This is direct evidence release coupling delayed Create. Keep independent safety checks; decouple release boundaries instead.

Deploy-path correction: Plan 002:209 and PRODUCT.md:52 name .worktrees/recover-parse-failure, but main ops-deploy.sh:49–75 accepts any clean checkout whose deploy script/cwd share a worktree and whose HEAD matches origin/main; no fixed directory check. Treat the named path as stale documentation, not a reason to repair/touch that worktree. Exact clean-main/bundle checks still apply.

## Prior report and ETA correction

The earlier adversarial report (docs/research/2026-11-03-plan-001-adversarial-review.md:17–33, 50–63, 85–90) used 76.3% dormant / 64 “working” tools / ~705 product LOC and 3.5–4.5h high-confidence framing; its dormant counts conflict internally. Tool-level availability did not establish connected source→Go→write→readback coverage. The systems review corrected this: no comparable complete Create/Filing/full-Amend cycle, and PR lifetime/LOC cannot supply whole-pilot ETA (docs/research/2026-11-03-plan001-adversarial-systems-review.md:14–16, 224–263).

Plan 002's 120–165m is explicitly an uncalibrated owner target (lines 62–78), now missed. Handoff's P50 75–90m / P90 2.5–3h (19:10 handoff:72–74) is not statistical evidence: three small PR merge durations plus estimated deploy/canary cannot estimate remaining connected pilot work. Withdraw both percentiles; do not replace with invented ones. Report next exact gate and checkpoint only. Handoff says repeated fork/compaction turns spent reissuing a /goal prompt (lines 44–48); use one short, non-forked implementation goal and keep report/execute scope explicit. Tests/reviews were not the delay source; the handoff cites real safety bugs (lines 50–52).

## Bounded recommendation

1. Confirm the executing session's already-granted deploy/cutover authority; the 19:10 ship-now steer itself says “recommended, not yet sent” (lines 3–5).
2. If authorized, take Create alone through final-head approved checks, clean-main bundle deploy, effective Create flags, and its permitted canary/readback. Use available pane output/component evidence; no GUI clicking/loading required by this review.
3. Keep Filing/Amend/Cancel flags off until their real routes and safety proof land. Preserve no-send, source/target fencing, unknown holds, and no-blind-retry.

No exact ETA defensible from reviewed evidence.
