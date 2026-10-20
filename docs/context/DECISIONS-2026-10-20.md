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

## Owner challenge 12:15Z (ask 161)

- Owner: "isnt that literally what mem0 / this open source stuff is built for?" (precedent retrieval for staff). Stale-source objection: mem0 maintainer link was a 2025 issue. Rule: **use only current (≥2026-04) evidence for tool decisions**; everything must be self-hostable; Letta + Graphiti "kinda makes sense".
- Action: Exa agent **ultra** run `agent_run_381441c270994597b6735bdff2a10013` (budget $40, ≤40 min), use cases U1 precedent retrieval, U2 sender knowledge, U3 request↔booking linkage, U4 hotel SOPs, U5 task scratchpad; 2026-dated sources only; includes "where previous run was stale".

## Owner decisions 15:30Z (ask 163)

| # | Decision | Note |
|---|---|---|
| D9 | Two end buttons, one intake/prefill: "Make quote" (default) and "Create provisional booking" | Supersedes single STAY flow |
| D10 | Lift D4 (UI hold) once the code-grounded plan (P1) is reviewed | Owner fills pane defaults when asked |
| D11 | Slice order: price grid, then party step | Same pane files → queued, not parallel |
| D12 | Labtest Infor check approved, test guest "Proof Labtest" 2027+ only | Find guarantee/deposit fields and how the confirmation email is sent |
| D13 | PR #424 merged (c4cdb56f5) | docs only |
| D14 | Stale PRs: close/supersede per P1 overlap list | — |
| D15 | Memory-framework comparison (mem0 OSS vs Mastra memory vs Hindsight) parked as ask 162 | L7 baseline kept for later |
| D16 | Code stack: Luna max implements → Grok 4.6 high review+fix → Greptile → Grok 4.6 fixes; Opus coordinates/merges/deploys; lanes visible in Orca | Grok 4.7 only as plan critic |
| D17 | No owner data labelling; truth comes from staff artefacts (HMS letters, quote PDFs, replies) | — |
| D18 | (owner 17:20Z) Grok orchestrator may merge, deploy and run live HMS scripts (deterministic only); replaces "Opus merges/deploys/live HMS". H1: `RESERVATIONIST_PANE_SAVE` stays `lab`. H3: close PRs #301, #308, #334. Coder Grok 4.6 high, reviewer Grok 4.7 xhigh (supersedes D16 stack) | AGENTS.md Writers row updated |
| D19 | (owner 17:25Z) Quote recall bar 95% was arbitrary; **≥85% quote recall is acceptable**, measured on a bigger n (target ≥100 independent outbound-grounded quote rows) instead of the 26-row test | Replaces the ≥95% quote/new_booking recall bar from the 2026-10-19 triage run for this plan |
| D20 | (owner 18:20Z) Da Vinci option **B**: DV ingest now (UDV lane: transport-only provision + generalised quarantine promoter), DV quote path next run. Planning session launches the Grok orchestrator itself via `orca-ide`; the orchestrator launches all its lanes via `orca-ide` | 3 of 5 DV mailboxes have no transport row; 3,422 DV mails quarantined in 30 d ([report](../research/2026-10-20-davinci-ingest-quarantine.md)). Prod row write + promotion stay owner holds |
| D21 | (owner ~18:45Z) Multi-mailbox DV mail: no accepted quarantine. Fan-out, one `message` row per named hotel mailbox (To/Cc/Bcc/From), no migration (plan UDV-2). Row `e0e0f8dd` ruling **A narrow**: internal staff asks to quote/book/amend/cancel a guest stay are that action (plan U5r) | 1,265/3,422 DV mails name 2–4 boxes; held-out misses 6/8 internal staff |
