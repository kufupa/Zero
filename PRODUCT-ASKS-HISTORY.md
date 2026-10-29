# PRODUCT.md — historical snapshot, not current instructions or authorization

Owner-edited. Agents read this before planning or coding. Do not invent requirements. If an ask is missing here, append it under **Asks logged** and preserve the original wording. Make ordinary reversible interpretations within existing scope and authority without waiting; stop and ask when material product decisions, safety or authority are ambiguous. Follow the owner’s current scoped instructions without inferring broader authorization.

Staff-facing name: **Nava**. Model name (Luna) never shown to staff.

## What this is

AI reservationist for Legacy Hotels Centurion. Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`). Same pane in webmail. Nava reads the selected email, pre-fills fields, and runs **deterministic** Infor HMS tools via Playwright. Human in the loop on every write.

**Live with the client since 2026-10-14.** Never call it a demo. Every deploy and every flag flip reaches real staff: warn the owner before either during staff hours (staff start 05:00 UTC / 07:00 SAST), and record the last-good SHA first. Any pane feature ships on both surfaces (Outlook pane and the webmail panel at nava-admin).

## Who it is for

Centurion reservations staff. Never ask them to run scripts, PowerShell, or terminals. Never show raw technical errors. If something takes >30s, say so in plain language.

## Workflows (ROI order)

Finish one before starting the next. Reads may be automatic. Writes are Prepare → Queue → Act → Review, with a screenshot.

1. **Quote** — company/agency contract rates (majority of bookings). Cover email + PDF. BAR B&B; dinner is an add-on, hotel-specific. Staff never name the company in the reply body. Fully booked = one-line decline, no alternative.
2. **Create reservation** — after quote, staff approve; Nava does the HMS create. Not typed by staff.
3. **Amend**
4. **Cancel** (lab only until owner says otherwise)
5. Payment proof / voucher, billing, group/event — after 1–4 actually work on real mail.

## Front door

Classify every inbound mail. **Skip** OTA / channel / automated / spam at the door. Travel-agent mail **stays in scope**. Examples in chats are examples — generalise the class, do not overfit the three live quote threads that happened to be open.

**Owner hard rule — pre-stay self-mail:** mail the hotel's own mailbox sends to itself (e.g. centurion@ → centurion@) titled "Pre Stay : Property … Confirmation No <conf> <name>" carries pre-arrival details for an **existing** booking. Read it as existing stay / pre-arrival info, never as a new booking, and never offer create. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match.

## Pane (staff)

Keep the V1 look. One primary action per step. Hide dead controls.

- Header: active mailbox + sync status, then selected email, then **read as** (same vocabulary as Needs-you: quote / booking / amendment / cancellation / voucher-POP / other).
- **Quote contact — appears in the PDF** at top (name / email / phone). Company/agency on the quote is a separate field. Edits save to this request; they do **not** write HMS unless staff hits the explicit book action.
- Stay by date range. Room-**type** rows with counts and occupancy. Totals. No “Room 1 / Room 2”.
- Rates: HMS rates + one-off/saved + required “Authorised by” for discounts.
- After an HMS match: facts + **one** Copy confirmation + Open HMS only if the target is real. Hide Find after a result.
- Quote review: PDF, Excel, editable reply, save unsent draft. Nava never sends.
- Attachments: say **Download to this computer** if that is all the code does. Attaching into HMS is a separate, approved write.
- Needs-you: short to-do list. Dismiss has Undo and a Finished path.

## Hard rules

- No real-guest HMS writes unless the owner set `RESERVATIONIST_PANE_SAVE=on`. Bot never accepts cancellation-penalty dialogs.
- One HMS browser lock per hotel. An AI agent may drive live HMS (owner 2026-10-25), read-only on real guests; writes only on Labtest.
- Labtest (fake "Proof Labtest" guest, 2027+ stays) writes are always allowed on any hotel; never ask (owner 2026-10-25).
- Never Nova Lite. Model routing: see AGENTS.md (Grok orchestrator; Luna/Grok coders by risk).
- Before Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never test against pilot RDS. Never print secrets or `postgres://`.
- Deploy only from `.worktrees/recover-parse-failure` via `apps/server-pilot/deploy/ops-deploy.sh`. A pane fix is live only after staff’s bundle reloads.
- P0/P1 review findings fixed before merge. No `--no-verify`.

