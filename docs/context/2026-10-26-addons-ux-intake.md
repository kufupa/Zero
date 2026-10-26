# Owner intake: Pomerado, booking UX and unfinished work

Date: 2026-10-26. Planning and research only. Source: owner's current voice-dictated message, supplied handoff, and private staff-call evidence. No product implementation, install, flag flip, live HMS activity, provider email, deployment or or2 merge is authorized by this intake.

## Original owner intent

> "i want to use https://github.com/Pomerado/pomerado in order to build the add-on feature."
>
> "we gotta make sure we don't forget any features, we note them all down"
>
> "we take the handoff from the previous chat which is still finishing, but also a bunch of new feature requests and then we make a massive plan and talk through it together"
>
> "scope out all of the features and all of the other main to-dos ... check the ROI ... a really, really fast speed plan ... then i'll tell you ... how many hours i actually have to do the coding"
>
> "we should never have less information than info"
>
> "avoid duplication ... keep in all of the other features I haven't considered too, like pre-filling and ... evals"
>
> "also check orca etc to make sure we're on the right branch / worktree ... i might've opened this in an older ... worktree"

## Complete request register

| Planned ledger # | Owner's words or direct intent | Required answer / acceptance | Status |
|---|---|---|---|
| 238 | "use ... Pomerado ... to build the add-on feature" | Verify actual library, licence, generation/runtime, prerequisites, safety and measured-vs-claimed speed. Plan real HMS Add-On trial. | Research |
| 239 | "still use ... 6.1 Sol in the Playwright browser on the EC2" | Verify model/base-URL and browser/CDP compatibility. Distinguish Sol discovery from deterministic production execution. | Research |
| 240 | "don't forget any features ... note them all down" | Durable original asks, answer links, dependencies, open holds and resume read order. No silent deletion during compaction. | Intake saved |
| 241 | "take the handoff ... all ... to-dos ... ROI ... fast speed plan" | Cover both new asks and all handoff leftovers. Separate proposed product release from operations/research. | Planning |
| 242 | Handoff: gate.sh / eta.sh / canary.sh as three parallel lanes | New main-based worktree, exact files/tests, no swaps into active or2. Plan and ETA before implementation. | Planned, not launched |
| 243 | Handoff: Da Vinci "room profile out of date" diagnosis | Test property/catalogue/freshness/multi-room mapping hypotheses from current code and read-only evidence. No guessed fix. | Research |
| 244 | "guests separately as rows ... names and ages" | Infor-inspired guest list, linked to room-type rows. Preserve room quantities, contact/booker/guest separation and privacy. | Planning |
| 245 | "children's ages ... comma ... bullshit" | Individual numeric age fields; prefill, validation and persistence; no comma-delimited staff entry. | Planning |
| 246 | "too many ... indented boxes ... too much text" | Flatten hierarchy, clear state/step boundaries, spacing, no decorative rebrand. | Planning |
| 247 | "oh is there three rooms when ... two rooms" | One authoritative room count, distinct stay/room-type/guest counts. Eliminate duplicated summaries. | Planning |
| 248 | "all rates drop down ... barely ... recognize" | Visible rates/strategy control and reason for disabled actions. Preserve every property-approved strategy. | Research |
| 249 | "rate grid ... expected ... clickable" | Determine which current grid is informational versus selectable. One exact room/rate/board/occupancy selection action. | Research |
| 250 | "starts ... collapsed ... slowly ... open" | Progressive disclosure without hiding blockers, completion context, expert access or any HMS option. | Planning |
| 251 | "Infor parity ... make it better ... never ... less information" | Field/workflow parity matrix; preserve current V1 identity and both Outlook/webmail. Do not copy HMS's bad interaction design. | Planning |
| 252 | "review ... yourself ... impeccable" | Independent UX review and detector/browser evidence on current source. State visual/runtime gaps honestly. | Research |
| 253 | "pre-filling ... super important ... order" | Immediate email extraction; safe parallel reads when required facts exist; contextual rates after party; dirty edits win; freshness and mailbox/stay identity. | Research |
| 254 | "create provisional booking ... sends it to ... FK email" | Staff-controlled confirmation recipient from approved mailbox configuration, not person-name matching. Preserve guest contact; verify correct HMS document and receipt; no guest auto-send. | Research |
| 255 | "jarrett tours ... adds ... money ... confirmation ... removes ... guest arrival detail" | Re-read private transcript. Provider spelling, property, payment/removal trigger and note field stay unresolved until evidenced. Preserve priced extra, billable row, provider state and operational note separately. | Research |
| 256 | "add on to ... booking tool" rather than only a standalone tool | Compare dedicated Add-On primitive with create orchestration. Partial Add-On failure must never repeat reservation create. | Planning |
| 257 | "screenshots ... save ... extract details ... not ... every single time" | Private screenshot archive, small field/DOM manifest and evidence locators. Raw screenshots/transcript outside Git. No image received in this prompt. | Evidence gap |
| 258 | "rates are missing ... worst ... no progress since friday ... not merged?" | Separate current source, deployed build, loaded staff bundle, profile data and selected-request results. Test stale bundle, missing setup, read refusal, filters and genuine HMS no-rate. | Research |
| 259 | "Standard Twin ... STWN ... naming ... front and back end" | Test exact native-code path and property-scoped matching. Preserve unknown/ambiguous room refusal. Owner's cause is hypothesis, not confirmed diagnosis. | Research |
| 260 | "all ... rooms ... pre-looked up ... DaVinci ... never ... down" | Trace automatic all-room/all-rate read and result hydration, admission, wait and freshness; do not blame Centurion maintenance for HRDAV. | Research |
| 261 | "all ... other ... missed ... priority" | Recover R-SEED, provenance follow-up, dispatch, queue retries/idempotency, PDF/Needs-you proof, multi-mailbox, feedback/evals and other existing backlog without starting them. | Research |

