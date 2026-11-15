# Retro + 10x plan: "AB" (DaVinci Cloud) and "daphne" (prefill), 2026-11-12 → 11-15

**Headline: the code got written fast; the time went into proving it live one bug at a time, review loops, and you steering. 50,000 changed lines merged in 6.2 h (P1–P3); the next 1,500 lines took 14.8 h (P4). You sent 118 prompts across 6 chats; about half were status pings, repeated corrections or pasting one LLM's output into another.**

- Sources: 6 Antigravity chats decoded from `~/.gemini/antigravity-cli/conversations/*.db`, 321 Codex sessions (Nov 12–15), 2 Devin sessions, `gh`/`git` state, 13 prior retros. 17 read-only subagents, one slice each. Extracts: `~/.local/share/zero/research/retro-20261115/`.
- Not re-verified live: EC2 flags and PM2 state are taken from the chats' final reports. `git`/`gh` facts are checked.
- Costs are API list prices from the local price table (`~/.cache/codeburn/litellm-pricing.json`). Antigravity and Devin usage is not priced (no token logs).

---

## 1. What the two tasks were

| Track | Chats (in order) | High-level task | Window (UTC) |
|---|---|---|---|
| **A: DaVinci Cloud** | Cursor chat → `scooby` → `Faster Fix` → `AB` (was `shaggy`) | Make the Centurion HMS Cloud tools work for Da Vinci (HRDAV, Suites HRDAVS): "we just need to hit tool parity". P1 property registry + approvals, P2 reads, P3 writers, P4 deploy + Labtest canaries + flags | 11-14 01:48 → 11-15 04:37 (26.8 h) |
| **B: Prefill** | Codex "v3abc prefork" → `centurion v4` → `v4 bugfix chat` → `daphne` | Make prefill fill every Infor field staff fill, measured. Benchmark audit → Tiers 1–4 build → client bug triage → "Rev 2" (catalogs, stay search, memory gates, REST quote availability) | 11-12 18:50 → 11-15 04:07 (29 h of chat over 57 h) |

## 2. What shipped, and where it stands

| | Track A | Track B |
|---|---|---|
| Merged | #2103–#2105 (P1–P3), 13 P4 PRs (#2106–#2116, #2119, #2120) | #1183 (Tiers 1–4, +15.5k), #1184–#1190, #1208, #1209, VSTO #12, #2117 (Rev 2, +3.6k), #2118 |
| Live | main `469087be49`; HRDAV `READS=on`, `MAKE_QUOTE=on`, `CREATE=lab`; Labtest Create→readback→Cancel passed on HRCEN and HRDAV | Rev 2 deployed 02:44Z; `HMS_QUOTE_REST_FAST_PATH` OFF |
| Measured | Labtest canaries only | 196/240 (81.7%) on the 50-case set, measured **before** #1208, #1209 and #2117. Nothing re-scored since |
| Staff value today | 0 real Da Vinci staff actions | 0 live HMS writes by staff; Outlook rollout waits on Monday IT smoke |

Repo total since 11-12: 88 commits to main, 730 files, +36.9k / −40.3k lines. 30 PRs merged.

## 3. Where the time went