## Done (this is the overnight gate)

**Done = score on a golden set of real past mail**, not merged, not deployed, not “3 live threads went green.”

Target mix (~30): quote 12, amend 6, cancel 4, create 3, channel/system skip 5. Answer key from read-only HMS, not from whatever the agent last saw in Outlook. Overnight goal = move that scoreboard. Tests are allowed as a gate only when they encode this class of mail, not one thread.

The golden set is versioned. Compare scores only on the same rows; when rows change, re-score the old build on the new rows before claiming a gain (2026-10-14: the set moved 30 → 27 → 26 rows overnight; v1 was re-scored each time, so 15/26 → 24/26 is a fair comparison). The golden set scores extraction and action class only; quote prices and party binds have their own bars below.

**Pass bars per workflow** (proposed in the 2026-10-14 retro; owner confirms or edits):

| Workflow / check | Pass bar | Unacceptable error |
|---|---|---|
| Party bind | 0 wrong auto-binds on the HMS answer key; auto-bind ≥ 70%; right party in top 3 ≥ 95% | any wrong bind → `PARTY_MATCH_V2` off |
| Quote (prepared or staff-run) | rate plan + price per night = what staff sent, on every plannable real ask in the proof set (≥ 10 threads) | a price that differs with no HMS-side reason |
| Front-door classifier | ≥ 90% agreement with outbound-grounded labels, ≤ 1% failures, at production concurrency and effort | a real booking/quote ask skipped |
| Amend / cancel find | right reservation found ≥ 95% on golden rows | a different guest's booking shown as the match |
| Any pane change | viewer run green + staff bundle load seen in nginx after the last deploy | "deployed" claimed without the bundle load |

A slice is **done** only when its bar passes on prod after the last fix. Merged, deployed or "tests green" is progress, not done.

Research already done: `docs/research/2026-10-13/README.md`. Do not redo it. Refresh the corpus snapshot if the mail mix is stale.

## How agents work this file

1. Read this + `docs/context/START-HERE.md`; consult relevant sections of `docs/context/ACTIVE.md`, `docs/context/OWNER-ASKS.md` and research indexes as needed.
2. Log new owner/staff asks here under **Asks logged**. Do not paraphrase them into a new plan and drop the original.
3. Argue the opposite once (will this overfit a thread? is this ROI?).
4. Ship the smallest slice that moves the scoreboard.
5. Stop when the slice’s acceptance test passes in staff terms.
6. **One workflow in progress at a time** (WIP = 1). Other lanes may only run evals, research or fixes that do not touch that workflow's files.
7. **Scope changes are trades.** A new item for a running plan names the item it displaces and the new ETA, and the owner approves before work starts. Never add a new feature to an overnight run unless its pass/fail check already exists.
8. Run contracts (overnight or daytime) follow `docs/context/RUN-CONTRACT.md`.

## Asks logged

_(agents append dated one-liners; owner promotes into the spec above)_

- 2026-10-14 (owner): skip Profitroom, Tiket.com, RateTiger and H-Pay (hospitality.cloud) at the door, exact host; Travelit and TBO stay in scope.
- 2026-10-14 (agent-proposed, owner approved): quote ready on open — Nava prepares the priced quote in the background (reads only) so staff don't click and wait.
- 2026-10-14 (owner): fully booked — alternatives are shown to staff in the pane only; the reply stays a one-line decline unless staff pick "Use this".
- 2026-10-14 (owner): action labels come from what staff did (outbound) first; else two models must agree; disagreements go to the owner.
- 2026-10-14 (owner policy): TMC cancellation notification = no action; a person asking to cancel = cancel; vouchers parked (find first, later); shuttle for a group = group/event, otherwise amend.
- 2026-10-14 (owner): DB route tests may use a local disposable Postgres on 127.0.0.1; never pilot RDS.
- 2026-10-14 (owner, after the client saw the live product): (1) pre-stay self-mail is an existing stay, never New booking (rule promoted to Front door above); (2) webmail panel shows "Access removed — contact Ansh" for centurion@ — diagnose the sync-owner denial and give webmail its own wording; (3) nava-admin "could not load this workflow folder" — error visibility first, then fix; (4) "Prepared by Nava" quotes must show in webmail too (`HMS_QUOTE_PREPARE` on remote-http as well).
- 2026-10-14 (owner): today's goal — every workflow (quote with price confidence, create, amend, cancel) to high accuracy. Work it one workflow at a time against the pass bars above.

