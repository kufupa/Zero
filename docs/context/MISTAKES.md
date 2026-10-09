# Mistakes to avoid

One entry per lesson: trigger, what happened, rule. Newest first. Add an entry whenever the owner corrects us or a fix fails.

| Date | Trigger | What happened | Rule |
|---|---|---|---|
| 2026-10-08 | Deployed a pane fix | Staff never reloaded the pane, so the fix never ran. A whole afternoon was lost | Check the staff bundle load in nginx. Ship a build stamp and auto-reload |
| 2026-10-08 | Tests used a fake tRPC client | The pane helpers silently returned `{}` in prod (#57) | Pane changes need a real-browser run against the real client |
| 2026-10-08 | Fixture seeded a raw Message-ID | Quotes never started for any email (P0, #55) | Fixtures use prod-shaped data. DB route tests run in CI |
| 2026-10-08 | Blamed folder approval without proof | 1.5h spent on #51. The real cause was an add-in thread bug | No fix without a confirmed causal chain. Ship error visibility first |
| 2026-10-08 | Built the agency picker before checking HMS data | Tourvest is a company, not an agency. The 360 search never applied its filter | Check data in the corpus and live HMS before building |
| 2026-10-08 | Asked staff to run PowerShell, then a `.cmd` | The owner rejected it | Never give staff technical steps |
| 2026-10-08 | Merged #56 with an open Greptile P1 | The fix path shipped untested | Block merge while a P1 is open on the head SHA |
| 2026-10-08 | Promised a "light watch" overnight | 118 minutes of dead air | Schedule wakeups of 25 minutes or less, and a Stop guard until the deadline |
