# Centurion pane: identity, provenance, occupancy, HMS parity

**Owner request:** preserve full diagnosis; investigate occupancy + TA commission + remaining pane UIs; then fix, commit, push, PR, review, merge, deploy autonomously. First preserve evidence; no immediate speculative fixes. Search Infor redesign deferred.
**Execution posture:** Overnight autonomous. Owner may sleep. This file = diagnosis + execution record; no second plan.
**Status:** causal fixes implemented; actual-function diagnostics pass; final independent review and shipping gates underway. Live Suman draft untouched.

## Recovery anchors

| Anchor | Value |
|---|---|
| Working checkout | `/home/orca/.codex/worktrees/fd8f/agent-arch` |
| Branch / base | `fix/centurion-pane-identity-occupancy-20261113` / `842571cdc0e8ce781c0a2e09fcb460e44374e9f0` |
| Initial diagnosis source | deployed source `d0a22ab8ac5834348242dab0adbe95b1b35b4c6c`, `/home/orca/orca/workspaces/zero/centurion-combined-final-main` |
| Centurion v4 Antigravity transcript | `/home/orca/.gemini/antigravity-cli/conversations/b6183400-65f8-4296-8d0f-1545e9c098a6.db` (+ live WAL/SHM) |
| Centurion v4 Codex orchestrator transcript | `/home/orca/.codex/sessions/2026/11/13/rollout-2026-11-13T00-48-23-01a1d260-84d1-7fa1-afe1-79b056b7eb37.jsonl` |
| Orchestrator assignment | `/home/orca/.gemini/antigravity-cli/brain/b6183400-65f8-4296-8d0f-1545e9c098a6/scratch/codex-orchestrator-spec.md` |
| This chat transcript | `/home/orca/.codex/sessions/2026/11/13/rollout-2026-11-13T09-15-00-01a1d430-5675-73a3-9849-550ae518c8a4.jsonl` |
| Active independent Centurion run | `run_d251bad507d0`, `ctx_f66bdfb95a38`, terminal `term_d962216b-7751-482c-98d5-cd776002aa55`; do not interrupt |
| Other run state / master plan | `/tmp/centurion-tier1-4-state.json`; `docs/plans/2026-11-13-centurion-tier1-4-parity-plan.md` |
| Screenshot 1 | `/tmp/orca-paste-1794562841096-62ed7557-bfba-4b64-9b8d-e6b8c6a30f3f.png` |
| Screenshot 2 | `/tmp/orca-paste-1794563245709-8f2ab6b5-ad12-4534-aadb-f866a348b70b.png` |

## Global constraints

- Owner latest instruction wins. User explicitly requested this Markdown and full shipping cycle.
- Preserve unrelated dirty work in original `agent-arch`; isolated clean checkout above.
- No new tests unless owner asks. Existing focused tests + read-only diagnostics allowed. Never local `tsc`/`tsgo`; remote typecheck final clean SHA per app.
- No production-RDS tests. Unset `DATABASE_URL`, `TEST_DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` before tests. No repo-wide lint/format or Actions.
- No real-guest Saves or external sends. Real-email staging unsaved permitted. Labtest Save/readback permitted, CMS OFF. Serialize shared Labtest/confirmation writes.
- Do not interrupt existing Centurion session. Deploy clean fetched main through `ops-deploy.sh`; wrappers hold remote deploy lock and bind SHA. Verify runtime SHA, all four PM2 effective flags, health, required readiness gates.
- Greptile Apex final-head review; fallback reviewer if failed/stalled. Fix valid P0/P1; record other dispositions. Never bypass hooks or push main directly.

## Autonomous Execution Mandate

User granted full scoped autonomy. Continue diagnosis → smallest causal fixes → existing focused checks → final-head remote app checks → feature PR → GitHub review → merge → clean-main deployment → proof. Routine choices need no checkpoint. Failures → reproduce → RCA → fix → retry. Stop only for unavailable human-only access, destructive ambiguity, safety conflict, or outage preventing required proof. Existing owner authority covers deploy; no flag/environment changes needed by default.