- 2026-10-20 (owner): immediate goal is quote end-to-end in reservationists’ hands, preferably booking/amend/cancel/POP too; current request is deep planning and safe Orca cleanup, not implementation. Chat must contain technical steps, ETA evidence, ROI, alternatives/fallbacks and authority needs. Original asks: OWNER-ASKS.md 139–146.
- 2026-10-20 (owner): deploy whenever needed; no outside/before staff-hours cap. Existing write authorization and staff-bundle proof still apply.
- 2026-10-20 (owner): one mail may need multiple workflow actions; POP distinct from voucher; group typically ≥12 guests. Scope/readiness decision pending, not an overnight architecture rewrite approval.

- 2026-10-20 (owner): PDF click acceptable; autonomy means reliable end-to-end connections, not mandatory automatic PDF. Consider prominent Generate PDF + reply then review; editable Excel first-class. Replan technical scope and ETA basis before product execution. Original ask147 in OWNER-ASKS.

- 2026-10-20 (owner, D19): quote recall bar ≥85% (was 95%, arbitrary) on ≥100 independent outbound-grounded quote rows, not n=26.
- 2026-10-22 (owner, ask 175, client): ~66 h after a staff quote that states a validity/hold window, Nava drafts a follow-up in-thread for staff review. Never sends. Needs-you item.
- 2026-10-20 (owner): critically review best/elegant pilot product and exact first-release work/elapsed estimate; Grok final review with Sol coordination, not routine expensive Opus. Assessment only, no product execution approval. Original ask148 in OWNER-ASKS.
- 2026-10-22 (owner): one Outlook workstation with several mailboxes (e.g. Ayanda + Da Vinci); one Nava login across them; pairing may need multi-select for the one-month ingest. Design first. Ask 179, [handoff](docs/context/HANDOFF-2026-10-22-outlook-multi-mailbox.md).
- 2026-10-22 (owner): back to testing — no automatic real-guest bookings; `PANE_WRITE_CREATE=lab`. Ask 181.
- 2026-10-26 (owner, asks 238–261, planning only): “i want to use https://github.com/Pomerado/pomerado in order to build the add-on feature”; “don't forget any features ... note them all down”; combine unfinished handoff work with new booking UX, guest rows/individual child ages, clearer room counts and rate choices, automatic prefill/all-room rates, staff-first provisional confirmation, shuttle Add-On/removal/arrival-note workflow, and a complete ROI-ranked speed plan before the owner specifies a coding window. Preserve original phrases and every sub-ask in [intake](docs/context/2026-10-26-addons-ux-intake.md). Read-only research and planning, not implementation/install/deploy authorization.
- 2026-10-27 (owner, ask 275, research and next plan): “okay with it taking longer ... same amount of completeness”; prioritize complete new-booking side pane including native HMS Add-Ons and a Pomerado Labtest trial, verify ingest-time party/rate preparation and pane hydration, and rank multi-room/amend/cancel plus client-policy questions. Check concurrent Phase 1 ownership and separate original-goal repairs from tangents. Preserve [original words](docs/context/asks/2026-10-27-booking-completeness-owner-voice.md). This intake does not launch implementation or authorize real-guest writes, sends, installs, flags or deploys.
- 2026-10-27 (owner, ask 277, shaping only): “everything left todo”; prioritize previous handoff/retro over unverified Phase 1 completion claims; explain deterministic HMS tools vs computer use and the Centurion cloud move; assess a small early Pomerado experiment; maximize parallel delivery and minimize model $ / subscription burn without shrinking completeness. [Original words and sub-ask trace](docs/context/asks/2026-10-27-pomerado-parallel-shaping-owner-voice.md). No implementation/install/deploy/flag/send launch is inferred.
- 2026-10-27 (owner, ask 278): Pomerado on a real pre-existing feature (new booking via HMS for HRCEN + HRDAV), not an isolated test; mirror Infor Guest Stay entry order/format in the pane; triage subtypes (paid/provisional cancel+amend, Excel vs HMS quote, prepaid voucher booking); Needs-you/header scroll with pane. [Original words](docs/context/asks/2026-10-27-pomerado-new-booking-owner-voice.md). Research/chat only.

