---
title: "Nava pane: web-only UI edit plan (no installer)"
type: plan
date: 2026-10-08
status: draft for approval
supersedes: 2026-10-08-005-outlook-pane-ui-plan.md (decisions kept, scope cut to web-only)
---

# Nava pane: web-only UI edit plan

## 0. TL;DR

- Ship the whole look and flow as web code (`apps/mail`). No add-in build, no staff download.
- Two things stay native until a new add-in build: the grey strip words ("Nava AI Reservationist") and the operator pairing dialog.
- Before a deploy counts as green, fix the launch-readiness failure (`outboundBacklogEmpty`). Health checks pass; the script still exits red.
- Four PRs, each deployable alone: A copy and names, B shell and first run, C quote tool, D visual system.

## 1. Where things stand (verified 2026-10-08, ~12:40 UTC)

| Item | State | Evidence |
|---|---|---|
| Web main | `678b2ef6`, merged #55 at 12:34Z | `git fetch origin main` |
| Add-in builds | Centurion runs 1.0.14 (per PR bodies). 1.0.15 = PR #6 (denied-request reason text). 1.0.16 = PR #7 (STA fix), pinned by Zero PR #54 (merged 12:28Z). 1.0.16 is not released (no tags or releases) | add-in PRs #6, #7; Zero PR #54 |
| Native self-enroll, folder report, strip rename | Not built. Not in 1.0.15 or 1.0.16. Add-in dispatcher only has LIST_FOLDERS, GET_FOLDER_EMAILS, CREATE_FOLDER. No server route for folder report or self-enroll | checked add-in main and Zero `apps/server-pilot/src` |
| Web deploy | `ops-deploy.sh` builds the SPA and passes health, then fails at launch-readiness. Last four runs (w7 to w10) end `NOT_READY`, critical `outboundBacklogEmpty`. No run printed "ops-deploy ok". Live state of #50 and #55 is likely but unconfirmed | `/tmp/w7..w10-deploy.log` |
| Luna plan | Newest is v6 (10:00 UTC). No v7 exists | `docs/plans/2026-10-08-003-luna-plan-v6-folders-and-followups.md` |
| Open PRs | Zero #48 draft, "do not merge yet", edits `page.tsx` and `quote-workflow-panel.tsx`. Zero #2 and #3 stale. Add-in: none open | `gh pr list` |
| Claude CLIs in this worktree | 1528010 (v6 builder, up since 08:47 UTC), 1568000 (this session), 1573256 (since 10:32 UTC, unidentified). Nothing touched | `ps` |

## 2. Ground rules

- Web-only. Touch `apps/mail/app/(routes)/outlook-pane/`, `apps/mail/components/quote-workflow/`, and matching tests. No add-in code. No new server routes.
- Must work on every installed add-in build. Gate on the PING `version` string, not `bridgeProtocolVersion` (always 4).
- Staff-facing brand is "Nava". Never "Nava AI" in UI. The wordmark may be "NAVA".
- Never "Luna" in staff-visible text. Code identifiers can keep `luna`.
- Staff only install, click, sign in. No PowerShell, no scripts (Luna plan v6:147).
- Plain copy, one sentence per message (v6:99-100).
- Test the new-user journey end to end on a fresh browser profile before calling it done (v6:31).
- Each PR deployable alone. Rollback = revert the PR and redeploy.

## 3. Decisions already made (in chat)

- Step bar: shown during first run only, hidden after. First run shows three steps: Welcome, Connection, Tour. "4. Quote Tool" leaves the bar.
- Tour: keep the three slides as they are. Staff read them. No Skip button anywhere.
- Quote tool: remove the sample card and the "Sample" pill. Replace with an empty state.
- Second name line in the pane is removed. Brand = NAVA wordmark + Centurion status.
- Status: one line replaces the yellow banner. System check moves into a ⋯ menu.
- Name: "Nava". "NAVA" in caps is fine for the wordmark.
- Never "Luna" in staff-facing copy.

## 4. Visual direction ("sexy", but practical at 380px)

Calm and confident. White pane, one strong colour (forest green), hairline dividers, generous spacing, subtle motion. Built on colours the pane already uses plus the demo's tokens.

### 4.1 Tokens

| Token | Value | Use |
|---|---|---|
| brand | `#1a4332` (hover `#123023`) | primary button, wordmark, active states |
| brand-tint | `#eaf4ee` | empty-state tile, Centurion pill |
| ink | `#1e293b` | body and headings |
| muted | `#64748b` | helper text |
| subtle | `#94a3b8` | footer and meta only |
| line | `#e2e8f0` | card borders, dividers |
| surface-2 | `#f8fafc` | status line, email card background |
| ok | `#15803d` on `#f0fdf4` | Synced, connected |
| danger | `#b91c1c` on `#fef2f2` | blocked. Not yellow |
| focus | `#059669`, 2px ring, 2px offset | keyboard focus |

