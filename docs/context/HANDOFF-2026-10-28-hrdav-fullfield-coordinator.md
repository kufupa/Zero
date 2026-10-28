# Handoff: HRDAV full-field booking run, coordinator (2026-10-28)

You are the fresh Opus coordinator for this run. The planning chat (Pomerado-adjacent, ~01:20Z) handed over here because its context was large. State lives in the plan and this file, not in chat history.

## Read only these (do not re-research)

1. [Plan](../plans/2026-10-28-001-feat-hrdav-full-field-booking-plan.md): goal, U1–U5, lane briefs rules, ETA, risks. Also on branch `docs/hrdav-full-field-booking-plan`, [PR #658](https://github.com/kufupa/Zero/pull/658) (head `b85500879`).
2. [CMS Message Id codes](../research/2026-10-28-hrdav-cms-message-id-codes.md): 01 guest, 03 agency/company, never blank.
3. `PRODUCT.md` hard rules (auto-loaded). Skip the rest of ACTIVE.md history.

## Hold: nothing starts until the owner types "go" in THIS chat

Approvals are never relayed between sessions. The planning chat's "lgtm" is not a go.

**First message to the owner:** ask the two questions below, verbatim, with your recommendation. Then wait.

### Q1. Which real email becomes the live Labtest proof?

Context: read-only prod SQL, 2026-10-28 ~01:15Z, new-booking mails with an agency, ≥2 rooms and real child ages extracted:

| Mailbox | New-booking mails | Agency + ≥2 rooms | + child ages |
|---|---:|---:|---:|
| Faith `fkhumalo@` | 54 | 15 | **2** |
| `davinci@` | 45 | 6 | 1 |
| `epick@` | 55 | 10 | 0 |
| `adladla@` | 22 | 5 | 0 |
| `kmgidi@` | 31 | 0 | 0 |

- **Recommended:** coordinator picks one of Faith's 2 matches during prep. Its private copy goes to `.private/`, and the owner is shown only the shape (agency name, rooms, ages).
- Alternative: owner names a specific email.

### Q2. How does the Labtest copy reach the pane, and may it touch a real staff inbox?

The pane only knows the hotel from the mailbox the mail lands in. `navaai@` is the BCC collector with no hotel, so it won't work.

- **Recommended:** owner sends one new email (not "Forward", which mangles extraction) from their own address to `fkhumalo@`. Subject starts `TEST Nava Labtest –`; the body is the original text with the guest renamed "Proof Labtest", dates in 2027, and the agency name kept. Cost: Faith sees one test mail in her real inbox.
- Alternative A: same, but to `davinci@` (shared mailbox; more staff see it).
- Alternative B: coordinator inserts a copy of the message row in prod DB with guest and dates swapped. This is a **prod DB write** and needs explicit owner approval. No staff inbox is touched.

Letter recipient is settled: CMS Booker Email = `navaai@legacyhotels.co.za`.

## Already settled (owner, 2026-10-28)

- Models: L1–L3 coders `claude --model claude-fable-5-1 --effort xhigh` (= GPT-6.1 Terra; never Sol). L4 Codex Luna max (`codex -m gpt-6-luna -c model_reasoning_effort="xhigh"`). Coordinator Opus. Review: Greptile Apex once + coordinator reads every product diff. No Grok/Argon round.
- Greptile Apex yes. Triage unchanged. GEPA not now.
- One pass, 4 lanes (L1 write, L2 rates, L3 pane, L4 scorer), each owning its own files.
- ETA ledger row open: `hrdav-fullfield-run-20261028`, estimate 210 min longest chain (prep 15–20, lanes 75–110, gates 20–30, merges 10–15, deploy 15–30, U4 30–60). Close it at the end with `jq -c` append.

## After "go": order

1. **Flag preflight** on EC2 `/proc/<pid>/environ` for http/worker/ai-worker/remote-http: `HMS_JOB_QUEUE`, `HMS_PREFETCH_ENABLED`, `HMS_QUOTE_PREPARE`, `PARTY_MATCH_V2`, `HMS_DAVINCI_READS`, `HMS_DAVINCI_MAKE_QUOTE`, `PANE_WRITE_CREATE` (must stay `lab`). Report only; flips need owner go.
2. **Close idle Orca terminals and worktrees** (census lane is replaced by U5): terminals `term_a9284a30…`, `term_2cdb49b0…` (worktree `hrdav-field-census-20261028`) and `term_f56a78d7…`, `term_69c1fec3…` (worktree `hrdav-email-pairs-20261028`). Check each is idle first. Keep the census `.private/hrdav-census/` data.
3. **Baseline tests on clean `origin/main` (EC2)** for every test file listed in U1–U3 and U5. Known-red tests go into each brief as "pre-existing, ignore".
4. **Write 4 `BRIEF.md` files** (per plan "Lane briefs"): unit text, exact `file:line` anchors from the plan, shared contract, settled facts, do-not-read list, owned files, gates, budget line "check-in at 10 min".
5. **Launch 4 Orca worktrees** from `origin/main` with `--no-parent`: `hrdav-book-write-20261028`, `hrdav-book-rates-20261028`, `hrdav-book-pane-20261028`, `hrdav-field-parity-20261028`. Launch the coder with `terminal create --command`, wait `tui-idle` with `satisfied: true`, then send "Read BRIEF.md and execute it."
6. Check every lane ~10 min (process + PR state). Merge through `scripts/orch/merge-gate.sh`, order L1 → L2 → L3. One deploy via `apps/server-pilot/deploy/ops-deploy.sh` from a clean `recover-parse-failure` (record last-good SHA first). L4's HMS batch runs before U2 shadow and U4, and is done before 05:00Z.
7. **U4 live proof** per the plan's 7-check table. Max 2 tries; never accept a penalty dialog.

## Do not touch

- **Deploy gate (Pomerado coexistence):** before `ops-deploy`, check EC2 for an active `nava-pomerado-*` systemd unit. Pomerado's trial loads `tooling/playwright-quote/session-reuse.mjs` from `/home/ubuntu/repos/zero`, which the deploy swaps and pm2-restarts. If a unit is active, ask the Pomerado chat (terminal `term_5cfedd0a…`) for a gap. See the plan's "Pomerado run — coexistence rules".

- Pomerado terminal `term_5cfedd0a…` and the HRCEN browser.
- `dv-amend` worktree (#651, `amend-stay*.mjs`), `wt-avail` (`fetch-quote.mjs`), pane-demo and triage-shape worktrees, `hms-quote-letter-proof-20261027`.
- `recover-parse-failure` is dirty with other chats' docs: never stash or reset it. Deploy from a clean checkout of that path or ask.

## Hard rules (short)

No real-guest HMS writes (`PANE_WRITE_CREATE=lab`). Labtest writes are always allowed. No tsc or Vitest on the VPS (EC2 only). No GitHub Actions. No `--no-verify`. Never print secrets or `postgres://`. Raw guest data stays in `.private/` (mode 600). Nava never sends mail; the HMS letter goes to navaai@ only. Replies to the owner: caveman + adhd, cost in $ by model.