- 2026-10-27 (owner, ask 284): plan and finish the Pomerado read-stay trial quickly; Chromium, login and production-pipeline interruptions are authorized as needed. Read-only and private-data boundaries remain. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).
- 2026-10-27 (owner, ask 286): plan Pomerado setup and execution, and scope our code, prompts and ETA. Preserve the read-only trial boundary and distinguish it from complete booking and Add-Ons. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 296): assess whether Pomerado setup and prompting followed the vendor setup and architecture guides; pause and plan the best elegant method if not, otherwise continue. Preserve the complete read trial. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 297): research model choices for Pomerado driver and Guardian, then create a new best and elegant plan; pause for human confirmation before execution. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).
- 2026-10-27 (owner, ask 298, planning only): “no i dont want to prove thwir simple public i wanna do ours”; critically revise the fastest direct HRCEN trial plan, preserving the original full trial. Original wording and the execution hold: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).
- 2026-10-27 (owner, ask 299, planning only): deepen the direct HRCEN plan, compare earlier prompts, add helpful known-flow detail, and critically shorten and explain the artifact-review and verification estimate; consider Greptile Apex. Preserve the complete three-case trial and original wording in [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 300): “sounds good run it” approves execution of the direct HRCEN Pomerado read-stay trial in plan 006, preserving all three comparisons, read-only safety and private-data boundaries.

- 2026-10-27 (owner, ask 303): review every present and foreseeable Pomerado trial control one by one, identify old or agent-added blockers, and recommend keeping, removing or simplifying each before any change. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 304): approves removing the controls recommended for removal in ask 303 and running the direct Pomerado HRCEN read-stay trial, retaining the original read-only and private-data boundaries. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 307): “fuck it lets pause and do a retro. I'm not happy w prohress so far so lets retro and decide if its even worrh continuing /nightly-retro /95”. Trial paused pending owner direction; original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 308): “ok can we update promerado to latest theres been git lushes n merges in main pls so git pull locally for us”. Trial stays paused. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 309, planning only): plan a fresh simple Pomerado proof with a smart minimal-input mint and access setup; reuse the retro, current vendor guidance and examples, and give an evidence-backed midpoint ETA. [Original words](docs/context/asks/2026-10-27-pomerado-fresh-plan-owner-voice.md). No trial execution authorized.

- 2026-10-27 (owner, ask 310, research/planning only): challenge the Pomerado ETA with /95 evidence; assess replacing/layering HMS operations and Mastra compatibility; use the selected screenshot booking as the private first example; request GPT-6 Luna max for every trial model role; make the plan barebones and explain in chat. [Original wording](docs/context/asks/2026-10-27-pomerado-speed-owner-voice.md). Trial remains paused; original three-case proof is not silently dropped.

- 2026-10-27 (owner, ask 312, planning only): compare Grok review, correct and finalize the Pomerado plan, give an ETA and full step-by-step explanation in chat, with a short final bullet TLDR; wait for go before execution. [Original wording](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 314): prioritize end-to-end new bookings and provisional HMS quotes by tomorrow, not Excel; request is a ranked table, not execution authorization. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 319, planning only): use the Pomerado retros and knowledge to plan a Pomerado-led HRCEN login and verification first; push back on risks. Preserve the selected screenshot and original three-case read proof as later scope. Trial stays paused pending execution authorization. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 320, planning only): challenge the 35-minute Pomerado login-first allowance; minimize the native mint prompt and critical path using the retro. Trial remains paused; original wording in [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 321): owner personally confirmed HRCEN login and authorized the Pomerado login-first test, monitoring and cleanup; no guest-case work inferred. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 323): retro the failed Pomerado login-first attempt, inspect what code it wrote and explain the outcome. No new trial authorized. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 325): build a Pomerado Cloud read-only tool to sign in to Centurion, open Stay 360 and report the screen. Cloud exceptions were approved in ask 326; the read-only build ended with sign-in unavailable and no tool or Stay 360 result. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 327): debug Pomerado sign-in and assess using a deterministic Playwright login followed by local Pomerado exploration. Diagnosis only; no new live trial inferred. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-27 (owner, ask 328): plan local Pomerado with deterministic Playwright login, immediate stop after Stay 360 screen read, and fresh tool run; inspect local vendor setup and obtain anchored Grok 4.7 xhigh adversarial review. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). Planning only.

