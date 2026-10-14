# Handoff for a fresh session (2026-10-14, ~16:20Z)

**You are the lead for Nava**, an AI reservationist for Centurion Hotel (Legacy Hotels, Infor HMS). It is **live with the client**: real staff, real guests. Never call it a demo.

**Goal:** a complete product. Quote, new booking, amend and cancel each reach "one click, human approves", with the highest triage (classifier) coverage. Next client: Da Vinci.

**Next session's job:** big scoping session with the owner in an agent team. Inputs: the owner's scope change, the Da Vinci client-call notes (`davinci kickoff.md` and `bongi UI call transcript.md` sit untracked in the main checkout root; confirm with the owner which is current), and a new Da Vinci mailbox to create.

## 0. Read first (in order)

1. `docs/context/OWNER-ASKS.md`: every owner ask (#1–#57), by number. Add a row for every new ask, every turn, and answer by number.
2. This file.
3. `PRODUCT.md`, `AGENTS.md` (hard rules).
4. `docs/context/HANDOFF-2026-10-14-team.md`: staff/owner pane feedback (§2), gateway test (§6), Exa research (§7).
5. `docs/plans/2026-10-14-002-one-click-case-card-plan.md`: C1–C8 plan.
6. Memory index: `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/MEMORY.md`.

## 1. Prod state

| Thing | State |
|---|---|
| Prod | main `15e5bb63b`, deployed 16:03Z (batch) and ~16:25Z (#238). No migration pending (last: 0049) |
| Deploy | Only from `.worktrees/recover-parse-failure`: `git pull --ff-only origin main && git fetch origin main:main && bash apps/server-pilot/deploy/ops-deploy.sh`. Add `--migrate` only if a migration is pending. Exit 1 is normal if the only critical failure is `workflowDeadLetterBacklogEmpty` (24 h dead-letter gate). Warn the owner before deploys (live users) |
| Health after deploy | HTTP/HTTPS/TLS ok, pm2 http/worker/ai-worker online. Warning: `outboundNonterminalCount=2` (2 emails stuck in the outbound queue; not looked at) |
| Live check method | Admin is `https://nava-admin.trynava.io`. Grep live JS chunks for new strings; an existing tRPC route returns 401 unauthenticated, an unknown one 404 |
| HMS | Back up. Reads only on Centurion. Writes only with owner's `RESERVATIONIST_PANE_SAVE=on`; bot never accepts cancellation-penalty dialogs |

## 2. Shipped today (2026-10-14)

| PR | What |
|---|---|
| #225, #237 | Owner asks ledger, team handoff, run state, Exa summary |
| #228 | Room types |
| #227 | Pane replies with "missing details" when the email read falls back |
| #230 | Local CI: `scripts/ci/{local-ci.sh,queue-status.sh,worktree-bootstrap.sh}`. Run `bash scripts/ci/worktree-bootstrap.sh <worktree>` on every new worktree (links worktree-local node_modules; stale links gave false type errors today) |
| #235 | C3: nightly room stock + prices per night (`apps/server-pilot/src/ai/hms-availability.ts`) |
| #236 | C1: party-first quote card; answered questions drop off |
| #239 | **Save as gold**: nava-admin inbox pane "Nava reads this as" lists all 9 labels; saves owner gold label (`workflowFolders.setActionLabel`); reopening shows the saved label (`getOwnerActionLabel`, owner-only). Picking Quote/New booking also switches the workflow |
| #238 | Removed #234's marking layer from the Quote Desk (the desk itself remains, see §3 gap). Root cause of "stuck on the top email": row click wrote `threadId` and `sourceMessageId` in two awaited updates that raced. Now one update. Regression test clicks a second row |

## 3. Open follow-ups

| Item | Detail |
|---|---|
| **GAP: workflow folders aren't the normal inbox** | Owner ask (2026-10-14): clicking Quotes / New bookings / etc. in nava-admin should show the **exact normal inbox UI** (mail list + thread + Nava pane, with the Save as gold dropdown), just filtered to that folder. Today it opens a custom desk (`apps/mail/components/mail/workflow-folder-desk.tsx`, from #233-era PRs f92b41a17/13b6e19e5: list + read-as + extracted fields + lookup + "Review Nava" Right/Edited buttons). #238 only removed #234's extra layer. Do this first; likely: route the folder to the normal mail list with a folder filter from `workflowFolders.list`, then delete the desk |
| #230 P2 | `worktree-bootstrap.sh`: copy package links into a temp dir, then rename (an interrupted copy is accepted on rerun) |
| #235 | Nightly `available` can sit under a stay-level min/max LOS restriction (`tooling/playwright-quote/fetch-quote.mjs:491-496`). C5 must not treat nightly available as bookable. Departure-column closure never applied (minor) |
| #236 | `contact` counts as answered if any of attention/email/phone is set (looser than intended) |
| #238 | Selection test uses `NuqsTestingAdapter`, not the real router adapter |
| Outbound | 2 emails non-terminal in the outbound queue (deploy warning) |
| Gateway | One Luna teammate stalled in the team test; timeout/retry added but not retested |
| Extraction | Pep thread `2c54fa90`: request on 12 Oct for "12–15 October" extracted as **2027** |

## 4. Work queue (ROI order, for the scoping session)

| # | Work | Notes |
|---|---|---|
| 0 | Workflow folders = normal inbox, filtered (§3 GAP) | Small, owner-visible, unblocks labelling by folder |
| 1 | **Classifier coverage**: owner labels in nava-admin; score classifier on labels | Exa evidence: ~100 random emails per class for ±10 pts at 95%. Keep a random hidden test set apart from hard-case labels. ~10 labels only proves the flow |
| 2 | **C5 live pane** with owner/staff feedback (team handoff §2): per-night availability + price, one room-type control, totals once, one party row with HMS facts (rate plans, loyalty, account), lookup trace, clickable looks clickable | Needs C3 (shipped). Never remove Infor options (ask #49: add to PRODUCT.md) |
| 3 | Extraction year bug (§3) | Small, high trust impact |
| 4 | C4 party-scoped rates for every type × night (contract vs BAR) | Live HMS reads only |
| 5 | C6 background find for amend/cancel on strong identity | |
| 6 | C8 amend writer + cancel authorisation | Owner asks staff the cancellation questions (OWNER-ASKS §3) |
| 7 | nava-admin = production version of the hermes design | `https://hermes.trynava.io/designs/outlook-side-pane-demo.html` (v8; source `/home/orca/.gstack/projects/zero/designs/current-ui-showcase/outlook-side-pane-demo.html`). Plan with evidence first |
| 8 | Da Vinci onboarding + mailbox | Waiting on owner notes |
| — | C7 grouped create partial failure | Deferred by owner (low ROI) |

## 5. How to run

**Roles and cost** (API $/M tokens in/out): Opus 5.5 $4/$20 (cache read $0.20) leads only; GPT-6 Luna $0.10/$0.50 (cache $0.01) codes; Haiku 5.5 $0.10/$0.50 up to 100k context ($0.50/$2.50 above) reviews; GPT-6.1 Sol $2/$10 for hard reasoning. **Never Sonnet, never Nova Lite.** Today: Opus lead ~$30+ (biggest cost: long context re-read every turn), Sol ~$5.8, Luna ~$4.5, Haiku ~$1, Exa ~$2.

**Agent team (gateway, built today):**
- Start: `tmux new-session -s team -c "$PWD" claude-team` (`/home/orca/.local/bin/claude-team`).
- Model slots: `opus`→Opus 5.5 · `haiku`→Haiku 5.5 · `sonnet`→**GPT-6 Luna** · `fable`→**GPT-6.1 Sol** (Luna/Sol at reasoning `xhigh`; `max` is rejected). Raw names like `gpt-6-luna` silently become Opus (the `~/.claude/settings.json` `availableModels` allowlist; the launcher widens it).
- Gateway: LiteLLM on `127.0.0.1:4000`, `/home/orca/.local/share/nava-gateway/` (`bin/nava-gateway start|stop|status|restart`; per-request $ in `logs/usage.jsonl`). Doesn't survive reboot; `claude-team` restarts it. Plain `claude` is untouched (direct to Foundry, so Headroom on :8788 saves nothing).
- Use teams for parallel research/review/separate modules. Not for chains of dependent edits (multi-agent costs ~15× tokens; loses 39–70% on sequential tasks).

**Codex lanes (proven fallback):**
```
codex exec -m gpt-6-luna -c model_reasoning_effort=max -C <worktree> -s workspace-write --skip-git-repo-check -c multi_agent_v2=false -c features.collab=false -o <out> - < <brief>
```
Brief = shared rules (`/tmp/g3/common.md`) + task. Lanes don't commit; the lead gates (tests, oxlint), commits, pushes, opens the PR, replies to Greptile. Wake on finish with a `run_in_background` watcher on the `.out` file (nohup watchers don't wake you).

**Merge gate:** local targeted vitest + oxlint (`apps/mail/node_modules/.bin/oxlint`) + Greptile P0/P1 triaged. Greptile reviews on PR open only: ask `@greptileai review` after fix pushes; if no reply in ~15 min, validate with a Haiku review agent and merge. Two rounds max. Batch deploys.
**Tests:** always `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` first. DB tests only on the disposable local DB on `127.0.0.1:55601` with `CONFIRM_DISPOSABLE_TEST_DB=1` (URL in `/tmp/p2/lanes/*.md`). Full mail `tsc` needs `NODE_OPTIONS=--max-old-space-size=6144` and ~3 min; it has pre-existing errors, so compare changed files against the merge-base.

**Product process (owner rule):** before building a feature: evidence pack (gold inbound/outbound in `/home/orca/nava-research/corpus/2026-10-13/pdftxt/`, HMS facts, corpus counts) → staff / product-ROI / engineering lenses → one synthesis that says where the owner's idea is wrong → owner decides → slices ≤ ~400 lines. Agreeing without review is the worst failure. Skills: `nava-intake`, `nava-product-review`, `nava-team-lead`, `impeccable`, `/95-exa-agent` (Exa credits are free; use it a lot).

## 6. Hard rules

- HMS: reads only on Centurion. Never send email. Never delete data. Never run `write-ec2-env.sh`. Never pilot RDS.
- Never force-push main, never `--no-verify`, commit/push only on exit 0. No bare `git stash`.
- GitHub Actions only for the Outlook VSTO installer. Adding any workflow or GitHub check needs the owner's OK (open decision: `local-ci/presubmit` status posting, ask #25).
- Keys/PII on this box are OK (POPIA/GDPR, NDAs). Never send secrets to external services or commit them.
- Replies: caveman + ADHD style, $ by model, ETAs logged in `~/.claude/eta-ledger.jsonl`.
- Design: evolve the real pane; reference images are mood only. Any pane feature = Outlook pane + webmail panel.

## 7. Owner preferences (learned the hard way today)

- Owner voice-dictates: parse each long message into a numbered task list first, flag likely mis-transcriptions ("heard X, assume Y").
- Focus on WHAT to build (scoping, research, pushback) over HOW.
- Push back with evidence; never agree to a design change unreviewed.
- Parallelise on cheap models; Opus coordinates only. Small PRs, frequent.
- Be clear about what's verified live vs only tested locally.

## 8. First steps for the fresh session

1. `ListAgents` + `pgrep -fa 'codex exec'`: confirm nothing else is running in your files.
2. `gh pr list -R kufupa/Zero`: expect no open PRs from today.
3. Ask the owner how Save as gold went (labels saved?), then start scoping: owner scope change → Da Vinci notes → mailbox → re-rank §4 with `nava-product-review`.