AWS: EC2 `i-008f737974a9ba9b3`, region `af-south-1`, checkout `/home/ubuntu/repos/zero`; RDS `nava-zero-mail-pilot` read-only diagnosis only; S3 `nava-zero-mail-845242190536-af-south-1`. Primary deploy `apps/server-pilot/deploy/ops-deploy.sh`; bounce `ops-restart.sh`; read-only SSM wrapper `ssm-run-command.sh`.

Routing: bounded read-only investigations delegated; isolated editing ownership; independent final reviewer. Caveman Ultra reports; exact IDs, code, evidence retained. No unnecessary model/tool setup changes. Costs estimated only; actual API usage unavailable unless tool reports it.

Done = evidence record complete; all confirmed in-scope bugs fixed or explicit evidence-backed non-bug classification; focused checks + remote checks pass; final reviewed PR merged; deployed main verified; required unsaved real-email tool + Labtest Save/readback proven for changed writer behavior. No silent omissions.

## 1. Exact case + initial diagnosis (completed before owner requested fixes)

Email `VERY URGENT HOLDING REQUEST FOR SUMAN X 02`; sender `res5@africaincoming.com`; guest Suman; Centurion; 13–16 Oct 2027; 1 room; 2 adults.

| Record | ID |
|---|---|
| Source message | `c2a518f2-ae99-40ec-88e6-6e43a609c0f0` |
| Thread | `ff60dcb4-858f-41a7-b931-29fb9014bd91` |
| Work item | `25e7b967-087a-4df0-8998-9f099dbe6f4c` |
| Staff actor | `user-ropperman` |
| Infor agency | `Africa Incoming`, native ID `140` |

### Evidence: chronology, UTC

| Time | Evidence / implication |
|---|---|
| 05:37:19 | Initial HMS agency search returned one row. Complete coverage: total=1, loaded=1, possiblyTruncated=false. |
| 05:39:16 | Installed AI seed: bookingAgency `{name:"Africa Incoming", suggestedRef:"obs_v2_262363a9c0b3a400c6d47941", candidateRefs:[same]}`. No staff field overrides. Auto-selected first. |
| Subsequent automatic check | Another observation `c2cdbb61-ed85-4cca-aa56-8ad02664ff0b`, same native ID 140. Old/new details differ: `Africa Incoming · 140` vs `140`; identity same. |
| 09:38:46 | Staff selected ref `c2cdbb61-ed85-4cca-aa56-8ad02664ff0b`. Parent + native-selection overrides set. |
| 09:38:48 | Staff selected ref `obs_v2_262363a9c0b3a400c6d47941`. Same agency 140. |
| 09:40:32 | Explicit lookup produced `c1a36c25-4fc8-4926-b726-1890ff0f0909`, again 140, complete total=1. Third rendered choice. |
| 09:40:45.611 | Saved parent-name edit `{name:"Africa Incoming",candidateRefs:[],suggestedRef:null}` changed native-selection override from set → unknown; name unchanged. Audit proves edit followed search, not exact browser interaction causing edit. Last inspected work item rev=4. |

Three observations ≠ three agencies. This exact complete filtered search returned one native agency; no claim about all similarly named agencies globally. BOTH auto-fill and later manual selection occurred. Screenshot timestamp alone does not locate capture relative to every edit.

### Causal chains + source anchors

Paths relative to repo root; line numbers reference initial deployed `d0a22ab8`, may move after fixes.

