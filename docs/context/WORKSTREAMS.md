# Workstreams map

Updated 2026-10-14 ~22:40Z. Every workstream, ranked by ROI, with how confident we are that it is scoped and handled. Lane detail: `/home/orca/nava-research/reports/LANES-20261014.md`. Asks: `OWNER-ASKS.md` (rows 75–91). Facts: `FACTS.md`. Research index: `../research/CATALOG.md`.

Confidence key: **H** = scoped with a pass/fail check · **M** = scoped, evidence thin · **L** = idea or open question.

## 1. In flight (code)

| ROI | Workstream | State | Scope conf. | Next gate |
|---|---|---|---|---|
| 1 | **Quote pilot**: staff use the pane on live mail | 5 PRs: #242 dates/bookability, #243 folders, #244 eval capture, #245 PDF/reply match, #246 amend-card UI | **H** (owner defined "correct quote" + major errors) | Greptile P1 fixes → remote typecheck → merge L4→L2→L3→L1→L6 → one deploy → self-test past quote mails one at a time (11 test shapes) |
| 2 | Remote typecheck on EC2 | Done: `/home/orca/bin/remote-typecheck.sh`; baseline mail 62 / server 0 | H | — |
| 3 | Amend HMS writer (stays disabled) | #249, P1 fix (verify the save by reopening) | H | Merge → Labtest live probe of selectors |
| 4 | Party lookup v3 (55/95 today) | P1 lane: failure taxonomy + offline prototype | **M** (truth set n=1) | P1 report → answer-key proposal |
| 5 | Gateway: Luna at max effort | Staged config | H | Activate when lanes are idle |

## 2. Research / scoping

| ROI | Workstream | State | Scope conf. | Next |
|---|---|---|---|---|
| 1 | **Agent stack / staff workflow builder** (swap Mastra?) | R1, R1b, R4 done (none pass all gates; Sim copilot = paid key; Langflow = Python, no tenant isolation). R5 running: per-layer stack, OSS LangSmith replacement, mem0/Graphiti/Letta, per-hotel pattern, 10/10 ideas | **M** | R5 → recommendation → ADR |
| 2 | Create flow (next after quote) | R2 write-flows audit done; create guarded, not prod-proven | M | Owner yes → lane |
| 3 | **GDS booking check** (merges old rows 3 + 4; owner 2026-10-19: build for Centurion and Da Vinci): every GDS/agent booking arrives twice (SynXis/Profitroom into Infor + agent voucher email). Staff check it landed, add the company (GDS download omits it), read notes, attach voucher, chase prepayment if same-day with no voucher | Centurion 30 d: SynXis 370 (224 new, 73 modify, 44 failed-to-integrate, 29 cancel), Profitroom 85, agent vouchers 15 (11/15 traced to CRS/staff mail). #118 routes vouchers to Payments (lane N). Evidence: [TMC voucher notices](../research/2026-10-19-tmc-voucher-notices.md) §2, §5, §6 | M | Scope after quote bar: read-only match voucher ↔ SynXis ↔ Infor stay + company gap; OWNER-ASKS #128 |
| 5 | Da Vinci (second hotel): per-hotel tenant + per-property HMS browser | Interview saved; generic pre-stay regex parked (`park/d1-prestay-20261014`) | L | Owner provides Infor login |
| 6 | Evals truth: golden set #218 + #244 capture | #218 open | M | Merge #218; connect #244 to it |
| 7 | Extraction v2 fields (every-ask coverage, meal/payer) | Parked `park/extract-v2-20261014` | M | Revive after the pilot |
| 8 | Case mix with OTA/SynXis rules applied | R3 = LLM analyst, unadjusted | L | Cheap re-cut with existing triage rules, only if a decision needs it |

## 3. Parked / later

- Cancel: waits for the owner's brief on Da Vinci's cancellation answers.
- Billing / payment proof: later; the 7.5% share is doubted.
- Profitroom computer-use agent: scope change (excluded host). Owner decides.
- Booking.com guest chats (Da Vinci): OTA rule says out of scope for now.
- Groups, multi-hotel onboarding, staff-teachable workflows: follow the agent-stack decision.

## 4. Needs the owner

1. Approve deleting the harvested worktrees (all on origin).
2. Create next: yes/no.
3. Da Vinci Infor login.
4. Cancellation brief.
5. Profitroom: in scope?
6. Framework: approve or veto the R5-based recommendation.
