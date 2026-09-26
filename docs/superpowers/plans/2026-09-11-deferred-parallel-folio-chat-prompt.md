# Deferred handoff prompt — second Cursor chat

**Do not start this chat until** `hms_find_reservation` live video exists and Codex `01a0773e` is stopped. Parallel on the current dirty worktree is rejected (same `worker.ts` / `runtime.ts` / `read-service.ts` / `.hms-live-operation.v2.lock`).

Paste into a **new** Cursor Agent on a **new git worktree** branched from this one after Wave 0 lands:

---

You are in a new worktree. Codex session 01a0773e is stopped. `hms_find_reservation` already has a live PMS video.

Build **only** `hms_read_folio` as a live read-only tool + one private Playwright video.

Reuse:

- Existing folio contract in `apps/server-pilot/src/hms/` (do not redesign)
- The same live session factory that proved Guest Stay search (`createLiveGuestStayDriver` / `createHmsLiveProofRuntime`, Playwright 1.52.0 Chromium 1169)
- `view_only` credentials. No save, post, email folio, generate document

Cut (these burned five days on find-reservation):

- Isolated EC2 source copy as a proof gate
- Independent Luna/Astra review as done
- Trace ZIP sanitizer as a blocker
- Worker/tRPC enqueue / admission-issuer theater
- 210-test packaging before every live hit

Done: one real folio on a real stay, source/result comparison, private `video.webm` under `.private/` mode 0600, no secrets in git. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest. Never `VITEST_ALLOW_PILOT_RDS=1`. No Nava deploy/restart.

Plan style: `docs/superpowers/plans/2026-09-11-fast-live-find-reservation-video.md`. Caveman ultra in the chat. Code/commits normal prose.

---
