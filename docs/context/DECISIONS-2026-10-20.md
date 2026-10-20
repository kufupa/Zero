# Owner decisions and open questions, 2026-10-20 (architecture rethink)

Running log so nothing from the chat gets lost. Source: this chat; asks 155–160 in OWNER-ASKS.md.

## Decided by owner

| # | Decision | When |
|---|---|---|
| D1 | OK to switch quote scoring to "Nava prepared price vs staff same-day reply/letter" | ~11:00Z |
| D2 | OK to keep repricing old quotes too | ~11:00Z |
| D3 | OK to replace the ≥10-thread bar (agent-proposed, never confirmed) | ~11:00Z |
| D4 | Do NOT start the 3 quick UI fixes; research architecture + Infor order first, then design pane | ~11:00Z |
| D5 | Paid vs unpaid is the main split; unpaid (quote/provisional) first, paid amend/cancel second, both planned | ~11:00Z |
| D6 | Outside-voice reviewer = Grok 4.7 xhigh via grok CLI (never fast models) | ~11:00Z |
| D7 | Exa agent auto first for memory-layer question, longer run only if needed | ~11:00Z |
| D8 | HMS letter ≈ proforma; owner heuristic: letter within ±30 min of staff reply (data: median 12 min) | ~11:00Z |

## Open for owner

| # | Question | Default if no answer |
|---|---|---|
| O1 | Merge PR #424 (docs only) | Merge |
| O2 | Wayfinder (issue-tracker decision map) vs repo md decision log | Repo md (this file) + research md per lane |
| O3 | Client questions that corpus cannot answer (see chat) | Ask in today's call |
