# Nava session entry

Checkpoint: 2026-10-14. Historical snapshot. Read `docs/context/ACTIVE.md` for the living entrypoint. This is not a substitute for PRODUCT.md or evidence. The assessment is complete; product readiness is not. Both independent staff/code reports returned and decisive claims were checked by the lead.

## Start here, not in transcripts

- Full assessment: [dated assessment](../research/2026-10-14-product-assessment.md).
- Current asks: [owner asks](OWNER-ASKS.md), new intake rows 58–74.
- Original early/mid-chat retro was recovered from parent transcript `33440ce7-6408-4198-a86f-61e722850de8.jsonl`, not the current session. Findings and locators are in the assessment.
- Existing research library: deployed-ref `docs/research/2026-10-13/README.md`. Do not commission another full corpus/retro scan by default.

## Product and latest owner corrections

- AI reservationist for Centurion, live with client. Shared classic Outlook/webmail pane. HMS is system of record.
- Core: quote, create, amend, cancel. Eventual roadmap also includes voucher/payment/billing, grouped rooms, repeatable next-hotel onboarding. Email-only; OTA booking operations excluded.
- Read → Prepare → Queue → Act → Review. Automatic reads; writes need explicit authority and staff approval. Never send email independently; never accept cancellation penalties.
- **Folders are not a new UI-reuse project. Existing normal folder/mail behavior, different action triage feeding it. No custom desk or redesign.**
- Gold labels: make correcting false positives fast, but do not turn unchecked rows into gold. Sample outside Quotes to find false negatives. Action labels, extraction facts and quote/write outcomes are separate judgments.
- Owner voice-dictates. Agent must parse/log asks, not ask them to repeat every requirement.

## Last verified state, refresh only the relevant delta

- Deployed product code: `15e5bb63b`, checked on EC2 2026-10-14 18:03:56Z. Remote main: `00c10fd21`, handoff-only PR 240.
- The source assessment worktree was parked Oct 6, 735 commits behind local main. Do not audit old on-disk product code as current. Use the deployed/current ref or an appropriate fresh worktree. Do not merge into active/dirty lanes.
- Admin HTTPS 200; backend health on 8788/8789 ok; four PM2 processes online.
- The shared pane bundle contains gold code; the owner control is enabled on normal webmail and defaults off for Outlook. Live mail-layout bundle still contains custom Quote Desk/Review Nava.
- Actual startup environment: preparation/matching flags set on http/worker/ai-worker, absent on remote-http. No runtime dotenv loading was found. The HTTP prepared-quote route checks HMS_QUOTE_PREPARE, so remote-http absence is a potential consumption gap; actual pane/backend host routing was not proved. Matching-flag absence on remote-http was not itself verified as a defect. Older build-stamp environment values do not by themselves prove old loaded code.
- Production-write flag absent on all four startup environments. Do not infer permission to write from existing HMS tools.
- Two stuck outbound messages were reported in handoff; their present count not rechecked. Current staff adoption and full price/write proof not remeasured.
- Historical golden action score 24/26, no create rows, dates unscored. Historical classifier agreement 77% medium; party picker no observed wrong binds on 95 evaluated emails, 57.9% auto-bind. Not full-product accuracy.

## How to work next

- Read the mandatory PRODUCT.md, ACTIVE.md, OWNER-ASKS.md, research README and AGENT.md in a single bounded call at the relevant current ref.
- Check roster, current git/remote/deployed revision and changes since this checkpoint. Read only changes relevant to the chosen slice.
- Preserve full roadmap, but execute one acceptance-tested workflow increment. One accountable coordinator; independent workers own explicit outputs/files.
- Local tests/typecheck/oxlint plus adjudicated Greptile findings. No GitHub Actions or new GitHub checks. One live HMS owner. Both surfaces need last-fix proof.
- Models: Luna for large corpora/implementation; fresh Haiku max for bounded review; lead for decisions and authorized live operations. No arbitrary hard context cap or new budget cap.
- Gateway aliases: Sonnet slot routes to GPT-6 Luna; Fable slot routes to GPT-6.1 Sol. Check routed model, not UI label. Existing direct Luna subagent route worked during this assessment.
- Do not add another memory framework, harness or review UI to solve missing continuity.

## Assessment result and next product work

- Original-chat Luna verification finished, including corrected prior-chat pointer.
- Staff/code reports returned. One redundant late auto-resume was stopped after its report arrived. Some returned claims were stale or misread the folder correction; only verified findings were integrated.
- Gold save persists owner labels, but the live folder query does not use them. Current action folders require a successful extraction, so unprocessed mail can be absent. Restore the existing normal folder experience, make one action feed authoritative, and test correction/visibility across all inbound.
- Coarse whole-chain active budgets are logged in the assessment: familiar folders/triage roughly 160–250 min; full quote roughly 470–940; core workflows roughly 1,600–3,100; full stated email roadmap roughly 3,100–6,200. Cumulative alternatives, not additive. Policy/access/traffic holds excluded. These are planning ranges, not guarantees.
- Price/availability freshness, write authority, cancellation policy and real staff usage still require new evidence, not a summary pretending they are known.

This dated snapshot is versioned alongside its evidence. The living ACTIVE.md is already imported by root CLAUDE.md. Context instructions do not themselves enforce behaviour; no hooks or runtime configuration were added. Refresh volatile facts rather than treating this snapshot as current production permission.