## Ownership and source checkpoint

- Original terminal belongs to clean but outdated `docs/sr2-owner-steer-20261020`, HEAD `2e359cc5e`; fetched main was `1e7c5644f`. Git comparison: 2 local-only commits and 312 main-only commits.
- Independent planning worktree: `addons-ux-plan-1026`, branch `kufupa/addons-ux-plan-1026`, created from `origin/main` at `1e7c5644f`.
- Do not mutate `/tmp/or2`, any or2-* worktree, speed-mode-scripts, recover-parse-failure or the other chat's deploy/merge train.
- Handoff is `docs/plans/2026-10-26-005-session-handoff.md` on branch `docs/mh1024-retro`, commit `550bf12`, not assumed merged into main.
- Prior Add-On/call evidence is on `docs/sr2-owner-steer-20261020`, commit `2e359cc5e`, not assumed merged into main. Read it without using that checkout as current product source.
- Ledger numbering 238–261 is reserved in this independent branch after handoff asks 223–237. At eventual merge, reconcile any parallel additions rather than overwriting or renumbering original asks silently. Prior report called staff-call evidence ask 175, but main already uses 175 for quote follow-up. New register must not overwrite that historical ask.

## Voice transcription uncertainties

- “info” is treated as Infor HMS.
- “duty 6” appears to refer to a GPT/model but is not promoted to an exact model identifier.
- “Jarrett/Jarret tours”, the exact missing rate name, payment timing and the extra separate-PMS workflow need evidence.
- Owner now explicitly identifies the reviewed call/session as Da Vinci. Older call summary labelled some shuttle evidence Centurion without a verified property. Do not promote either as hotel-wide accounting policy.

## Next read order

This intake; completed plan when available; dated research outputs; current main delta; required PRODUCT/AGENTS/ACTIVE. Implementation waits for the owner's scoped coding window and approved plan. No product flags, install or sends are implied by research.