| Phase | Wall time | Output | Verdict |
|---|---|---|---|
| A: discovery (10 parallel readers + live probes E1–E5) | ~3 h incl. 64 min waiting for you | "Port, not rewrite"; 5 field differences; live create/amend/upload/cancel proven | Good |
| A: architect/arena/interrogate before coding | 85 min | 8 real design gaps | Useful but heavy |
| A: P1–P3 under a detached supervisor script | 6.2 h, unattended | ~50,000 changed lines, legacy writers deleted | **Best stretch of the week** |
| A: P4 live proof | **14.8 h** | ~1,500 changed lines in 13 PRs | **Worst.** One HMS quirk found per deploy; each paid PR → typecheck → review → deploy → 3-hotel recapture |
| A: batched "speed mode" inside P4 | 99 min | 1 PR, 1 deploy, same class of fixes | Proves P4 was an orchestration problem |
| B: 11-12 V3 a/b/c bake-off + invalid benchmark | ~1 day, $416 of Codex | "No clear win"; scorer had 0 agency/A-R assertions | Mostly waste; a 1 h data census would have redirected it |
| B: Tiers 1–4 overnight run | quoted 50–75 min, first deploy after 6.6 h | PR #1183 live | 2 aborted 50-case replays, replay at concurrency 1 by accident, 85 min parked on an owner-only decision |
| B: bug triage chat | 5.3 h | 11 issues filed in 26 min, fixed same day | Good; one 11-issue PR took 2 h 49 m of review loops |
| B: Rev 2 (daphne) | 20:55 → 02:44 = 5.8 h | PR #2117 deployed | Units ran one at a time; 7 serial review rounds; 62 min idle waiting for your "yes deploy" |

Codex spend, by model: Terra $400, Sol $340, Luna $42, Astra $15 = **$797**. By day: 11-12 $416, 11-13 $229, 11-14 $145, 11-15 $7. Track A's whole Codex bill was about $135; Rev 2 about $18. Money was not the constraint. Wall clock and your attention were.

## 4. ETAs were wrong by 2–10x

| Quote | Actual | Ratio |
|---|---|---|
| Tiers 1–4 run: 50–75 min (11-13 01:13Z) | 397 min to first deploy | 6.4x |
| DaVinci P2–P4: 2.5–3.5 h left (11-14 09:55Z) | 1,122 min | 6.2x |
| Rev 2 units: 45–75 min (11-14 22:03Z) | 139 min | 2.3x |
| PR #1208 tail: 5–15 min (11-13 20:08Z) | 102 min | 10.2x |

- The ledger had no rows after 11-10. I appended these four (ids `retro-*`).
- Ledger median for `orchestration` says 0.94. These runs say ~6x. The ledger only gets rows when a run goes well enough to log.
- Coding per unit was on estimate (9–15 min). The misses are all in review rounds, live proof and waiting.

## 5. Your prompts

118 prompts (plus 31 slash commands): scooby 18, AB 22, centurion v4 47, bugfix 12, daphne 19.

| Kind (rough count) | Share | Example |
|---|---|---|
| Status pings | ~28 | "progress n eta?" |
| Corrections | ~16 | "ur job is not to do busywork but to prompt codex" |
| Relays between LLMs | ~16 | pasting a Codex report into Antigravity |
| Decisions, new direction, questions | the rest | |

**The same five corrections, repeated:**

| Correction | Times | Why it kept coming back |
|---|---|---|
| "You orchestrate. Prompt it and wait. Don't read it, don't do it yourself." | ≥9 in 3 days (3 in daphne alone) | Nothing enforces it. Each new chat started without it. The rule already exists in `nava-team-lead` and MISTAKES 10-23 |
| "Cut the ceremony. Why so long. 10x it." | ≥7 | Agents default to every gate in every doc |
| "Sol high not xhigh; Terra codes; Luna reads." | ≥6 | Three different routing tables in rules and skills; given mid-run, after the spend |
| "Fewer words. Yes or no." | ≥3 | You asked "did we fix the 2 bugs?" twice before getting "Yes." |
| "That blocker is made up." | ≥3 | Read-only HMS role, serialize Labtest writes, Labtest wait before deploy |

**Where your prompting worked:**
- One long message answering every open decision (scooby step 460; centurion v4 steps 434/451). Each unblocked hours.
- Blanket authority: "deploy autonomously", "mindset of yes".
- Forcing a measurement: "tell me right now how you'd do it 10x faster" produced the batch plan that did in 99 min what had taken 9 h.
- Fact challenges you were right on: Centurion child bands; "we didn't have a read-only for Centurion either"; the synthetic RDS row.

