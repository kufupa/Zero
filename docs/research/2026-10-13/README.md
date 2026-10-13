# Research library — 2026-10-13 (Centurion, Nava AI reservationist)

**Read this before doing new research.** Each report states its method and how to re-run it. Numbers are tagged [M] measured or [I] inferred.

## Where the data lives (private, never commit)

| What | Path | Notes |
|---|---|---|
| Corpus snapshot (75 days of prod mail, attachments metadata, extractions, HMS reads, staff quotes) | `/home/orca/nava-research/corpus/2026-10-13/*.jsonl.gz` (VPS, mode 700) | Read-only export via SSM from prod RDS; script `/tmp/qm/snap/dump.cjs` (copy kept in `/home/orca/nava-research/scripts/`), S3 prefix `research-snapshot/2026-10-13/` |
| Every PDF staff sent (2,162) + text | `/home/orca/nava-research/corpus/2026-10-13/pdf/`, `pdftxt/` | `pdftotext -layout`; HMS `HRCEN_Confirmation_Letter_*` (1,174 = 655 reservations), `HRCEN_offer_*` |
| Analysis scripts per lane | `/home/orca/nava-research/scripts/<lane>/` | re-run commands in each report |
| Owner spot-check packs (10 per action class) | `/home/orca/nava-research/reports/r3-review/*.md` | masked; owner marks right/wrong |
| HMS answer key (reservation → company/agency/rate plan) | EC2 `/home/ubuntu/repos/zero/.private/party-truth-20261013/truth.jsonl`; copy `/home/orca/nava-research/testsets/party-truth.jsonl` | read-only one-process-per-conf `find` loop; 194 rows: 167 found (107 agency, 115 company), 26 not found, 1 failure. HMS search window reaches back only ~1 month |
| Earlier gold sets (Sep 15, unused until now) | EC2 `/home/ubuntu/repos/zero/.private/gold-fact-backtest-100/`, `gold-proposals/`, `hms-read-100-20260915/` | 100 cases + 93 KB tool catalogue |

Refresh the snapshot instead of re-querying prod: re-run the dump with a new date folder.

## Reports

| # | Report | One-line answer |
|---|---|---|
| R1 | [r1-quote-gold.md](r1-quote-gold.md) | 93 ask→staff-output pairs; 62% of quote asks mention meals; 31% miss dates; headcount-only 8.6%; staff quote BAR B&B in a PDF; dinner = add-on, amounts hotel-specific |
| R2 | [r2-party-truth.md](r2-party-truth.md) | HMS PDFs name a company/agency in only 30/1,179 → answer key must come from HMS reservation reads |
| R3 | [r3-workflow-truth.md](r3-workflow-truth.md) | 36.5% of non-channel inbound needs action (~38/day); agent vouchers are bookings not POP (0/35 POP); travel-agent domains stay in scope; extraction `booking` label flips 80% across re-runs |
| R4 | [r4-architecture.md](r4-architecture.md) | Live pipeline map; 4 competing classifiers; triage default Bedrock Nova Lite; Mastra reservationist agent backtest-only; 60k prompt cap without rationale; Da Vinci blockers (HRCEN gates, rules, rates, aliases) |
| R5 | [r5-ui-asks.md](r5-ui-asks.md) | 16 deduplicated pane asks: 3 done, 11 partial, 2 not done; proposed pane IA |
| R6 | [r6-agent-architecture-sota.md](r6-agent-architecture-sota.md) | Workflow spine per action + one bounded read-only lookup agent; writes never LLM-chosen; HITL edits → labels → per-action autonomy; per-hotel config |
| R7 | private: `/home/orca/nava-research/reports/r7-party-v2-score.md` (names client domains) | Party v2 offline vs HMS answer key (167 found rows): 95 emails / 27 domains, **0 wrong binds**; auto-bind 40% with no LLM pick, 76% with a perfect pick; truth in top-3 88–90%. Re-run: `tsx apps/server-pilot/scripts/party-v2-offline-score.ts` (defaults read the private testsets) |

## Session findings not in the reports (prod read-only queries, 2026-10-13)

- **Party prefetch (prod, direct mail):** 10 jobs → 0 clean: 7 zero rows, 2 ambiguous (Tourvest, Nexus Travel), 1 wrong bind ("Dire" → Directorate…). Causes: raw legal names, person names as company, no LLM pick, no normalisation on prefetch, sweep never ran (stopped 2026-10-09). Scripts: `/tmp/qm/prodmix/`.
- **Live HMS party search:** 10–27 s per kind, shares one HMS browser lock. Median staff reply to a quote ask ≈ 5 h (p75 21 h) → background lookups may take minutes. Scripts: `/tmp/qm/goldmix/`.
- **Gold outbound (60 days):** staff quote = short cover email + PDF ("Please see attached quotation… no rooms are currently being held"); 0 DBB rates quoted; 11/11 fully-booked replies are one-line declines with no alternative; staff never name the company in replies (0/210).
- **Staff quote runs:** 23/23 priced since Oct 8; staff_quote reads 6/18 refused (4 no BAR with dinner, 2 no rate covers every night).
- **Live HMS reservation record** exposes `ta1` (booking agency), `company`, `araccountname`, `rateplan`, `mealplan`, `roomtype`, `marketsegment`, `sourceofbusinessdesc`, `averagerate` in the form snapshot (`snapshotRecordForm`). Example: wholesale agency booking → rate plan `WSF2B`, segment Wholesale. Old readers `read-reservation-fields.mjs` (session_stub) and `read-reservation-codes.mjs` (not_found on departed stays) are broken.

## External sources used (decisions)

- Entity matching: Salesforce account matching rules; Splink blocking + term-frequency; pg_trgm word_similarity; Peeters et al. EDBT 2025 (LLM entity matching); review-band precision-first auto-link. Conclusion: retrieve candidates, one LLM pick with a "none" option, verify live, auto-bind only above a high bar.
- Building with coding agents: Claude Code best practices; Anthropic "effective harnesses for long-running agents", "demystifying evals"; Hamel Husain evals FAQ; METR 2025 RCT (felt +20%, measured −19%). Conclusion: pass/fail check first, small slices, evals from real failures define done.
- Claude Code features: Stop hook as done-gate, subagent files, skills, saved workflows, `/loop`; skip agent teams/ultracode for overnight. Pricing: Opus $4/$20 per M; Haiku $0.10/$0.50 ≤100k, 5× above 100k.