Sources: the pane's current hex colours in [page.tsx](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx), and the demo tokens at [the demo](https://hermes.trynava.io/designs/outlook-side-pane-demo.html).

### 4.2 Type and spacing

- Font: Geist, already bundled in the app ([globals.css:1](https://github.com/kufupa/Zero/blob/main/apps/mail/app/globals.css#L1), [:23](https://github.com/kufupa/Zero/blob/main/apps/mail/app/globals.css#L23)). Verify the pane actually renders it. Your screenshots look like a system font.
- Sizes: 11 for labels (uppercase, tracking 0.08em, muted), 12 meta, 13 body, 15 section titles, 12 wordmark (caps, tracking 0.16em, weight 600).
- Weights: 400, 500, 600 only.
- Spacing: 4px grid. Pane padding 16px. Card padding 14px. Section gap 12px.
- Radius: cards 12px, buttons 10px, pills full.
- Shadow: cards `0 1px 2px rgba(15,23,42,.06)`. Primary button `0 1px 2px rgba(26,67,50,.25)`.

### 4.3 Components

- Header (48px): left, "NAVA" wordmark. Divider. Right, Centurion pill (tint background, emerald dot) and a ⋯ button (32px).
- Status line (40px min): surface-2 background, line border, 16px icon, 13px text, one secondary action ("Try again").
- Empty state: 48px brand-tint tile with a 20px brand icon, title 15px/600, body 13px muted, secondary link "How it works" (replays the tour).
- Email card: white, line border, 12px radius, card shadow. Subject 14px/600 truncated. Sender 12px muted. "Synced" pill in ok colours.
- Checklist ("What the quote needs"): 13px rows, 16px status icons, hairline dividers.
- Primary button: 40px full width, brand background, white 13px/600. Disabled = 45% opacity with a one-line reason underneath.
- Secondary button: white, line border, ink text, surface-2 on hover.
- Tour slides: same layout, recoloured to tokens.

### 4.4 Motion

- Screen change: 180ms ease-out, opacity plus 4px rise.
- Loading email: skeleton bars with a 1.4s shimmer.
- Status dot pulses only while connecting. Static otherwise.
- `prefers-reduced-motion`: no motion.

### 4.5 Avoid (from the design-review rules)

- Gradients, emoji, coloured left-border cards, icon-in-circle grids, centred body text, uppercase amber labels, Inter or system-ui as the primary font.

## 5. Screen spec (before to after)

Line numbers are on `678b2ef6`.

| State | Today | After |
|---|---|---|
| S1 Welcome | "Welcome to Nava AI" card, account block, "Confirm Account & Connect" ([page.tsx:1425](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1425), h1 at 1432) | "Welcome to Nava". Same card. Button wording is decision 2 (§12) |
| S2 Connecting | "Connecting to Nava AI Services", server and workstation rows, then Next ([:1464](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1464)) | "Connecting to Nava". Rows tick as each passes. Next appears only when all tick. No greyed-out button |
| S3 Tour | Three slides, dots, prev and next, final "Open Nava AI" ([:1556](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1556)) | Same slides. "AI" and "Luna" removed. No Skip. Final button "Start quoting" |
| S4 Quote, idle | Email context bar plus sample card ("Sample" pill at [:1667](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1667), "Sample data" text at [:1677](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1677)) | Empty state (§4.3). No sample |
| S5 Quote, reading | "Luna is reading the email…" | Skeleton card and "Reading this email…" |
| S6 Quote, email read | Email bar, "Luna's suggestions from this email…" ([:1676](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1676)), workflow panels | Email card, checklist, workflow panels restyled. Copy per §6 |
| S7 Draft ready | "Insert draft in Outlook" and a long helper ([:1733](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1733), [:1773](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1773)) | "Draft reply in Outlook" primary. One helper line: "Creates an unsent reply with the PDF. You send it from Outlook." |
| S8 Blocked | Yellow banner ([:1383](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1383)) and a four-row check list ([:1836](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1836)) | One status line with "Try again" and "Why?" (shows the failed check). Checks live in the ⋯ menu |
| M ⋯ menu (new) | Does not exist | Check connection, Replay the tour, Send feedback (mailto moved from the footer at [:1875](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1875)), About (add-in version from PING, Outlook version) |

Header (all states): remove the "Nava AI Reservationist" h1 ([:1332](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1332)). Show the NAVA wordmark and the Centurion pill. Status logic stays the same.

Step bar: first run only (switcher at [:1390](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1390)). Three steps. Hidden once `nava_onboarding_completed` is set ([:593-600](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L593)).

## 6. Copy rules and exact changes

Rules: "Nava" as the brand. No "AI" after Nava. No "Luna". One sentence. Verb-first buttons. Say what to do next.

| Before | After |
|---|---|
| "Welcome to Nava AI" | "Welcome to Nava" |
| "Connecting to Nava AI Services" | "Connecting to Nava" |
| "Nava AI server connected · Workstation API ping verified." | "Connected to Nava." |
| "Nava is connecting to this mailbox. If this stays, open an email in your Inbox." | "Connecting to this mailbox…" (Why? shows the Inbox hint) |
| "Luna's suggestions from this email. Check and correct them before running searches." | "Suggested from this email. Check them before you run a search." |
| "Luna could not read this email. Select it again and try again." (page.tsx:408) | "Couldn't read this email. Select it again or try again in a moment." |
| "Luna is reading the email…" | "Reading this email…" |
| "Select an email in Outlook. Luna will read it and list what the quote needs." | "Select an email to start a quote." |
| "Luna thinks this is not a quote request, so no quote was started." | "This doesn't look like a quote request, so no quote was started." |
| "Tell Luna what's wrong" | "Fix this reading" |
| "See what Luna saved in HMS" | "See what was saved in HMS" |
| "Luna fills the booking in HMS and checks availability. Nothing is saved." | "Nava fills the booking in HMS and checks availability. Nothing is saved." |
| "Sample data, not from a live email." | Removed |
| "Run system check" | Moves to ⋯ as "Check connection" |

Scope: about 50 lines mention "Luna" across the pane and quote components. Counts per file: `quote-workflow-panel.tsx` 15, `not-supported-list.tsx` 8, `booking-card.tsx` 7, `workflow-badge.tsx` 5, `amend-lookup-panel.tsx` 2, `quote-audit-screenshot.tsx` 2, `needs-answer-list.tsx` 1, `items-for-you.tsx` 1, plus page.tsx lines 408, 1676, 1711. Keep code identifiers such as `overlayLunaGroupsFromStaff` and `LunaAnalysisWire`. Change only the strings.

Tests that assert old wording (update in the same PR):
- `apps/mail/tests/outlook-pane-render.test.tsx:195-197`
- `apps/mail/tests/outlook-pane-onboarding.test.tsx:215,222`
- `apps/mail/tests/outlook-pane-auth.test.tsx:48` (negative assert, keep the intent)
- `apps/mail/tests/amend-find-panel.test.tsx` (many "Luna" strings)
- `apps/mail/tests/booking-card.test.tsx` (many "Luna" strings)
- `apps/mail/tests/e2e/helpers/real-mail.ts:34` ("Welcome to Nava AI")

Leave `construct-reply-body.test.ts` alone. "Nava AI" there is a sender name in email, not pane copy.

## 7. Compatibility with add-in builds

| Build | Where | Adds | Pane behaviour |
|---|---|---|---|
| 1.0.14 | Centurion (per PR bodies) | Operator pairing. STA bug | Same as today. Show an "Update Nava add-in" line only when capability reads fail and version is below 1.0.16 |
| 1.0.15 | PR #6 | Denied-request reason text | Same as 1.0.14 |
| 1.0.16 | PR #54 pin, not released | STA fix for GET_CAPABILITIES | Target |

- Read the version from PING. The pane already calls PING ([page.tsx](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx), runComprehensiveTest). PING returns `version` ([TaskPaneControl.cs:194](https://github.com/kufupa/nava-outlook-addin/blob/main/NavaOutlookAddin/TaskPaneControl.cs#L194)).
- Today's web gate is protocol-only ([use-outlook-bridge.ts:328](https://github.com/kufupa/Zero/blob/main/apps/mail/lib/workstation/use-outlook-bridge.ts#L328)). 1.0.14 passes silently. Any version-specific copy must read the string.
- Pane already shows an old-installer state for `updateRequired` or `bridgeProtocolVersion !== 4` ([page.tsx:1351-1352](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1351)). Keep it.
- Update download link: check `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe` before showing it. DNS does not resolve from my sandbox, so hosting is unverified.

## 8. Work breakdown (each PR deployable alone)

| PR | Scope | Files | Tests | Risk |
|---|---|---|---|---|
| A. Copy and names | "Nava" everywhere, no "Luna", no "AI" | page.tsx, about 8 quote-workflow components, tests in §6 | Update string asserts | Low, mechanical, large diff |
| B. Shell and first run | NAVA wordmark header. Three-step first-run bar, hidden after. ⋯ menu (Check connection, Replay tour, Feedback, About). Footer moves into the menu | page.tsx header, step bar, footer | Menu tests. Fresh-profile onboarding test | Medium |
| C. Quote tool | Empty state. Skeleton. Status line. Checks into the menu. Draft helper line | page.tsx tool screen (about 1645-1880), `quote-workflow-panel.tsx` | Empty, skeleton, blocked tests | Medium |
| D. Visual system | Tokens, type, cards, buttons, motion, scoped to the pane | Pane components and pane-scoped styles | 380px screenshot checks | Low to medium |

Order: A, then B, then C, then D. If #48 is revived, it conflicts with A and C. Settle #48 first.

## 9. Deploy and rollback

- Path: `ops-deploy.sh` ([it-handoff-runbook.md](https://github.com/kufupa/Zero/blob/main/apps/server-pilot/deploy/it-handoff-runbook.md)). The SPA builds in [deploy-ec2.sh](https://github.com/kufupa/Zero/blob/main/apps/server-pilot/deploy/deploy-ec2.sh). Then health, launch-readiness, VPN assert.
- Blocker: launch-readiness fails on `outboundBacklogEmpty` (critical). Health checks pass. Until this is understood, every deploy ends red even when the new code is live.
- Action (ops, not UI): find out what `outboundBacklogEmpty` measures and who owns it. Do not bypass readiness without sign-off.
- Diagnostics first (team rule for remote failures): ship visibility before any fix. Show which backlog item, its count, and its age. No fix and no bypass until the causal chain is confirmed.
- Rollback: revert the PR and run `ops-deploy.sh` again. For the visual switch in PR D, an env flag can give instant rollback if you want it.

## 10. Verification

- Unit: vitest for changed components. Extend existing test files.
- Visual: Playwright at 380px for S1 to S8 and M, using [`mounted-pane.html`](https://github.com/kufupa/Zero/blob/main/apps/mail/tests/browser-quote-workflow/mounted-pane.html). Compare against the demo.
- Fresh profile: clear `nava_onboarding_completed` in the pane's storage and run first run once, end to end.
- Prod smoke with a test staff account. No real-guest HMS writes (v6 rule). No sends from the pane.

## 11. Risks and open items

- The grey strip still reads "Nava AI Reservationist" until a native build. The web side cannot change it.
- Pairing is still operator-assisted. Self-enroll is not built. Copy must not promise self-serve connect.
- `outboundBacklogEmpty` blocks clean deploys (§9).
- 1.0.16 hosting is unverified from here.
- Install docs conflict. The call script ([docs/pilot/2026-10-08-call-script.md:50](https://github.com/kufupa/Zero/blob/main/docs/pilot/2026-10-08-call-script.md#L50)) says to stop on a 1.0.14 hash mismatch. The install doc ([docs/pilot/2026-10-08-install-and-onboarding.md:45](https://github.com/kufupa/Zero/blob/main/docs/pilot/2026-10-08-install-and-onboarding.md#L45)) gives the 1.0.16 hash. Fix before the next call.
- The self-signed installer cert changes on each CI run. Expect SmartScreen prompts ([runbook:32](https://github.com/kufupa/Zero/blob/main/apps/server-pilot/deploy/outlook-v4-security-release-runbook.md#L32)).
- Zero #48 conflicts with PR A and C.
- Peer session (Luna plan v4 review, bf89bc) is fixing "Luna cannot read emails in this pane yet". Its fix touches `apps/mail/lib/quote-workflow/{backend-bind,staff-quote-bind,amend-find,amend-cancel}.ts` and adds one new test, `apps/mail/tests/trpc-client-route-binding.test.ts`. PR A must not touch those files. `apps/mail/tests/amend-find-panel.test.tsx` is not theirs, so PR A may edit it. Rebase PR A after their PR lands. That fix may also change the error copy in §6.
- Unidentified Claude CLI (PID 1573256) in this worktree. Not touched.

## 12. Decisions needed

1. Visual direction: approve tokens and Geist as written, or prototype the look in the demo first?
2. Connect button wording until self-enroll exists. Proposal: "Connect this Outlook", with helper "Nava connects it with you."
3. Grey strip: accept "Nava AI Reservationist" until the next native build, or schedule a native build now? A native build means a staff download.
4. Who owns the `outboundBacklogEmpty` readiness fix?

## 13. Sources

- Demo: https://hermes.trynava.io/designs/outlook-side-pane-demo.html
- Pane code: https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx
- Add-in repo: https://github.com/kufupa/nava-outlook-addin
- Zero PRs: #50 (copy), #54 (1.0.16 pin), #55 (selected-email match). Add-in PRs: #6 (1.0.15), #7 (1.0.16)
- Luna plan v6: `docs/plans/2026-10-08-003-luna-plan-v6-folders-and-followups.md`
- Previous UI plan (superseded): `docs/plans/2026-10-08-005-outlook-pane-ui-plan.md`
