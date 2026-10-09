# Mistakes to avoid

One entry per lesson: trigger, what happened, rule. Newest first. Add an entry whenever the owner corrects us or a fix fails.

| Date | Trigger | What happened | Rule |
|---|---|---|---|
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
