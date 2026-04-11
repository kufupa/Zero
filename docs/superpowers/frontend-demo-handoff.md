# Handoff: FE-only demo stabilization + backend leak fixes

## Scope user requested
- Audit `apps/mail` for remaining backend hits in frontend-only demo mode using feature map and upgraded model review.
- Keep demo UX/features working while blocking/short-circuiting backend-dependent paths in demo mode.
- Use iterative test loop with Chrome DevTools MCP, not just static inspection.
- Fix findings, retest, repeat.
- Ensure user-visible regression handling stays local/no backend in FE-only mode.
- Preserve existing non-demo behavior.

## What has been done so far

### Core objective outcome
- Main remaining backend leak on connection linking fixed (Gmail in Connections page no longer calls backend in demo mode).
- Additional a11y cleanup done for compose fields to reduce warning noise from DevTools.
- Runtime demo-mode detection hardened to avoid env-flag mismatch causing false negatives.

### Files changed

- `apps/mail/lib/auth-client.ts`
  - Added `linkSocialSafe(payload)` wrapper.
  - Wrapper returns resolved no-op when `isFrontendOnlyDemo()` true.
  - Non-demo path still calls `authClient.linkSocial`.
  - Prevents direct auth backend call from multiple UI paths.

- `apps/mail/components/connection/add.tsx`
  - Switched `handleLinkSocial` to use `linkSocialSafe`.
  - Keeps inline demo user feedback via toast for blocked action.
  - Removes direct `authClient.linkSocial` call on this path.

- `apps/mail/app/(routes)/settings/connections/page.tsx`
  - Reconnected reconnect flow to pass `linkSocialSafe` instead of raw auth client method.
  - Existing blocking logic for demo mode remains intact.

- `apps/mail/lib/demo/runtime.ts`
  - Expanded frontend-only env detection compatibility.
  - `isFrontendOnlyDemo()` now checks:
    - `VITE_FRONTEND_ONLY`
    - `VITE_ZERO_DEMO_FRONTEND_ONLY`
    - `ZERO_DEMO_FRONTEND_ONLY`
  - Helps prevent false negative demo detection depending on startup script env shape.

- `apps/mail/tests/demo-runtime.test.ts`
  - Added regression test for new env compatibility path in demo mode detection.

- `apps/mail/components/ui/recipient-autosuggest.tsx`
  - Added optional `inputId` / `inputName` props.
  - Wired `id` and `name` onto recipient input for form-field validation compliance.

- `apps/mail/components/create/email-composer.tsx`
  - Added explicit `id="compose-subject"` and `name="subject"` for subject field.

### Subagent-led flow completed
- Previous root-cause work used subagent to confirm: both UI paths were guarded, likely env mismatch.
- New fix implemented via shared auth wrapper and demo flag hardening.
- This is aligned with iterative user workflow request (test-fix-test).

## Chrome DevTools MCP test status (what was observed)
- `settings/connections` -> Add Connection -> Gmail click tested after fix.
- Backend endpoint `http://localhost:8787/api/auth/link-social` no longer observed in network calls after wrapper+detection updates.
- Form field warning (`A form field element should have an id or name attribute`) reduced after compose field changes.
- General console still shows unrelated canvas warning (`Canvas2D getImageData`).
- No active backend `link-social` errors seen in latest relevant run.

## Lint status
- Read-only lint check run on touched files returned clean.
- No lint errors reported for modified files involved above.

## What user asked that is special
- Preserve frontend demo behavior without collapsing functionality.
- Guard by frontend-only mode only (not globally).
- Backend hard-stop should remain for non-demo mode; demo should stay local.
- Use and retain tool-driven verification (DevTools MCP).
- Focus on handoff quality for next agent, no context assumed.

## What is still left (if anything)
- Full-sweep final verification pass across broader flows is still recommended:
  - all settings sections (general, privacy, appearance, labels, categories, danger zone)
  - thread actions (move, delete, compose, reply variants)
  - templates/drafts/notes create/read/delete paths
  - command palette and summary/AI fallback paths
- Optional: decide whether to address remaining Canvas2D warning (`getImageData` attribute hint) or leave as non-blocking.
- User previously asked for commits; this handoff step did not create/validate any new commit.

## Suggested next-session quick start
- Open app in FE demo mode and rerun full action matrix with DevTools:
  1. open connections reconnect/add flow
  2. send/reply/snooze/archive/mark read
  3. template create/delete, notes CRUD
  4. command palette query + details actions
  5. settings save/disconnect/disallow destructive flows
- Capture any remaining network hits to localhost backend and console errors.
- Decide commit grouping:
  - `feat(mail): guard social link in demo`
  - `fix(a11y): add missing form field ids/names`
  - optional `test(demo-runtime): env compatibility coverage`

## Known risk notes
- Hardening env check changed logic path; verify no unintended effect from custom scripts setting legacy env names.
- `linkSocialSafe` returns resolved value in demo mode; callers expecting thrown/rejected semantics should already tolerate blocked path via existing guards, but confirm in full flow.