1. **Duplicate identity choices (confirmed live draft).** Lookup saves fresh UUID per native match (`apps/server-pilot/src/ai/reservation-workflow-v2-tools.ts:1340`). UI `nativeChoices` collects all complete matching observations (`apps/mail/lib/reservation-workflow/views.ts:369`); identity dedup key `[observation.ref,row.value]` (`:398`) → same Infor ID across searches survives as multiple choices. Read-only execution of actual `nativeChoices` against actual saved draft returned all three ID-140 choices. Fix identity by stable native ID + correct entity/request/search scope; preserve selected ref; never dedup by name (distinct IDs can share names).
2. **Missing AI source icon + checkbox (confirmed seed).** Agency source claim stored at `/extraction/requests/<id>/parties/0/bookingAgency`; displayed control at `/proposal/content/requests/<id>/body/shared/bookingAgency`. `projectPartyFact`/party projection moves value but not displayed-path evidence (`apps/server-pilot/src/ai/reservation-workflow-v2-prefill.ts:1649,2081`). `FieldReview` exact-path lookup (`apps/mail/components/reservation-pane/shared/stay-fields.tsx:50`) finds no claim or review requirement → null render. Seed has no manual override, so missing original icon not explained by staff edit. Manual ancestor override later intentionally hides marker (`stay-fields.tsx:7,55`). Current binder clears automatic party `suggestedRef` (`prefill.ts:5228`, PR #1183); old stored draft predates that deployment, so persists earlier auto-selection.
3. **Same-name edit drops identity (confirmed audit; browser trigger unresolved).** `NativePicker.saveSearch` saves dirty name (`apps/mail/components/reservation-pane/shared/native-pickers.tsx:122`). State invalidates selection on parent party-name edits even same value (`apps/server-pilot/src/ai/reservation-workflow-v2-state.ts:1435`). Name can remain visible while selection unknown. Backend `resolveParty` requires native selection (`reservation-workflow-v2-tools.ts:222`) → `host_party_selection_required`; cannot conclude Save silently uses wrong identity. Need reselect + check. No assertion that clicking Search Infor alone always clears selection.

### Wider initial audit: observed vs predicted

| Family | Evidence / status |
|---|---|
| Create agency, organization, A/R; Quote agency/organization; Amend party fields | Shared identity dedup issue. Amend filters current query; ordinary Create/Quote party-name observations do not. |
| Create guest profile | Same per-observation identity key; first-three cap (`native-pickers.tsx:111`). Local sample IDs `[10,10,10,11]` → visible `[10,10,10]`, hiding distinct guest 11. Actual Suman guest search returned zero; no live duplicate guest claimed. |
| Query scope | Local sample query Bravo after Alpha → choices `[Alpha,Bravo]`. `nativeChoices` normal Create/Quote party observations lack current-query filter (`views.ts:380`). Picker no text match → falls back to all choices (`native-pickers.tsx:163`). Server selection query equality checks Amend only (`reservation-workflow-v2-draft-commands.ts:920`). |
| Native code catalogs | Actual repeated searches: room type 9+9→9, room-charge type 9+9→9, rate 68+68→68, guarantee 10+10→10, reason 4+4→4, CMS 6+6→6, source 26+26→26. Code-key dedup works. Local sample old `[A,B]`, refreshed `[A]` → `[B,A]`: obsolete code persists. Need distinguish partial catalogs vs complete refreshed results before replacing. Amend Track already latest complete scoped lookup + fresh-ref filtering. |
| Stay targets: Amend/Cancel/Services/Filing | Shared `TargetSearch` maps complete matching observations without native-stay dedup (`amend-editor.tsx:165`); Filing own candidate map (`filing-editor.tsx:158`). Backends append fresh refs (`amend.ts:1141`, `cancel.ts:808`, `services.ts:751`, `filing.ts:684`). Strong code-level duplicate risk; no live duplicate stay proven. |
| Add-ons | `latestCatalogueByIdentity` keys real itemId/nativeId (`addons-editor.tsx:31`), unlike party picker. No live duplicate evidence. Old missing entries may remain; investigate scope/completeness before fixes. |
| Cancellation reasons | Uses latest preview/warm result (`cancel-editor.tsx:75`), not union of every observation. |
| Other provenance in Suman seed | Arrival 13 Oct 2027, departure 16 Oct 2027, room count 1, adults 2, first name Suman: extraction-only claims; displayed field path lacks matching claim/review requirement. Room/rate and booker name/email/CMS-recipient do have mapped claims. Organization/A/R projection potentially affected; no values in this case to verify. |

Initial pure diagnostic output:

```json
{"partyForBravo":["Alpha","Bravo"],"noTextMatchFallback":["Alpha","Bravo"],"guestAll":["10","10","10","11"],"guestVisibleFirstThree":["10","10","10"],"ratesAfterRefreshReturningOnlyA":["B","A"]}
```

### What ran / what did not

Read-only production SQL in read-only transaction; source/history inspection; actual UI choice builder run on retrieved snapshot; local pure in-memory diagnostics; targeted GitHub PR/history search. No test suite/typecheck then, no writes, no pane/browser interaction, no code changes, no session interruption. Codegraph unavailable (no index); use `rg` + source reads.

PR #1183 relevant to initial-party binding; duplication code predates it. No obvious open PR specifically fixing shared picker found during initial targeted search. Existing legacy `nava-pane-render` tests do not mount these V2 components; no direct `nativeChoices`/`FieldReview` regression suite located then. New tests not authorized; use existing relevant focused checks.

## 2. Occupancy: confusing UI, useful source constraint

**Verdict:** ordinary stay, not native group. Two editable copies were confusing. Source requested totals remain useful: detect missing rooms/guests, never silently divide whole-party occupancy into rooms. UI now sums allocations; source request sits in separate read-only disclosure, explicit correction nested below.

Trace: `reservation-workflow-v2-contract.ts` Create date section has `requestedRooms`, `requestedTotals.{adults,children}`; allocation has individual occupancy + child ages. `reservation-workflow-v2-tools.ts` `createTotalsIssues` compares known requested totals against rooms before Prepare/Execute. Each allocation compiles to one `createReservation` call; PRODUCT ordinary Create = 1–8 sequential individual stays. Native groups deferred. No claim that a universal HMS group threshold is >10; owner’s 2-person case clearly ordinary.

`reservation-workflow-v2-prefill.ts` projects totals only to unambiguous single current date section; occupancy to rooms only where source per-room/single-room scope is clear. Whole-party 2 adults across multiple rooms does not establish allocation. Unknown children remains null; no evidence of children does not automatically mean zero when source occupancy is incomplete. Backend checks unknowns and age-count agreement.

**Additional confirmed defect:** add/remove/move allocation rewrote `requestedRooms` and deleted override/review; could erase source mismatch. `changeReservationWorkflowV2Rows` now preserves source-bound or explicit manual requested count, including legacy extraction-only current-generation count and stable-ID paths. Unsourced manually assembled request still derives count. This keeps ordinary manual creation usable.

**UI behavior:** `CreateEditor`: `1 room · 2 adults · unknown children`; adding unresolved second room → `2 rooms · unknown adults · unknown children`, plus `requested 1, added 2` mismatch. Read-only `Review source request totals`, nested `Adjust requested totals`. No “group” wording or second compulsory entry. Completed rooms included in sums; shared edits still affect unsaved rooms only. Unknown shown when no rooms or any invalid/unresolved member.

Shared Quote/Create `ChildAges`: blank now `?`; minus explicitly sets children 0. Plus from unknown sets 1. No action = stays unknown. Shared `Count`: clearing input/blank selection explicitly stages unknown (`null`), instead of ignoring action. Zero stays a distinct known value.

## 3. TA commission: real native field, advanced control

**Verdict:** supported. Exact Infor label `Commission Percent`, native key `ta1commission`. Not invented pane financial field.

Evidence chain:

- `tooling/hms-cloud/stay360-record-view.mjs` exposes native label; `guest-stay-commission.mjs` stages selected agency + percent, compares native model/form.
- `reservation-workflow-v2-tools.ts` Create accepts finite numeric 0–100 only with verified agency. `create-reservation.mjs` stages; `guest-stay-save.mjs` binds Save; `labtest-create-readback.mjs` compares fresh saved percent.
- `reservation-workflow-v2-amend.ts` validates/stages/binds percent and readback; `pane-amend-session.mjs` verifies. Clearing unsupported commission remains disabled; changing agency can change its native default, explicitly reviewed.
- `booking-code-rules.ts` directory default requires one native match and correlated native percent, directory/native confidence >=0.90. Prefill uses only verified default. Code inspection proves implementation path, not a fresh live commission Save this run.

Create label `Travel agency commission (%)`; collapsed by default, even valid 0/default. Heading shows value. Auto-opens for invalid value, required review, relevant Prepare issue. Field remains mounted; validation/uncommitted gates remain active. Scoped overrides retain field. Amend now uses shared percentage control rather than unrestricted number + range hint; finite 0–100 and empty unknown enforced before Check.

## 4. Exhaustive editor audit: confirmed bugs + fixes

| Finding | Before → after / causal evidence |
|---|---|
| Duplicate parties/guest profiles | Observation UUID dedup → native-ID dedup in `views.ts/nativeChoices`, scoped request/field/property/source/generation/query. Same names with distinct IDs retained. Exact selected ref retained when current canonical record matches. Guest first-three cap removed. |
| Stale identity query | Create/Quote prior query remained; text-no-match fell back to all. Current normalized query required; both UI + `selectReservationWorkflowV2Native` reject old query. Guest ordinary lookup compares surname/first/contact; source-bound candidates compare normalized source name/email/mobile. Profile intent must remain existing. Explicit unchanged selected identity exception retained. |
| Same-name edit erases selection | `updateDraft` + optimistic `displaySnapshot` now preserve native selection for canonical-equivalent name parent/leaf edits. Changed name invalidates. NFKC/trim/case/space. Explicit unknown/none never resurrected from legacy `suggestedRef`. |
| Missing source markers | `projectCurrentExtraction` now maps actual display-path claims + source annotations for dates, totals, per-room occupancy/ages, party/guest facts. Dedup + existing budgets (claims1000/annotations2000), exact current source. Old drafts: shared `fieldEvidence` also reads closest source annotation and narrow agency extraction fallback (same request/kind/name/current generation). No unknown-value evidence invented; manual ancestor overrides still hide markers. |
| Stale native codes | Latest fully covered field/context catalogue replaces older, including empty. Later partial correlated rows retained in same context. Explicit field read supersedes automatic fallback; automatic Create matches correct allocation/section. Rate Shop controls and room filters isolate contexts. Source alternatives retained; Amend Track retains target-specific freshness. Missing selected code causes visible refresh/reselection and blocks Check/Go. |
| Stale Add-On catalogues | Per-row observations lacked read identity/empty marker. New candidates share batch ID; final complete marker publishes exact candidate refs after all rows. Scope includes workflow/request/service/path/source plus allocation/Create digest or saved target+lookup ref. Latest complete batch replaces old even empty. Unpublished/broken marker fails closed. UI and server share semantic policy; server rejects stale selection and stale compiler input. |
| Add-On context changed | Existing catalogue outlived Create date/rate/structure edits. Marker records Create semantic digest + current allocation context. Backend recompiles and rejects mismatch; UI compares stable key-order-independent context and blocks stale selection. Other allocation’s independent override does not invalidate selected allocation. |
| Repeated stay cards | `TargetSearch` Amend/Cancel/saved Services + Filing own map accumulated every ref. Now coalesce exact property+confirmation; keep newest usable complete lookup. Keep old selected ref only when whole business facts match (including cancellation preflight), ignoring timestamps/source bookkeeping. Changed facts require refreshed selection. Distinct stays retained. |
| Filing guest mismatch late | Own Filing list checked dates only; backend already rejected guest mismatch at Prepare. UI now uses backend `sameGuestName`: title/initial/surname-first tolerant. Mismatch visible, selection disabled, previously selected mismatch blocks Check/Go. Exact source/query/linked successful Create receipt scope required. Backend remains authoritative. |
| Services command gate gap | New stale selection holds uncommitted; saved Services preview/save handlers previously ignored uncommitted set. `use-reservation-workbench.ts` now blocks both; mirrors other actions. Backend still does fresh native preview/readback. |
| Count cannot clear | Generic numeric/select Count ignored blank. Blank now stages unknown; child minus offers explicit zero. Backend unknown required inputs remain blocked. |
| Amend percent local gap | Generic number allowed out-of-range to Check, server rejected. Percentage control now catches locally; no unsafe-write claim. |

Additional independent-review corrections: explicit unknown selection not revived; child age source claims filtered to current source BEFORE index mapping; source-room preservation handles legacy extraction-only claim. All resolved before final review. No native request-body pinning, native writer algorithm changes or new tests.

### Coverage / evidence-backed non-bugs

| UI | Deterministic mapping / disposition |
|---|---|
| Quote | Date/room/occupancy/ages/meal/rate/party/strategy/allowance/contact/output map to V2 Quote compiler (`reservation-workflow-v2-quote.ts`). Offer freshness already gated. Shared identity/catalogue/count fixes apply. Output actions already correspond to supported quote flow. |
| Create | Source vs allocation totals above. Commercial/date/room/guest/CMS map to compiler. Ordinary multi-room remains sequential single-room. Supported scoped defaults/overrides retained. |
| Amend | Change fields map to `reservation-workflow-v2-amend.ts`. Room-count change correctly means separate Create/Cancel, not multiplying a native stay. TA local validation corrected. |
| Cancel | Display reason text is deliberate; server resolves against current native reason list and binds code. Latest preview/warm reason response already used; not union bug. Penalty second Go retained. |
| Add-Ons | Quantity/dates/unit price/frequency/pricing control/folio/comment map to Services compiler; fresh native preview/readback retained. Catalogue batch fix above. |
| Filing | Single-document/exact-target flow supported. Guest/date mismatch moved earlier; linked Create operation receipt still independently checked server-side. |
| Shared source/review/note/workbench | Manual source icon hiding deliberate. Busy editable fields not independently proven unsafe: edits stage/invalidate/requeue; Check/Go gated. Source generation and native selection fences retained. |

No live duplicate guest/stay or changing catalogue claimed. Those are actual-code reproductions. Exact Suman party duplication/audit/provenance are production read-only evidence. Downstream backend guards already blocked several bad selections; UI defects do not prove wrong saved stays.

## 5. Reproduction / verification: recover without re-search

Actual read-only snapshot `/tmp/centurion-pane-suman-snapshot.json` = `{session:{draft:...}}`; Suman Create request `v2_260155c4a0917e8f43d53e21`, date `date_1`, allocation `alloc_1`, generation/extractionGeneration `e2189ae2-342d-4fd8-a5ee-b1c926cb2b65`, source ref `src_adb26b9a99a6`. Native control noise stripped, observation identities retained. Full SSM read result `/tmp/centurion-pane-suman-readonly.json` uses `Stdout` capital; read-only transaction, statement timeout5s, exit0. Live draft rev4 updated09:40:45.628 unchanged after diagnosis. Service credentials/session secrets absent from artifact/Git.

Antigravity location confirmed via read-only summary SQLite: exact UUID/title `centurion v4`,1779steps; summary status idle does not mean running Codex stopped. Conversation DB `steps.step_payload` BLOB + metadata; raw DB, not plain Markdown. Orchestrator PID3508912 open fd + root00:48 session metadata/assignment matches listed Codex JSONL. Other child JSONLs exist. Do not copy active DB without SQLite backup consistency; JSONL root easiest LLM handoff. No interruption.

### Actual-code diagnostics (no DB/HMS, no new repository tests)

| Artifact / command | Result and boundary |
|---|---|
| `/tmp/centurion-identity-diagnostic.mjs` | Actual native choice code, real Suman3→1 ID140, each selectedref preserved; distinct same-name IDs retained; guest duplicate collapse; stale query/scope and recommendation leads filtered. |
| `/tmp/centurion-catalog-diagnostic.mjs` | Actual shared UI/server functions: correct allocation fallback; latest complete omits/empty; partial retains; native control scopes isolated; source alternatives; Add-On batch/unpublished/broken/empty/stay scope; equivalent selected saved fields; Create context dates/rate/structure + key-order independence. |
| `/tmp/centurion-target-diagnostic.cjs` | Actual extracted target logic + shared name matcher: duplicate/distinct stays, equivalent/changed selection, Cancel fee, generation/source, Filing name/date/Create receipt, percentage boundaries. |
| `/tmp/centurion-pane-diagnostic-build.mjs` + `/tmp/centurion-pane-proof/run.mjs` | Esbuild actual production functions; private exports in memory only; replaces persistence boundary with in-memory callback, executes real draft mutations. Actual React SSR fields/Create. No runtime DB/HMS side effects. |

Whole-code output:

```json
{"sameNameSelection":"retained, backend+optimistic","changedNameSelection":"invalidated","inheritedSelection":"retained","sourceRoomCount":"preserved add/remove and explicit correction","manualRoomCount":"derived","staleServerSelection":"rejected","legacySourceControls":"6 rendered with source+checkbox; manual hidden; generation checked","newProjection":"7 displayed claims","occupancy":"rendered totals, unknowns and mismatch correct","commission":"empty and valid default collapsed; invalid opens","childCount":"explicit zero action; absent remains null"}
```

Also explicit unknown/inherit edges pass. Legacy numeric-string count now acquires source annotation before structure changes; adding second date section then adding/moving rooms preserves original source count. `/tmp/centurion-pane-proof-count/run.mjs` actual happy-dom control interaction proves blank number/select stages null unknown; actual projection proves source ages [9,15] keep citation indexes when stale-thread age appears first/middle/last. Temporary builder `/tmp/centurion-pane-count-build.mjs`; no new repo tests. Projection uses actual stored extraction/source claims reconstructed text, not a fresh model run on full email. Actual SSR is not browser/Outlook proof. Diagnostic initial failures from old esbuild TLA, unrelated module initialization, duplicate React dependency, incomplete fixture operation arrays were harness issues fixed before assertions; no product-bug claim from them.

Run each with DB vars unset. Identity/catalogue source diagnostics require `node /home/orca/orca/workspaces/zero/centurion-combined-final-main/node_modules/.pnpm/tsx@4.20.5/node_modules/tsx/dist/cli.mjs <diagnostic>` for `.js`→`.ts` imports; compiled diagnostics use plain node; build output redirect temp log (symlinked dependency base causes harmless missing-base-tsconfig warning flood). Choose installed newest esbuild. React must resolve same actual dependency as react-dom; diagnostic package symlink fixed accordingly. Whole-code builder creates temporary individual dependency symlinks, no installs. Logs `/tmp/centurion-pane-proof/run.log`, `/tmp/centurion-catalog-diagnostic.out`, `/tmp/centurion-identity-diagnostic.out`.

Existing focused mail `tests/nava-pane-party-hints.test.tsx`:2/2PASS,1worker,noDBvars,16.2s. This is legacy adjacent coverage, does NOT mount V2 components. No existing focused V2 catalogue/services/FieldReview suite found; not adding tests per owner. `git diff --check` and changed component syntax transforms pass. Both final-head remote app typechecks remain required.

Installed Vitest entrypoint used because `.bin` virtual22.13.8 dependency broken; actual installed22.15.29 package works:

```sh
env -u DATABASE_URL -u TEST_DATABASE_URL -u VITEST_ALLOW_PILOT_RDS node /home/orca/orca/workspaces/zero/centurion-combined-final-main/node_modules/.pnpm/vitest@3.2.4_@types+debug@4.1.12_@types+node@22.15.29_happy-dom@12.10.3_jiti@2.4.2_jsdo_415ed7141e5d44e1492650e0db1e46f4/node_modules/vitest/vitest.mjs run tests/nava-pane-party-hints.test.tsx --maxWorkers=1 --minWorkers=1 --no-file-parallelism
bash /home/orca/bin/remote-typecheck.sh /home/orca/.codex/worktrees/fd8f/agent-arch --app mail
bash /home/orca/bin/remote-typecheck.sh /home/orca/.codex/worktrees/fd8f/agent-arch --app server-pilot
```

Remote typecheck commits-only, clean final SHA, isolated `/home/ubuntu/typecheck`, empty environment/no DB, flock+memory cap. Never local tsc/tsgo. No repo-wide lint, format, Actions or DB suites.

## 6. Review / landing / runtime gates

Initial independent review `/tmp/centurion-pane-independent-review.md`: noP0/P1; threeP2 corrected above. Whole-branch independent review060a80b: noP0/P1; twoP2 corrected: comma-form source guest query now uses existing `sameGuestName` semantics; legacy count accepts bounded integer strings and binds source annotation before a new date section makes original context ambiguous. Final correction review closes all three independentP2; at annotation cap2000, reuse extraction room-count claim or insert displayed claim within1000budget. Both budgets full with no reusable binding explicitly refuse instead of erasing source intent. GitHub review found oneP1 below; corrected and directly verified. Final-head remote checks/review remain required. Merge uses repo `scripts/orch/merge-gate.sh` exact head, unresolved P0/P1 block, normal hooks.

Independent Centurion run parked10:23UTC: `842571c` physically live, fourPM2/flags/HTTP/artifacts/VPN PASS; strict readiness NOT_READY (15nonterminal workflows); last-good remains `d0a22ab`. No queue mutation or waiver. Its earlier uncertain Amend/Labtest confirmation7539901789-1 held; never touch/retry. Our new proof must use separate Labtest confirmation/session. No competing deploy currently. Do not treat current HTTP200 as full release readiness.

PR https://github.com/kufupa/Zero/pull/1190; initial committed head `060a80b979728319067a9a47f4d2e55a560ff507`. Both remote app checks on060a80b PASS0errors (mail75s/server39s). Correction head must be checked again. Native proof runbook `/tmp/centurion-pane-proof-runbook.md`: separate new Proof Labtest dates2028-12-11–13, live guest/room/rate lookup first, CMS OFF, one guarded Save only; uncertain outcome never retry. Real Suman unsaved staging uses known date/adults/agency140 only; missing surname/room/rate/children remain unresolved.

Final landing/runtime proof will be attached to PR1190 with exact main/runtime SHA and outcome; owner-facing completed Markdown will include that receipt. Repository diagnosis records causal findings; verification status always inspect exact head, never carry old head checks forward. Any blocker must be explicit, never silently bypass readiness or call merged code “done”.

### GitHub review corrections / dispositions

- Greptile1190 P1 at `services.ts`: fresh Add-On candidate rejected when stored rooms array override was materialized before selection. Before actual callback returned `invalid_value`. UI/server `createServiceCatalogueContext` now canonicalize base allocation array from effective override/proposal, omit representation-only parent override, retain selected child/other body overrides and allocation ID/date-section order. Same business state before/after materialization matches; real rate/date/room/structural change still invalidates. Actual schema/materializer/compiler/guard selection now succeeds; changed-rate selection rejects. Temp `/tmp/centurion-array-override-report.md`, before snapshots `/tmp/centurion-array-context-before.json`, `/tmp/centurion-select-native-before.json`, after `/tmp/centurion-catalog-array-after.jsonl`. Existing persisted pre-update context markers require refresh; UI/server deploy together. No native write involved.
- GreptileP2 documentPII: invalid under current ownerAGENTS2026-11-07 + latest explicit detailed-record/push request; old `.cursor/rules/pilot-rds-safety.mdc` does not override owner. Reply https://github.com/kufupa/Zero/pull/1190#discussion_r4562256831. No credentials/session secrets in Git.
- First Apex CLI used stale local main, refused oversized historical diff; rerun against exact842base started but exited143 with empty output. GitHub Greptile review succeeded and independent reviewer used as fallback. Final-head Apex launched again after corrections; do not treat failed CLI as a passing review.
