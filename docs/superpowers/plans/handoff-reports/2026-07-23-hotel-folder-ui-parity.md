# Handoff: Hotel Folder UI Parity

**Date:** 2026-07-23  
**Branch:** `EC2-pilot` @ `b82b1798`  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Repo on box:** `/home/ubuntu/repos/zero`  
**Plan:** `docs/superpowers/plans/2026-07-23-hotel-folder-ui-parity.md`  
**Deploy:** `apps/server-pilot/deploy/ops-deploy.sh` (no `--migrate` — read-path only)

## Done criteria

| Criterion | Status |
|-----------|--------|
| Tasks 1–7 on `EC2-pilot` | PASS |
| FE vitest: presentation / search-filter / demo folder-map / demo adapter | PASS — 30/30 |
| Server vitest: `package-contract` + `mail-category-filter` | PASS — 8 pass; 3 skipIf (DB) |
| `FORCE_FRONTEND_ONLY_DEMO === false` | PASS |
| No triage/seed taxonomy edits | PASS |
| Live Folders: titles/subtitles/pastels/urgent stripe; managed ignore seed hex | PASS (code + unit) |
| Live list + detail pills from `categoryIds`; demo `centurionCategory` fallback | PASS |
| `mail.get` returns `categoryIds` + `categories` | PASS (T3) |
| Labels titled Labels, real collapsed collapsible | PASS (T5) |
| Category chips aligned with presentation map; filter still `categoryIds` | PASS (T6) |
| Hex consumer audit (live surfaces fixed or deferred) | PASS — see audit |
| Push + `ops-deploy.sh` + handoff | PASS |

## Deploy result

```text
HEAD on box: b82b1798 feat(mail): align category chips with hotel presentation map
health: {"ok":true,"service":"server-pilot"}
VPN_HARD_OK / HOTEL_PROBE_OK / VPN_HOTEL_OK
ops-deploy ok
```

## Commits (wave)

| Task | Commit | Message |
|------|--------|---------|
| T1 | `4e7ca602` | `feat(mail): add hotel folder presentation map and resolve helpers` |
| T2 | `9b2a9d4b` | `fix(mail): use hotel presentation map for live Folders nav` |
| T3 | `01b80bfb` | `feat(server): expose categoryIds and categories on mail.get` |
| T4 | `9e5e7fe8` / `8ec53cd6` | live pills from `categoryIds` + re-render on change |
| T5 | `96a17365` | `fix(mail): demote Labels with real collapsed collapsible` |
| T6 | `b82b1798` | `feat(mail): align category chips with hotel presentation map` |
| T7 | _(none)_ | Audit clean — no code delta |

## Hex consumer audit (U5 / Task 7)

Grep: `category.color|categoryColorNavTheme|getCenturionCategoryColorStyle` under `apps/mail` (excl. node_modules).

| Hit | Disposition |
|-----|-------------|
| `config/navigation.ts` | OK — managed → `getHotelFolderNavTheme`; unknown slug → hex fallback |
| `mail.tsx` CategoryDropdown | OK — managed → `getHotelPillColorStyle`; else `category.color` |
| `hooks/use-categories.ts` | OK — raw pass-through; consumers decide |
| `app-sidebar.tsx` | OK — passes `color` into nav builder; managed ignores |
| `centurion-category-pill.tsx` | OK — presentation colors |
| `hotel-folder-presentation.ts` / `folder-map.ts` | OK — map impl |
| `route-filter.ts` `categoryColorNavTheme` | OK — helper for unmanaged only |
| Settings `/settings/categories` | **Deferred** — nav item `disabled: true`; out of plan scope |

No remaining live managed-slug solid-hex UI.

## Divergence log

| Divergence | Why |
|------------|-----|
| No Task 7 code commit | Audit clean; brief says commit only if files changed |
| `mail-category-filter` skipIf | No local RDS; honest skip; package-contract still green |
| Manual browser smoke not run overnight | Unit + deploy green; visual smoke left for morning |

## Residuals (non-blocking)

- Settings categories page still uses seed/settings hex if ever re-enabled — route through presentation map before enable.
- Unrelated local `bedrock-adapter-contract` failure when full server suite run with wrong `pnpm test --` quoting — not part of this wave.
- Manual UI: Folders long titles/subtitles/pastels/urgent stripe; inbox + thread pills; Labels collapsed; chips match sidebar.

## Next morning (optional)

1. Hard-refresh `https://nava.legacy.local` — confirm Folders + pills + Labels.
2. If settings categories enabled later → presentation map for managed slugs.
