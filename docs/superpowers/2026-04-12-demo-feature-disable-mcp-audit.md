# 2026-04-12: Feature disable audit (MCP-driven)

## Scope checked

- Full email alias preset/label/editability
- Zero signature removal
- Undo send default
- Connections UI/backend behavior in FE demo mode
- Navigation shortcut removal

## Findings and fixes

1. Server hard-fail blocked all FE verification

- Problem:
  - Vite overlay showed `Server-only module referenced by client` from `app/root.tsx`.
  - App failed to load because `export { getServerTrpc } from '@/lib/trpc.server';` was still present in root route module and `@react-router/dev` treated it as client import.
- Fix:
  - Removed the export from `apps/mail/app/root.tsx`.
- Verify:
  - Re-started dev server and opened `/mail/inbox` successfully.
  - No 500 on `app/root.tsx` responses; app loads and renders full UI.

## Validation results

- Full email alias
  - `/settings/general` shows label `Your email address`.
  - Input is disabled.
  - Value is prefilled with `demo@centurion.local`.
  - composer dialog contains `fromEmail` as `<input type="hidden" value="demo@centurion.local" />`.
- Zero signature
  - No zero-signature settings visible on general settings.
  - Composer body no longer references signature UI string in visible text.
  - No active `zeroSignature` behavior in component tree checks for the inspected routes.
- Undo send
  - `/settings/general` shows `Undo Send` enabled (`checked`).
  - Defaults now enforce `undoSendEnabled: true` in both schema and settings normalization.
- Connections
  - Sidebar/settings navigation contains no connection links.
- `/settings/connections` initially rendered General due wildcard settings route fallback resolving missing section to `general`.
- Fix:
  - Updated `apps/mail/app/(routes)/settings/[...settings]/page.tsx` to derive section from `useLocation().pathname` rather than optional `useParams()`, preventing unknown sections from silently falling back.
  - `/settings/connections` now renders `404 - Settings page not found` in this environment.
  - This also fixes unknown paths like `/settings/zzzzz` to show explicit not-found text.
  - Network log shows no `fetch`/`xhr` requests for connection/trpc endpoints in FE demo mode.
  - No API calls observed for connections data on load.
- Shortcuts (navigation)
  - `/settings/shortcuts` lists only non-navigation groups.
  - `navigation` scoped shortcuts are absent.
  - Keyboard probe: `g` then `d` leaves URL at `/mail/inbox` (no navigation jump).

## Open non-blocking notes

- Current console noise is unrelated to the feature changes:
  - canvas warning from browser runtime
  - existing Radix dialog aria-description warnings
- No further critical FE breakage observed after fix.