- 2026-10-27 (owner, ask 329): scope reuse of existing Da Vinci/other hotel Playwright login and URL for the local Pomerado handoff, challenge the login-bridge estimate, and update the plan. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). Source and planning only.
- 2026-10-27 (owner, asks 330–331, planning only): tighten the local Pomerado Stay 360 proof and minimize the defensible ETA without dropping the fresh generated-tool replay or read-only, privacy, Guardian and property-lock boundaries. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No trial launch inferred.
- 2026-10-27 (owner, ask 332, assessment only): challenge the Pomerado coding estimate, inspect prior mistakes and pursue faster controlled work without dropping the requested proof. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No trial launch inferred.
- 2026-10-27 (owner, ask 333): request a practical ETA for the narrowed Pomerado proof. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No trial launch inferred.
- 2026-10-27 (owner, ask 334): approves execution of the revised local Pomerado HRCEN screen-only proof and fresh tool replay, under the existing read-only and privacy boundaries. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 346, planning only): “cool next checkpoint? n fastest way to get there plan it up gimme eta dont run yet”. Plan the next self-deployed Pomerado Stay 360 checkpoint for speed, preserving read-only and privacy boundaries. No run until owner go. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 347): “sure /ce-plan it up then run it” authorizes final planning and execution of the previously scoped self-deployed Pomerado HRCEN screen checkpoint. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 349, planning only): “cool whats next n why plan it up lmk n eta prediction / checkpoint and how to read checkpoint as fast as possible”. Explain the fastest next Pomerado screen checkpoint and ETA; original wording in [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No new trial inferred.

- 2026-10-28 (owner, ask 350, planning only): check Pomerado README/examples and plan a minimal “read everything on the screen click nothing repeat back everything” mint. Owner says show the result in chat and do not execute. Preserve the original words in [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 351, planning correction): Pomerado may click around and scroll during the read-only screen task; the proposed no-click restriction was too strict. Original words in [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No execution inferred.

- 2026-10-28 (owner, ask 352): “cool go for it” authorizes the ask 351 read-only Pomerado HRCEN Stay 360 checkpoint with relevant clicks and scrolling. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 358, diagnosis only): deeply debug the locally hosted Pomerado MCP and failed Stay 360 read, using scoped Sonnet 5.5 max subagents in parallel; determine from evidence whether the button was attempted and why the trial failed. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No new live trial or fix inferred.

- 2026-10-28 (owner, ask 359, explanation only): explain the actual self-hosted Pomerado MCP/client/Azure model setup versus vendor guidance and how a hypothetical overnight Labtest reservation, Jarat Tours add-on and CMS confirmation would run. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No new trial, booking or email authorized.

- 2026-10-28 (owner, ask 360): plan self-hosted Pomerado on EC2 with native Codex MCP, Azure, Terra xhigh for Codex, Luna max for Pomerado, Pomerado-managed login first and existing login script as fallback; open Stay 360 and read a previous booking's complete visible details. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). Planning only; no new live run inferred.

- 2026-10-28 (owner, ask 361-meta, research/planning only): audit retros, today's Claude Code chats and the effective rule/memory stack for useful versus stale or costly guidance; propose a lean customized setup without interrupting running sessions. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No config or rule cleanup authorized.
- 2026-10-28 (owner, ask 361): approves executing ask 360's Codex/Pomerado read-only plan with Centurion details and URL only; Da Vinci is used by another parallel lane and must not be touched. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 365-pomerado): goal is local self-hosted Pomerado with Codex and Centurion HMS until 06:00 UK, with a retrospective and replanning every 30 minutes; use `/95-exa-agent`. No Pomerado Cloud. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). Existing read-only, privacy and Centurion-only boundaries remain.

- 2026-10-28 (owner, Pomerado): selected “Extend one hour” for the self-hosted Centurion read-only trial, then interrupted and requested “/nightly-retro this testing of pomerado pls”. See [OWNER-ASKS.md](docs/context/OWNER-ASKS.md); no new trial started before the retrospective.

- 2026-10-28 (owner, Pomerado): “no don't continue i said retro it”. Stop the resumed trial; no further Pomerado browser or mint work until new owner direction. See [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 368-claude-783c2180): approves implementation of the Claude Code simplification plan. Preserve existing sessions and safety boundaries. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 369-claude-783c2180): permits at most three concurrent tests on this VPS across all CLIs and agent harnesses; replace the outdated blanket remote-only rule and determine a shared limit. Audit remaining rules as helpful, harmful or uncertain. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 370-claude-783c2180, planning only): rebuild the agent operating model from first principles around a clear 10/10 Nava product, evidence-backed pushback and research, optional skills/MCPs chosen by judgment, fast shipping and maximum safe parallelism. Compare the other model’s assessment and preserve the shared three-test limit and current-session safety. [Original wording](docs/context/asks/2026-10-28-agent-operating-model-claude-783c2180.md). Implementation remains paused.

- 2026-10-28 (owner, ask 371-claude-783c2180): “yep cut all of these then, how can we cut them across codex / the other clis on this machien too pls”. Authorizes targeted removal of the obsolete rule classes listed in ask 370’s plan across installed CLI harnesses; preserve live sessions and genuine safety and review gates. No broader rebuild or test-cap rollout inferred.

- 2026-10-28 (owner, ask 373-claude-783c2180): approves additional rule, hook, startup and sync cuts while preserving existing sessions and safety boundaries. Original wording: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, Stagehand trial, f777f33d): “u r the fresh llm, pls run this” authorizes the immediately preceding direct HRCEN Labtest profile/count and Stagehand/Azure synthetic-first comparison, read-only with property locks. [Evidence](docs/research/2026-10-28-stagehand-labtest-fable-f777f33d.md).

