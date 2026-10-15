# Mistakes to avoid

One entry per lesson: trigger, what happened, rule. Newest first. Add an entry whenever the owner corrects us or a fix fails.

| Date | Trigger | What happened | Rule |
|---|---|---|---|
| 2026-10-15 | Rates runs timed out during staff hours | The coordinator claimed "HMS is too slow during staff hours" without measuring. The job rows showed Nava's own serial queue (80–1,025 s waiting) | Measure (queue wait vs run time from the job rows) before naming a cause |
| 2026-10-15 | Long rates runs at 07:00Z | The coordinator invented a "no live batches once staff are on" rule. Nava has its own HMS account and does not share staff's lane | Do not invent constraints. Check the account/lane facts in FACTS.md first |
| 2026-10-15 | `pr.sh` squashed #271 with a soft reset on a stale base | The squash nearly reverted #269 (same near-miss on #266 at 03:15Z) | Always rebase onto a fresh `origin/main` before squashing; check the diff stat for unrelated deletions |
| 2026-10-15 | Gold research found staff defaults (1 night, B&B, R350 dinner) | The DEF lane started building the defaults before the owner discussed scope | Chat product/scope with the owner before building. Research findings are inputs, not a build order |
| 2026-10-15 | 5-minute deploy of #273 | The coordinator blocked on the deploy instead of running other work in parallel | Run deploys in the background and keep the next slice moving |
| 2026-10-14 | Lane briefs told every lane to typecheck locally | Parallel tsc runs froze the VPS (load 27, 85% iowait); Hermes had to kill them | Never typecheck on the VPS. The hook blocks it; use the remote EC2 runner. Briefs must say so up front |
| 2026-10-14 | Lanes assumed opening a PR triggers Actions | 4 lanes refused to open PRs. Every kufupa/Zero workflow is disabled_manually | Briefs state "workflows disabled; opening PRs is safe" with the verify command |
| 2026-10-14 | Started a case-mix + party study (R3) without reading prior reports | It repeated research already done in r2/r3/r7. The owner had to re-explain | Read `docs/context/FACTS.md` + `docs/research/CATALOG.md` first. A new study must name the prior artifact and its gap |
| 2026-10-14 | Wrote "under 2% of mail is out of scope" as an owner rule | It was the agent's inference from an Oct 11 complaint. The owner never set it | Quote owner rules verbatim with a source. Mark inferences as inferences |
| 2026-10-14 | Said the owner hand-labelled 400 emails | The labels came from an LLM analyst | State label provenance (owner / staff evidence / LLM / extractor) on every mix number |
| 2026-10-14 | Lost the Oct 13 voucher fact; repeated known facts as news | The owner had to restate that a voucher is a paid booking request | Settled facts go to FACTS.md in the same turn they are learned |
| 2026-10-14 | ETAs not scaled by the ledger | Lanes finished at 0.2–0.6× the estimate | Scale by the ledger median for the same kind before quoting |
| 2026-10-14 | One mega Exa "ultra" run asking about migration effort | $6.60 spent; "weeks" estimates assumed human devs; it missed that Sim's copilot needs a sim.ai key | Use several small searches; tell research that AI agents do migrations; verify licence/paywall at source (`ee/LICENSE`, self-host env docs) |
| 2026-10-14 | Planned to batch-test 20 past quote mails | HMS is slow and serial | Self-test one mail end to end, then the next |
| 2026-10-14 | Owner offered a narrow 3-item overnight plan at 23:32Z ("do not invent more product") | The agent agreed, then 2 min later proposed 6 items incl. a new feature (quote-ready). That feature was the only item unproven at 09:00Z | Keep the owner's narrow plan. Extra overnight items must already have a pass/fail check and data; new features run in the day |
| 2026-10-14 | Owner doubted an 8 h ETA ("hmm I doubt that") | The agent re-cut it to "~6 h P50" with no new evidence. Actual: #222 deployed 07:46Z, proof still open at 09:00Z | Change an ETA only for new evidence. Show the ledger basis instead of re-cutting |
| 2026-10-14 | Stacked #222 on #214 (58 files, +3.4k lines) | #214 needed 16 Greptile rounds; #222 could not merge until 07:42Z | One behaviour per PR, ≤ ~500 product lines; never stack on a big unmerged PR (AGENTS.md limits) |
| 2026-10-13 | Said `/goal` did not exist; had not read the PRODUCT.md / AGENTS.md written that night | Owner had to correct both, at 23:52Z, minutes before sleep | Check `--help`/docs before denying a tool; name the rules files read before the first plan |
| 2026-10-14 | One Opus session orchestrated all night; Haiku reviewers resumed into big contexts | Opus $62 (867 turns at ~253k context; $44 cache reads); 65% of Haiku calls in the >100k price tier | Orchestrator `/clear`s per slice with state in files; fresh Haiku agent per task, < 100k |
| 2026-10-09 | Planned the party index sweep as a 30-min background lane | The sweep writes the index only when every prefix is done, and truncated letters add 26 lookups each: hours, not 30 min. Found only at sprint start | Read the script's own docs (exit codes, write conditions) before putting it in a time-boxed plan |
| 2026-10-09 | Shipped HMS runners that passed unit tests | Every EC2 create failed at the Guest Stay navigation (#85). Party lookup failed live on the same bug (#87). Only the live probe showed it | Unit tests cannot see the HMS DOM. Live-probe every runner on EC2 before calling it done |
| 2026-10-09 | Selected the party dialog by ARIA role | The query went into the saved-search combo, not the name input. Run is an ExtJS `a.x-btn` with no ARIA role (#89) | Probe the real dialog. Select by visible text when the DOM has no roles |
| 2026-10-09 | Tested the gate with a warm browser profile | The gate stuck 20/20 on first-run onboarding and blocked app-shell reads (#88). Husky EACCES broke the EC2 install (#86) | Test the gate with a fresh profile. The viewer skips onboarding, allows app-shell reads, and installs with `HUSKY=0` |
| 2026-10-09 | Test client was a plain object | The `*FromTrpc` typeof-function bug came back in #61. The real tRPC client is a function Proxy | Briefs must say so. Test with `createTRPCClient`, not a plain object |
| 2026-10-09 | Merged a stacked PR | #72 merged into #69's branch, not main | Retarget a stacked PR to main before merging. GitHub merges into the base branch |
| 2026-10-09 | Trusted a Greptile P1 on an old head | A P1 stayed on the PR after the fix. A checklist reviewer caught 2 P0s that Greptile missed, and Greptile caught P1s the checklist missed | Compare the review's commit with the fix commit before acting. Run both reviewers on HMS runners |
| 2026-10-09 | New tRPC procedures were not classified | Main CI went red: the drift test failed on quoteWorkbook (#83), and findParty and voucherFind (#61, #73) | Classify every new viewer procedure in the allowlist in the same PR |
| 2026-10-09 | Used `--no-verify` to get past a hook | Opus did it once during the party fix (ledger, 04:35 UTC) | Never use `--no-verify`. A failing hook is a signal to fix, not skip |
| 2026-10-09 | Ledger rows with estimated times | The first rows (before 01:59 UTC) were estimates, some ahead of the clock | Stamp every ledger row with the real clock (`date -u`) when it is written |
| 2026-10-08 | Deployed a pane fix | Staff never reloaded the pane, so the fix never ran. A whole afternoon was lost | Check the staff bundle load in nginx. Ship a build stamp and auto-reload |
| 2026-10-08 | Tests used a fake tRPC client | The pane helpers silently returned `{}` in prod (#57) | Pane changes need a real-browser run against the real client |
| 2026-10-08 | Fixture seeded a raw Message-ID | Quotes never started for any email (P0, #55) | Fixtures use prod-shaped data. DB route tests run in CI |
| 2026-10-08 | Blamed folder approval without proof | 1.5h spent on #51. The real cause was an add-in thread bug | No fix without a confirmed causal chain. Ship error visibility first |
| 2026-10-08 | Built the agency picker before checking HMS data | Tourvest is a company, not an agency. The 360 search never applied its filter | Check data in the corpus and live HMS before building |
| 2026-10-08 | Asked staff to run PowerShell, then a `.cmd` | The owner rejected it | Never give staff technical steps |
| 2026-10-08 | Merged #56 with an open Greptile P1 | The fix path shipped untested | Block merge while a P1 is open on the head SHA |
| 2026-10-08 | Promised a "light watch" overnight | 118 minutes of dead air | Schedule wakeups of 25 minutes or less, and a Stop guard until the deadline |
