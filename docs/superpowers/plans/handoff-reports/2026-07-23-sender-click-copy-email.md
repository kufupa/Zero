# Handoff: Sender Click Copies Email

**Date:** 2026-07-23  
**Branch:** `EC2-pilot` @ `2f72810c`  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Repo on box:** `/home/ubuntu/repos/zero`  
**Plan:** `docs/superpowers/plans/2026-07-23-sender-click-copy-email.md`  
**Deploy:** `apps/server-pilot/deploy/ops-deploy.sh` (no `--migrate` — FE-only)

## Done criteria

| Criterion | Status |
|-----------|--------|
| Tasks 1–2 implemented + committed on `EC2-pilot` | PASS |
| Vitest green: `copy-sender-email` + `demo-backend-guards` (no `resolveMailDisplayWebSearch` import) | PASS — 46/46 |
| Sender name click copies email + success toast; no More-about dialog | PASS (code + grep) |
| Details popover From: same copy behavior | PASS (code) |
| Empty email / clipboard failure handled (no success toast / error toast) | PASS (unit) |
| Recipient chip copy icon still works | PASS (`handleCopySenderEmail` reused) |
| Server `ai.webSearch` untouched | PASS (no server-pilot edits) |
| Pushed + `ops-deploy.sh` on EC2; handoff report written | PASS |

## Test evidence

```text
cd apps/mail && pnpm exec vitest run tests/copy-sender-email.test.ts tests/demo-backend-guards.test.ts

 ✓ tests/copy-sender-email.test.ts (3 tests)
 ✓ tests/demo-backend-guards.test.ts (43 tests)

 Test Files  2 passed (2)
      Tests  46 passed (46)
```

Grep `apps/mail` for `resolveMailDisplayWebSearch`, `MoreAboutPerson`, `setResearchSender`: **0 hits**.

## Deploy result

```text
== ops-deploy: sync bundle ==
HEAD on box: 2f72810c37 feat(mail): sender click copies email, remove More-about dialog

== ops-deploy: on-box deploy ==
server-pilot tsc: ok
mail SPA build: ok (warnings only — sourcemap/css chunk size, pre-existing)
nginx: configuration file test is successful

== ops-deploy: health ==
{"ok":true,"service":"server-pilot"}

== ops-deploy: VPN HARD assert ==
VPN_HARD_OK
HOTEL_PROBE_OK 172.24.0.10:25
VPN_HOTEL_OK

ops-deploy ok
```

Duration ~3m10s. No `--migrate` (schema unchanged).

## Commits (wave)

| Task | Commit | Message |
|------|--------|---------|
| T1 | `caa73212` | `feat(mail): add copySenderEmail clipboard helper` |
| T2 | `2f72810c` | `feat(mail): sender click copies email, remove More-about dialog` |
| T3 | _(this report)_ | deploy + handoff |

### File delta summary

**T1** — `apps/mail/lib/mail/copy-sender-email.ts`, `apps/mail/tests/copy-sender-email.test.ts` (+42 lines)

**T2** — `apps/mail/components/mail/mail-display.tsx`, `apps/mail/lib/demo/local-actions.ts`, `apps/mail/tests/demo-backend-guards.test.ts` (+44 / −401 lines)

## Divergence log

| Divergence | Why |
|------------|-----|
| Manual clipboard smoke not run overnight | Unit coverage + deploy green; browser clipboard needs human login |
| Playwright E2E omitted | Explicitly out of scope per plan |
| Build warnings on EC2 (sourcemap, css `where()`, chunk size) | Pre-existing; deploy succeeded |

## Residuals (non-blocking)

- Morning manual smoke: open thread → click sender name → `Email copied to clipboard` toast; no More-about overlay; details popover From: same; recipient chip CopyIcon unchanged.
- BIMI avatar click behavior unchanged (out of scope).

## Push

```text
git push origin EC2-pilot
411e41b8..2f72810c  EC2-pilot -> EC2-pilot
```