- 2026-10-28 (owner, planning/assessment only): “lets test on real asap” with a new Centurion Labtest booking, CMS send to the owner-provided address, and the second displayed CMS Message ID option; assess fastest Stagehand path and production implications. [Original wording](.private/stagehand-labtest-f777f33d/2026-10-28-owner-new-request.txt). No execution inferred from this analysis request.

- 2026-10-28 (owner, planning only): “cool lets plan it, /ce-plan focusing on LOC and eta. then get grok 4.7 xhigh via grok build cli to adversarially review it into an md. /caveman ultra read it, analyse urself, then make final best + elegant plan”. No live run, write, send, deploy or flag change inferred.

- 2026-10-28 (owner, ask 384-claude-d1bc38f9): “cool lets run up till the "│ First single-room pane result                   │       30–60 min │" autonomously rn. is this planned n adversarially reviewed yet?” Authorizes the first Da Vinci single-room Labtest pane checkpoint only. [Original wording and result](docs/context/OWNER-ASKS.md). No new email, deploy, flag change or Pomerado run inferred.

- 2026-10-28 (owner, ask 385-claude-d1bc38f9): “what du wanna do / eta n next steps?” Assessment of the next Da Vinci pane checkpoint only; no new execution or Pomerado authorization inferred. [Original wording](docs/context/OWNER-ASKS.md).

- 2026-10-28 (owner, ask 386-claude-d1bc38f9): proposes an RDS copy to Da Vinci mailbox for owner-click testing in hosted nava-admin, directs ignoring locks and asks for a new Centurion browser; challenges the prior ETA. [Original wording](docs/context/OWNER-ASKS.md). No new DB write, browser, lock change, send, deploy or HMS action was made in this assessment.

- 2026-10-28 (owner, ask 387-claude-d1bc38f9, planning only): “cool 25 minutes sounds good. plan it up”. Plan the owner-click Da Vinci Labtest checkpoint, retaining ask 386’s separate Centurion browser request and lock direction. [Plan](docs/plans/2026-10-28-009-davinci-owner-click-d1bc38f9-plan.md). No execution inferred.

- 2026-10-28 (owner, ask 388-claude-f777f33d-rategrid, assessment only): “lets start from scratch”; assess the fastest Stagehand HRCEN login, create-form field inventory and Labtest Rate Shop read, challenging the prior ETA. Original words: [OWNER-ASKS.md](docs/context/OWNER-ASKS.md). No booking Save, email or live run inferred.

