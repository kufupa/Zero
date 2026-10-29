# Pomerado and Infor: Codex attempt retrospective

**Status: paused on the owner's instruction. No Stay 360 integration has been published or replayed.** Native Pomerado reached the requested reservation and captured an observation with 40 named values plus its confirmation heading, and nightly rows. That observation is not a verified complete comparison or a reusable tool. Its guest data remains in the private trial directory.

**Later correction:** The owner challenged whether Pomerado should handle expiry itself. The pinned stock host already has `ensureSignedIn`, bounded automatic reauthentication, and `signedInAtEntry` logic that can continue where sign-in left the page when a load repeatedly loses the session. A local, non-browser simulation confirmed the last branch; the saved candidate contains no explicit `ensureSignedIn` call. The unpatched path has not been demonstrated on this Infor timeout or a fresh replay, and its detector's password-type assumptions merit checking. The retained-page fork refuses automatic recovery when its session check reads signed out. Prefer evaluating the native path first on explicit resume; keep the fork as an unproven fallback, not the presumed optimal solution.

This retro covers the prior trial and overnight work, today's Codex setup, and the local runs through the 16:23 UK pause. Earlier primary summaries: [27 October trial](2026-10-27-pomerado-trial-retro.md), [overnight comprehensive retro](2026-10-28-pomerado-comprehensive-retro.md), [current session investigation](../../research/2026-10-28-codex-pomerado-centurion-read.md) and [session-continuity research](../../research/2026-10-28-pomerado-hms-session-continuity.md).

## Outcome and what works

| Item | Evidence and limitation |
| --- | --- |
| Azure and Codex | Pomerado's four MCP tools connected to Codex; Azure provider checks succeeded. User selected GPT-6.1 Terra with xhigh reasoning for all roles. The isolated patched launcher also completed a four-tool handshake; the existing Codex MCP process needs a restart to load later launcher changes. |
| Reservation | Native sign-in and the exact requested Stay 360 record were observed in a mint. The private observation recorded 40 named values plus the confirmation heading and nightly rows. This is a screen capture, not publication, fresh replay, or proof that every possible field was covered. |
| Cause investigated | Separate local browser probes showed both a Pomerado-style root reset and an authenticated-page reload displayed the login form. Pomerado's host reset independently of the generated prompt. This supports a session-continuity issue, but does not prove Infor's internal cookie mechanism. |
| Changes | An isolated fork of installed canary source and a separate local runtime add an opt-in retained-page path, tenant/property checks, and accurate page-start context for Guardian. Earlier synthetic checks passed typecheck, build, 221 unit checks, and four browser checks; those earlier checks used a remote host before the owner clarified local-only. Later Azure-routing and Guardian-context Node checks passed locally. No live end-to-end validation has passed. |
| Retained work | Unpublished candidate source and cases were saved privately. The fork has uncommitted changes. The earlier Codex configuration was backed up. No new published Stay 360 MCP tool exists. |

## Attempts and elapsed time

Times are approximate UK local time; they are not a benchmark for a successful mint. Earlier trial from 27 October ran across a 3h47m46s window including planning, pauses and interruptions; overnight attempts also ended without a published and verified tool. The following are the latest local attempts:

| Start | Duration | Outcome |
| --- | --- | --- |
| ~15:00 | ~20 min | Signed in and drafted a tool; returned `build: incomplete`. Detailed terminal stop cause was not captured. |
| ~15:21 | Seconds | Our retry put the entire draft into the intent; the resulting description exceeded the 4,096-character schema limit. No useful mint occurred. |
| ~15:23 | ~12 min | Infor displayed a session-timeout dialog. Our local driver had closed stdin, so the pending Pomerado question crashed the driver and ended the attempt. |
| ~15:36 | ~20 min | Guardian rejected publication because a valid search with no match was classified as invalid input. The draft was revised, but the revision did not get fresh approval or publication. The Guardian's generic page-reset policy also needed correction to reflect the host's actual page-start state. |
| ~16:00 | ~14 min | Guardian raised further evidence and saved-search-state concerns. Infor's timeout recurred; the attempt ended `sign_in_unavailable`, without publication. |
| 16:17:51 | ~5 min until owner pause | Minter temporarily switched to high reasoning; Guardian stayed xhigh. An inspection script was created at 16:20:18 (2m27s after launch). File creation does not prove the detail inspection succeeded. The owner stopped the job before a result; high has no measured end-to-end speed result. |

The owner's stop was applied to the specific local job; its driver and server PIDs were subsequently absent and the owned browser exited. The latest draft and test cases were saved under `.private/pomerado-readstay/codex-centurion-20261028/live-draft-151330/`.

## What went wrong

1. **The host and Infor do not share a proven session lifecycle.** Prompting for click-only navigation could not stop the host from resetting the page. The retained-page change is synthetic-tested but unproven on a complete live mint. A later timeout produced `sign_in_unavailable`. Source suggests a possible mismatch between a password-only timeout dialog with a read-only user ID and Pomerado's recorded sign-in verification, but this precise cause has not been proved.
2. **Our orchestration caused avoidable failures.** The overlong intent and closed input channel were our mistakes. In earlier work, we added unrequested gates, interrupted a progressing run, and performed unnecessary setup on another host. The owner subsequently directed all work to this Codex machine; that direction controls future work.
3. **Observability arrived late.** Several incomplete outcomes initially hid their detailed reason. The earlier retrospective had already identified diagnostic capture as essential, but we repeated the problem and inferred too much from generated files and a running status. Private diagnostics improved later.
4. **Some Guardian feedback exposed real issues.** A missing reservation should return a declared not-found result, and a search should avoid leaving persistent search-tab changes. Guardian's static claim that every test resets the page was also inaccurate for the new retained-page path; the review context was corrected and locally tested. Neither a denial nor the correction proves the latest source is ready.
5. **Estimates failed.** Earlier fast completion forecasts omitted or underestimated auth recovery, authoring, review and replay. More than an hour of today's local attempts ended without publication. No measured successful end-to-end duration exists. Azure model spend for the full effort is unknown; prior $10.22 figures were partial illustrative list-price estimates, not an Azure bill. Public-only Exa Agent research reported $0.5001; this is not total project cost.

## What to do if explicitly resumed

1. Keep work local and keep Infor UI navigation. Diagnose timeout reauthentication in the host from retained evidence and a targeted, bounded test. Preserve the authenticated tab and verify the tenant/property; distinguish a failed check from successful recovery.
2. Test that behavior locally, including the timeout dialog and sign-in tracking, before another full mint. Do not disable Guardian or silently broaden write authority.
3. Reuse the saved candidate and run one observable mint with explicit progress, terminal diagnostics and correct user-input handling. Review the result, including normal not-found behavior.
4. Publish only after Guardian approval, then fresh-replay the exact reservation and compare visible fields and repeated rows with the private reference. Register the integration with Codex only after this succeeds; reload Codex to pick up MCP configuration when needed.

An existing deterministic Playwright path is a possible fallback, but it would not meet the requested Pomerado-mint acceptance by itself. Do not restart a mint or live hotel browser until the owner resumes the work.
