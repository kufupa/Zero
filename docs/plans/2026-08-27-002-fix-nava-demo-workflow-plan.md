---
title: "fix: Nava investor demo workflow TUI"
date: 2026-08-27
type: fix
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# fix: Nava investor demo workflow TUI

## Goal Capsule

Replace the current “jump straight to thin KPI board + hang on Gemini” `./scripts/nava` experience with a **fake hackathon demo**: correct big **NAVA** wordmark, connected-mailbox corpus intro, analysis prompt, fake REP/context packing + subagent deploy animation, then a **Hermes-derived rich scrollable dashboard**. Live Gemini is optional (`NAVA_USE_PRIME=1`), not the default path.

## Product Contract

### Requirements

- **R1.** Opening screen shows connected mailbox + corpus totals only (2 mailboxes / 3268 msgs / 2403 threads / 2957 inbound). No triage mix yet.
- **R2.** Next step prompts how to analyze (census → full-thread review → tool demand) and waits for Enter.
- **R3.** Fake analysis process: context/REP packing (18 batches), subagent table progressing to done.
- **R4.** Final board is richer Hermes analysis content: attention mix, harmonized source-family view, Luna routes/human-lock, HITL locks, ranked reads, security≠spam note. Still no fake money.
- **R5.** Wordmark reads clearly as **NAVA** (not MAVA) in blue block letters with underline bar; Cantic-like density OK.
- **R6.** Enter advances demo stages. `q` quits. Footer text matches stage meaning. Default launcher does **not** exec Gemini (opt-in via `NAVA_USE_PRIME=1`).

### Scope Boundaries

- In scope: TUI/demo script, view rendering, launcher default, tests, PTY smoke.
- Out of scope: real subagent orchestration, live Gemini reliability, renaming Prime Agent binary, Orca codec install.

## Planning Contract

### Key Technical Decisions

- **KTD1 — Fake process, real numbers.** Stage animation is scripted; numbers come from frozen census + Hermes analysis artifacts (tracked analysis MD + private follow-up aggregates copied into frozen constants so demos don’t require follow-up ACL).
- **KTD2 — Stage machine in TUI.** `boot → corpus → plan → pack → agents → dash`. Enter advances; pack/agents auto-tick on a timer then pause for Enter if needed.
- **KTD3 — Gemini opt-in.** Default `scripts/nava` exits after TUI. Broken Flash hang must not block investor demo.
- **KTD4 — Harmonize source families.** Map synonym labels (`security_quarantine` / `security/quarantine`, SynXis variants, etc.) into one exclusive-partition table summing to 2403 threads.

### Assumptions

- Investor demo may be fully fake for process; product numbers must stay honest to Hermes corpus analysis.
- Prior thin FTE board remains as data source for mix/tools/hours; demo wraps and expands it.

## Implementation Units

### U1. Correct NAVA wordmark

**Goal:** Block logo reads NAVA with underline bar.  
**Files:** `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts`, `apps/server-pilot/tests/nava-fte-dashboard-view.test.ts`  
**Approach:** Replace broken 3-line glyph with 5-row dense `█` font for N/A/V/A + full-width bar. Assert stripped text contains distinct NAVA shape tokens / does not look like MAVA-only.  
**Verification:** Unit test strips ANSI and expects `NAVA` subtitle + multi-line block mark.

### U2. Demo stage script + renderer

**Goal:** Pure functions for each stage’s board text and footers.  
**Files:** Create `apps/server-pilot/src/ops/nava-demo-script.ts`, test `apps/server-pilot/tests/nava-demo-script.test.ts`; modify view helpers as needed.  
**Approach:** Export stage ids, `renderDemoStage(stage, dashboard, opts)`, agent rows, REP pack lines. Corpus stage has no mix; dash stage includes rich sections.  
**Test scenarios:** corpus omits stay-human mix; plan mentions subagents/REP; dash includes source-family + human-lock + no £.

### U3. Hermes-rich dash content

**Goal:** Final stage includes harmonized source-family partition + Luna route summary from analysis.  
**Files:** `apps/server-pilot/src/ops/nava-fte-dashboard.ts` (frozen extras), view/demo script, tests.  
**Approach:** Add frozen `sourceFamilies`, `lunaRoutes` constants derived from Hermes analysis/follow-up aggregates. Render under dash stage.

### U4. Staged TUI + launcher

**Goal:** TUI advances stages; launcher skips Gemini by default.  
**Files:** `scripts/nava-dashboard-tui.ts`, `scripts/nava`, `apps/server-pilot/tests/nava-launcher.test.ts`  
**Approach:** Enter → next stage; agents stage animates statuses; `q` exits; `NAVA_USE_PRIME=1` required for Prime exec. Footer: “Enter continue” / “Enter finish” not “start Gemini”.  
**Verification:** Launcher test asserts skip-by-default; PTY smoke sees NAVA + corpus then can quit.

## Verification Contract

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` then Vitest for demo script, view, launcher.
- Non-TTY `./scripts/nava` still prints markdown summary exit 0.
- PTY: logo NAVA, corpus counts, footer without “start Gemini”, quit with `q`.
- No ApiError path required for default demo.

## Definition of Done

- Investor can run `./scripts/nava` and walk Enter through process to rich Hermes board without Gemini hang.
- Logo is NAVA; workflow matches original office-hours intent (data → analyze → agents → dashboard).