- 2026-10-28 (owner, ask 389-claude-c9b52855): executes the owner-click Da Vinci Labtest checkpoint and separately requests a new Centurion browser. [Original wording](docs/context/asks/2026-10-28-davinci-owner-click-claude-c9b52855.md). One fake room, fresh dates, HMS send off, preview first, single save, read-only reconciliation if uncertain; no other operation interference or lock-code changes.

- 2026-10-28 (owner, ask 390-claude-f777f33d-stagehand-nextsteps, assessment only): “nice sounds smart. du have a plan with specific stuff to do yet or whats next steps?” Explain the existing read-only Stagehand approach and next steps. No execution inferred.

- 2026-10-28 (owner, ask 391-claude-f777f33d-stagehand-scratch): “otherwise am happy to run tell me more specifically what ur gna do i.e pseucode” and “also idgaf about the property lock skip that even n just use it.” Answer the Stagehand setup and estimate questions. [Original words](docs/context/asks/2026-10-28-stagehand-pseudocode-claude-f777f33d.md). No live action this turn.

- 2026-10-28 (owner, ask 392-claude-f777f33d-stagehand-update): “whats latest stagehand // can we update it too to latest pls. and how much if we write this pseudocode for it, can become deterministic? i.e i wanna avoid paying LLM every time innit or as much as possible. and also being able to screenshot particular pages would be nice too but not end of world.” Upgrade Stagehand and explain deterministic replay and screenshots; no new live HMS workflow inferred.

- 2026-10-28 (owner, ask 393-claude-f777f33d-stagehand-proof, assessment only): “Screenshot caveat: A screenshot of Rate Shop may miss rows inside its scrolling grid. We still need to read and validate the complete grid separately.” :: no not for pulling the data, just for the clients sake cos they like seeing what the AI does to make sure its not bullshit. cool so r u ready to run / whats next steps / is a plan made Screenshots show clients what AI did; explain readiness and next steps, without launching a new live run.

- 2026-10-28 (owner, ask 394-claude-f777f33d-stagehand-scratch-model, explanation and plan correction): “so we use latest stagehand docs n code to write script, then run it with which LLM? and no on " "Use known selectors where practical. Use the model for discovery only where needed, then save successful actions for later replay. The old Azure adapter needs checking or adapting if the new script uses it." :: i want to use stagehand from scratch i.e its a test of how good stagehand is! so script from scratch is the move pls” Test Stagehand using a fresh script rather than an existing-selector-first flow. No live trial inferred.

- 2026-10-28 (owner, ask 395-claude-f777f33d-stagehand-run): “sounds good, cool run it all autonomously pls” Authorizes the preceding fresh Stagehand-led HRCEN read-only form-and-rate trial with screenshots and Labtest dates. No Save, email or deployment; owner directed no property lock.

- 2026-10-28 (owner, ask 396-claude-f777f33d-stagehand-login-time): “how long did it take to sign in?” Successful run start to confirmed sign-in took 20.509 seconds, excluding earlier failed attempts.

- 2026-10-28 (owner, ask 397-claude-f777f33d-stagehand-progress): “Including the failed attempts and fixes, it took about 3 minutes from the first run to confirmed sign-in. That excludes writing the initial script.” :: lol wtf went wrong and how did the fixes work? how is next steps going? are we going to keep going after that? Explain the failed attempts and keep the approved read-only trial running.

- 2026-10-28 (owner, 398-claude-0b0c189d-local-comparison, research only): “check  nread locally hosted pomerado vs stagehand sdk. features vs each other vs claims of the local open source version only. idgaf about the cloud versions in fact we wanna explicity state whats hidden behind paywall / cloud.” No trial, install, update or deployment inferred.

- 2026-10-28 (owner, ask 398-claude-f777f33d-stagehand-eta-determinism): “progress n eta? anything deterministic? its been 15 mins so far so will it be better next time?” Report progress, ETA evidence and deterministic reuse while continuing the authorized trial.

- 2026-10-28 (owner, ask 399-claude-f777f33d-stagehand-progress-20min): “progress n eta? anything deterministic? its been 20 mins total now so far so will it be better next time? / progress over last 5 mins#” Report evidence and continue the authorized read-only trial.