**Where it cost you:**
- **You were the message bus.** 6 chats for 2 tasks, plus Codex chats in between. In one slice 4 of 9 prompts were pastes. You lost the thread yourself ("what r we even doing again", "what did we even build lmao").
- **Standing rules arrived as corrections.** Model routing, effort, ceremony level and deploy authority were all predictable at the start. Each landed after the cost was paid.
- **Executor switches mid-flight** (Antigravity → Codex → Devin, Terra high ↔ xhigh). The read-role strip was done three times. The Devin switch cost about 2 h to protect a Sol bill that was $95 for the whole day.
- **Sleeping without pre-answered decisions.** The run parked 85 min on an email-send approval, 62 min on "can I deploy", 64 min on three design choices.
- **One wrong starting frame.** "Scrap V2 and V3, build V4" before anyone checked the benchmark. The benchmark was invalid and V2 was salvageable.

## 6. What the agents did badly

1. **Deploy-per-bug on live HMS.** 13 PRs, each with full ceremony, to learn one quirk at a time. All of them were discoverable up front by tracing the real requests unsaved.
2. **Built safety machinery nobody asked for, then removed it.** The DaVinci-only read-role proof gate (built P1–P3, stripped in #2116). Request guards pinned to exact request shape, against AGENTS.md, causing 3 hotfixes.
3. **Verified offline, broke live.** REST fast path fell back 100% live (5 protocol mismatches). #2116 passed typecheck and tests and took production down for ~25 min (ESM init cycle, 4/4 PM2 dead).
4. **Serialized what was independent.** Rev 2 units with disjoint files ran one at a time. Sol audit → Terra fix → Sol audit, 4 rounds, then Greptile 3 rounds, each finding one more P1 in the same function.
5. **Orchestrator bloat.** Polling, self-reading, long answers → up to 5 context compactions an hour → a corrupt PNG read into context killed two chats (SSM truncates stdout at 24 KB).
6. **Stopped at the finish line.** Nobody re-scored prefill after three large changes. One commit (`36cdbc84ea`, REST live fix) is still local and unpushed.

## 7. What went well (keep)

- Detached supervisor + `state.json` + `HOLD.txt`: survived your sleep and a chat crash, merged 3 large PRs unattended.
- Parallel cheap readers first (10 Luna, ~25 min), then decide.
- One batched PR + one deploy for live fixes.
- Sol adversarial review of the plan before coding: 7 P0 + 7 P1 in 28 min.
- Scoring the scorer before trusting a benchmark.
- A verify worker after deploy: 10 min, found 2 real regressions.
- Worker briefs with owned files, test commands and a done-line that ends in "merged".

## 8. Repeats from earlier retros

| Pattern | Earlier retros | Fix proposed then | Built? |
|---|---|---|---|
| Orchestrator idle or waiting on reversible work | 5 | "Default yes for reversible code" in the handoff | No |
| Orchestrator drives proofs itself | 3 | Canary lane script | No |
| ETA 2–3x over, never re-quoted | 6 | `eta.sh` from the DAG | No |
| Live-proof tail serial at the end | 7 | Preview-first canary at kickoff | No |
| Retro fixes written as prose | 2 explicit | "Retro fixes are T0" | Checklist only |

The only fixes that stuck were scripts (`merge-gate.sh`, remote typecheck). Prose rules did not hold.

## 9. Could it have been 10x faster?

| Dimension | This week | Achievable | Factor |
|---|---|---|---|
| Your prompts | 118 | ~10 (contract, one decision batch, final report) | **~10x** |
| P4 live-proof tail | 14.8 h | ~2 h (measured: 99 min batch) | **~7x** |
| Track A end to end | 26.8 h | ~7–8 h | ~3.5x |
| Track B (11-12 → 11-15) | ~29 h of chat + a wasted day | ~8–10 h | ~3x |

Not everything compresses. Live HMS reads run 90–150 s per case, a Save + readback is serial per stay, a review pass is 3–5 min and a deploy 4–7 min.

## 10. What is left

| # | Item | Track | Evidence | Size |
|---|---|---|---|---|
| 1 | **HRCEN "Done" proof on deployed main**: real-email unsaved Prepare + one Labtest Save/readback per writer (Amend and Filing Labtest left `UNKNOWN` on 11-13; Create real-email Prepare holds at `allocation_required`) | B/A | centurion v4 final state; AB final state | proof work, little code |
| 2 | **Outlook installer with the #1201 direction fix**, Monday IT smoke | B | VSTO PR #12 merged, installer not released | release |
| 3 | **REST quote availability**: push `36cdbc84ea`, fix `stockStatus:'unknown'`, add EC2 HMAC env + flag to the env writer, re-canary, flag on. 0.4–1.5 s vs a 53–60 s Quote | B | unpushed commit in `prefill-memory-rest-20261114` | small |
| 4 | **Re-score the 50-case set on current main**; then fix worst fields (note 1/16, guest name 10/18, company 9/13) and the 2 regressions the verify worker found (Snolink, Karen) | B | no score after #1208/#1209/#2117 | ~21 min to score; fixes medium |
| 5 | **Da Vinci remaining five workflows**: Amend, Cancel (nonzero-fee second Go; `fee_dialog_pending` bug), Filing, Add-Ons, Guest profile create. Flags unset, env wiring unverified, no canaries | A | AB final state | largest |
| 6 | HRDAV `CREATE` lab → on: needs one real HRDAV Create email (or a synthetic row, as you approved for Centurion) | A | AB final state | owner input |
| 7 | Pane-side HRCEN-only gates (`client.ts:356`, `quote-editor.tsx:59`, `filing.ts:601`, `voucher-find-card.tsx:122`): status after P1 unknown | A | DaVinci README | 10 min audit first |
| 8 | Agency / A-R selection has never been scored (0 assertions) | B | scorer summary | medium |
| 9 | HRDAVS (Suites) | A | parked; 0 Create source emails found | later |
| 10 | Open issues #1188 (P1), #1191, #1192, #1195, #1196 | B | `gh` | small each |
| 11 | Test debt: 57 fixture failures on main, 3 Node mock-loader failures, DB suites skipped | both | AB/daphne reports | cleanup |
| 12 | Housekeeping: 40 open PRs from 11-02 → 11-09, 17 worktrees, some carrying an old AGENTS.md (main's copy is already reconciled) | both | `gh pr list`, `git worktree list` | cleanup |

## 11. The 10x plan

**Principle: the owner writes one contract; a script, not a chat, runs the lanes; live discovery comes first; every lane ends at "merged"; one deploy train; status is a file.**

### T0: build once (before any lane)
| Piece | What | Kills |
|---|---|---|
| `RUN.md` contract (1 page) | Outcomes and done bar; standing authority (merge, deploy, flags to `on` after canary, Labtest writes); model table; ceremony budget (1 review pass per PR, 2 rounds max, no new tests, no architect/arena); default for every foreseeable decision; inputs needed from you, listed up front | Repeated corrections, parked decisions |
| `proof.sh <workflow> <property> <sha>` | Committed harness: env digests bound, non-colliding 2027+ dates, chunked SSM with validated downloads, one result line | 4 scratch-runner bugs, poisoned chats, orchestrator-run probes |
| Boot smoke before merge | Import + PM2 start check on the PR head | The 25 min outage |
| `status.md` + watcher | One line per launch/merge/block/done; supervisor refuses to idle without a wake-up armed | ~28 status pings, idle gaps |
| One set of rules | Main's AGENTS.md is already reconciled; rebase or remove stale worktrees that carry old copies; delete stale routing tables and LOC caps from skills | Invented blockers |

### Run shape
| Wave | Lanes | Model | Notes |
|---|---|---|---|
| 0: discover (parallel, read-only) | Trace real requests for all 5 Da Vinci workflows with unsaved Prepares; audit pane gates; find source emails; re-score the 50-case set; boot-check main | Luna ×10–15 or subscription readers | Ends in one decision table for you |
| 1: build (parallel worktrees, each lane owns its PR to merge) | REST fast path · prefill worst fields + regressions · HRDAV Amend · HRDAV Cancel · HRDAV Filing · HRDAV Add-Ons · HRDAV Guest profile · pane gates · HRCEN proof + installer · test debt | Subscription coding agents; Luna for bulk reads and test sweeps | Review loop lives inside the lane. Units with disjoint files never queue |
| 2: release | Merge batch → 1 deploy → boot smoke → `proof.sh` in parallel per property → flags | script | No drain-to-zero waits |

Supervisor is a detached script or a subscription agent, not a quota-limited chat. Chats are for you to ask questions against `status.md`.

**Owner update, 11-15:** Antigravity and Devin run on subscription; about $2k of Codex credit is left. Codex is now for parallel `gpt-6-luna` bulk work only (reads, replays, test sweeps; 10–15 at once). Orchestration and coding move to subscription agents. All five Da Vinci workflows run as parallel lanes, and every item in section 10 is in scope.

### Your touchpoints: 3
1. Approve `RUN.md`.
2. Answer the Wave 0 decision table in one message.
3. Read the final report.

No ETA quoted here: I have not read the unit code, and the four verified quotes from this week missed by 2–10x. Wave 0 produces the sizes; the ETA comes from those.

## 12. Changes proposed, not applied

| Change | Where | Why |
|---|---|---|
| Supervisor turn gate + `status.md` | new script | Prose rule failed ≥9 times this week |
| `proof.sh`, boot smoke | repo scripts | Proposed in 3 earlier retros, never built |
| Single model-routing table | `pstack-models.mdc`, `speed-plan`, `nava-team-lead` | Three conflicting tables |
| "Reversible = pre-approved" line | AGENTS.md | Proposed 10-28, never added. **Added with this retro (owner approved 11-15)** |
| Ledger auto-row when an ETA is quoted | hook | 5 days with no rows |

Credentials in transcripts: the Da Vinci HMS password (pasted into `scooby`, 11-14 05:56Z) and an Exa API key (pasted into a Codex chat, 11-14 19:03Z) sit in plaintext in the Antigravity and Codex session stores. The retro extracts carried both until redacted; two subagent slices read the password, and the retro session's own terminal output printed both once while checking. Rotate both.

## 13. Kickoff template for the owner

Most of what was repeated in chat this week belongs in files, not prompts. With standing rules in `AGENTS.md` and a run contract, a kickoff prompt needs five lines:

```
Goal: <the outcome staff or the owner gets>
Done: <how we will know, as a number or a check>
Sources: <chat names, files, PRs to read>
Off-limits: <anything not already covered by AGENTS.md>
Report: answer first, then tables; at most 3 decisions for me, each with your pick
```

| Habit this week | Replace with |
|---|---|
| "progress n eta?" | Read the run's `status.md` |
| Pasting one chat's output into another | Give the agent the other chat's name or file path |
| "use Sol high, Terra for code, Luna for reads" each run | One routing line in `AGENTS.md` |
| "go / continue / yes do the recommended" | "Reversible work is pre-approved" in `AGENTS.md` |
| "why so long, 10x it" after the fact | Ask at kickoff: "What will be slow or fail live, and how do you avoid it?" |
| Sleeping mid-run | Before leaving, ask: "List every decision you might need from me in the next 8 hours, with your default" |
| New chat when one gets slow | One orchestrator per task; it hands off through a state file |

Three questions worth asking at every kickoff:
1. What are we not measuring that matters to staff?
2. What has only been proven offline?
3. What is the first thing a real user will hit that we have not tried?
