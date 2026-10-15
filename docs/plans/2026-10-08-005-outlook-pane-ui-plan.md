---
title: "Outlook pane UI: current state, post-v6 state, target UI"
type: plan
date: 2026-10-08
status: plan only, no code changed
---

# Outlook pane UI plan

## 0. Scope and checks

- Other Claude CLI: PID 1528010 (up since 08:47 UTC), transcript `728a2973-7b9f-48b4-bb74-d9b638d8cc5a.jsonl`. Building [Luna plan v6](2026-10-08-003-luna-plan-v6-folders-and-followups.md). Read-only inspection only, nothing sent to it.
- Demo: https://hermes.trynava.io/designs/outlook-side-pane-demo.html (screens: `screen-welcome`, `screen-diagnostics`, `screen-tour`, `screen-tool`). 380px screenshots: `/tmp/nava-shots-lSCOZk/` (temp, not in repo).
- Design audit: gstack design-review, audit-only. No fixes, no commits.

## 1. Current state: element to code

Line numbers are origin/main. Real pane = [apps/mail outlook-pane page](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx).

| On screen | Source | Notes |
|---|---|---|
| Grey bar "Nava AI Reservationist", chevron, X | [ThisAddIn.cs:66](https://github.com/kufupa/nava-outlook-addin/blob/main/NavaOutlookAddin/ThisAddIn.cs#L66) `CustomTaskPanes.Add(_control, "Nava AI Reservationist", ...)` | Outlook chrome. Web code cannot change it. Dock right, width 380 (ThisAddIn.cs:68-69). |
| Inner "N Nava AI Reservationist, ● Centurion" | [page.tsx:1332](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1332) h1 | Same name as the grey bar. Duplicate. |
| Yellow banner + "Refresh Outlook authorization" | [page.tsx:1383-1385](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1383) | Copy changed by PR #50, see §4 |
| Tabs "1. Welcome / 2. Connection / 3. Tour / 4. Quote Tool" | [page.tsx:1399-1401](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1399) | Demo has these as board chrome above the pane, not inside it |
| Welcome card + "Confirm Account & Connect" | [page.tsx:1457](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1457) | |
| "Suite Availability Request" + Sample | [page.tsx:717](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L717) | Fake fallback subject when no email is selected |
| "Insert draft in Outlook" (disabled) | [page.tsx:1733](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1733) | |
| Explainer text (3 blocks) | [page.tsx:1773](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1773), [page.tsx:1829](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1829) | Multi-sentence instructions |
| "Run system check" + 4 rows | [page.tsx:1826](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1826), [page.tsx:1839-1863](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L1839) | Rows = `testResults.bridge / activeEmail / folderTable / serverPing` |

## 2. Why two headers, why "Nava AI Reservationist"

- Grey bar = VSTO custom task pane title, set once in `CustomTaskPanes.Add`. [CustomTaskPane.Title](https://learn.microsoft.com/en-us/dotnet/api/microsoft.office.tools.customtaskpane.title?view=vsto-2022) is read-only.
- Inner header = web `h1`. Same string typed in two places.
- "Novel" / "Nazva": not in zero repo history (`git log -S "Novel Reservationist"` empty) or in add-in code search. Both bars read "Nava AI Reservationist" in code and in your screenshots. Likely a low-res misread. If you saw other text, send the build version.

## 3. Can we remove the grey bar?

No supported way found. Microsoft Q&A: Outlook has no built-in way to remove or hide the title bar ([thread](https://learn.microsoft.com/en-us/answers/questions/1054604/vsto-outlook-remove-title-bar-from-custom-task-pan)). Third-party Add-in Express can restyle Outlook regions, but that rebuilds the pane ([article](https://www.add-in-express.com/creating-addins-blog/howto-display-your-own-header-for-an-advanced-outlook-region/)). COM shared add-in route: [2013 blog](https://theofficecontext.com/2013/05/21/customtaskpanes-in-a-net-shared-com-add-in/), too big for now.

**D1: grey bar text (ThisAddIn.cs:66)**
- A) Keep "Nava AI Reservationist". ✅ no build. ❌ name shown twice.
- B) Rename to "Nava AI" (matches demo header). ✅ matches demo. ❌ needs VSTO build + installer upgrade.
- C) Blank title. ✅ might drop the name. ❌ untested, may still leave a bar.
- Risks: B and C need staff to upgrade the add-in. No server-side path.
- Assumption: demo brand is "Nava AI".
- **Recommendation: B in the next add-in build. Test C on a Windows VM first.**

## 4. State after plan v6

| Piece | Today (your screenshots) | After v6 deploy |
|---|---|---|
| Banner text | "Select an approved Outlook folder to continue..." | "Nava is connecting to this mailbox. If this stays, open an email in your Inbox." (PR #50 merged 10:30 UTC, deploy pending) |
| Banner button | "Refresh Outlook authorization" | "Try again" (same PR) |
| Folder approval | blocked | Server auto-approve (PR #51, open). Checks 2-3 should go green. Inbox read path not proven yet |
| Check 4 "Nava server reachable" | red | Expected green once checks 2-3 stop throwing (§5) |
| Grey bar text | "Nava AI Reservationist" | unchanged (needs add-in build) |
| Inner duplicate h1 | present | unchanged |
| Tabs inside pane | present | unchanged |
| Sample card, explainers | present | unchanged |
| Pairing UI | "requires a supervised operator code" | unchanged until 1.0.15. Planned: one "Connect Outlook account X to Nava?" dialog replaces StoreID combo + code box ([1.0.15 plan §2](2026-10-08-004-addin-1.0.15-plan.md)) |

Plan v6 fixes function and blocking copy. It does not touch the look.

## 5. Check 4 is gated by the same folder problem

- `runComprehensiveTest` runs PING, then GET_ACTIVE_EMAIL, then folder reads, then the server ping, in one try ([page.tsx:652-716](https://github.com/kufupa/Zero/blob/main/apps/mail/app/%28routes%29/outlook-pane/page.tsx#L652)).
- Native errors reject `sendCommand` ([use-outlook-bridge.ts:294-297](https://github.com/kufupa/Zero/blob/main/apps/mail/lib/workstation/use-outlook-bridge.ts#L294)). A rejected GET_ACTIVE_EMAIL jumps to the outer catch, so `serverPing` stays false.
- Server ping is a static `status: 'ok'` ([workstation.ts:977-983](https://github.com/kufupa/Zero/blob/main/apps/server-pilot/src/trpc/routes/workstation.ts#L977)). It does not check folders.
- Matches your screenshot: 1 green, 2-4 red.
- **Verify:** read the toast "System check failed: ..." text on that path. If it names approval, L1 fixes it.
- Copy bug: the label "Nava server reachable" implies the server is down. It isn't.

## 6. Design audit (gstack design-review, audit-only)

| Area | Demo | Real pane (your screenshots) |
|---|---|---|
| First impression | One header, one CTA per screen | Two headers, yellow banner, 4 tabs, red/green list |
| Trunk test | PASS | PARTIAL. Name twice, primary task unclear |
| Hierarchy | One CTA per screen | Main CTA disabled, two helper blocks compete |
| Instructions (more than one sentence) | Few | 3 explainers + banner. Breaks "omit, then omit again" |
| AI slop | None | None. Problem is clutter and duplication, not slop |
| Grade | Design B+, slop A | Design C, slop A |

Top findings:
1. Name shown twice. **High.** Inner h1 (page.tsx:1332) duplicates the grey bar.
2. Tabs inside the pane, always visible. **High.** Demo keeps them outside as board chrome.
3. Diagnostics in the main flow, 4 red rows. **High.** Staff sees failures they can't fix.
4. Explainer text. **Medium.** Three multi-sentence blocks.
5. Fake sample card. **Medium.** page.tsx:717 shows a fake subject with a "Sample" pill.
6. Check 4 label misleads (§5). **Medium.**

## 7. Target UI (uses only existing functions)

| State | Trigger | Shows | Hides |
|---|---|---|---|
| S0 Connect | first run, not paired | account card + one button "Connect this Outlook" | tabs, tour |
| S1 Connecting | paired, folders not approved yet | one line "Connecting to this mailbox..." + "Try again" | banner, checks |
| S2 Idle | connected, no email selected | empty state "Open an email to start a quote." | sample card, explainers |
| S3 Email loaded | email selected | request card (guest, dates, subject) + "Quote needs: ..." + primary "Run quote" | sample copy |
| S4 Quote ready | quote run done | availability/rate summary + primary "Draft reply in Outlook" | helper paragraphs |
| S5 Blocked | any native or server error | one-sentence cause + one action | the 4-row list unless "Check connection" is opened |

**Look:** one header (N logo, "Nava AI", ● Centurion). White cards. One green primary button per screen (demo token `--primary #1a4332`). Slate text (`#1e293b`). Emerald/rose only on status icons. 4px spacing grid. Works at 320-380px.

**D2: inner header (page.tsx:1332).** Remove h1, keep N logo + status row. ✅ no duplicate. ❌ 3 test assertions change. **Recommend yes.**

**D3: tabs.** Hide after onboarding is done. Keep Tour in a menu. ✅ less noise. ❌ staff who skip onboarding may miss it. **Recommend yes, first run only.**

**D4: system check.** Collapse to a "Check connection" row. Show only red rows with the specific cause. Decouple the server ping so each row reports its own result (`runComprehensiveTest`, page.tsx:652-716). ✅ honest rows. ❌ touches logic, needs its own PR and tests. **Recommend yes, separate PR.**

**D5: sample card (page.tsx:717).** Replace with empty state (S2). ✅ no fake data. ❌ none that matter. **Recommend yes.**

## 8. Test impact

- Title-text asserts: `outlook-pane-render.test.tsx:195-197`, `outlook-pane-onboarding.test.tsx:215,222`. Change if D2 lands.
- `outlook-pane-auth.test.tsx:48` already expects no title on the sign-in screen. Precedent for header-less compact layouts.
- `vsto-source-contract.test.ts:261` checks `CustomTaskPanes.Add` exists, not the title text. Safe for D1.

## 9. Sequencing

1. Now to 11:05 UTC: no UI edits. The other CLI owns `outlook-pane/page.tsx` (L2 freeze). Merge conflicts otherwise.
2. After freeze: small web-only PR for D2, D3, D5. Then D4 as its own PR.
3. Next add-in build (1.0.15): D1 title rename, pairing dialog from the 1.0.15 plan.
4. Later: 5th panel in the demo ("best UI"). Walk through S0-S5.

## 10. Open questions

1. Brand name in the pane: "Nava AI" (demo) or "Nava AI Reservationist" (today)?
2. OK to do the web-only cleanup (D2, D3, D5) after the v6 freeze?
3. Which Outlook add-in build is Centurion on? PING returns `version`.

## Sources

- Demo: https://hermes.trynava.io/designs/outlook-side-pane-demo.html
- CustomTaskPane.Title: https://learn.microsoft.com/en-us/dotnet/api/microsoft.office.tools.customtaskpane.title?view=vsto-2022
- Remove title bar thread: https://learn.microsoft.com/en-us/answers/questions/1054604/vsto-outlook-remove-title-bar-from-custom-task-pan
- Task pane guidance (title = add-in name, no suffix): https://github.com/OfficeDev/office-js-docs-pr/blob/main/docs/design/task-pane-add-ins.md
- Task panes: https://learn.microsoft.com/en-us/office/dev/add-ins/design/task-pane-add-ins
- Layout (20px margins, 4px grid): https://learn.microsoft.com/en-us/office/dev/add-ins/design/add-in-layout
- Navigation (touch sizes 32/44px): https://learn.microsoft.com/en-us/office/dev/add-ins/design/navigation-patterns
- Add-in Express header option: https://www.add-in-express.com/creating-addins-blog/howto-display-your-own-header-for-an-advanced-outlook-region/
- COM shared add-in: https://theofficecontext.com/2013/05/21/customtaskpanes-in-a-net-shared-com-add-in/
