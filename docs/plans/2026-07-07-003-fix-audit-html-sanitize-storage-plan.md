---
type: fix
origin: docs/superpowers/plans/handoff-reports/2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md
status: draft
---

# fix: Close audit-confirmed HTML storage and draft-wire XSS gaps

**Target repo:** zero (EC2-pilot)  
**Created:** 2026-07-07

## Summary

Close the two code gaps we can fix **today** from the overnight T3MP3ST audit — without War Room, inbound-mail PoCs, or transport-boundary research. Both are defense-in-depth: primary mail read path already sanitizes via `wire-compat.ts` + `processEmailContent`, but DB still holds raw inbound HTML and draft wire exposes raw `htmlBody`.

## Problem Frame

Pass 3 decompose and our verification agree:

- **Storage OPEN:** `persistInboundMessage` writes `parsed.htmlBody` unsanitized (`apps/server-pilot/src/mail/ingest/store.ts`).
- **Missed seam:** `toDraftWire` returns `r.textBody ?? r.htmlBody` with no sanitization (`apps/server-pilot/src/trpc/routes/draft-wire.ts`).

Primary FE rendering is already mitigated (`toParsedMessage` + `mail-content.tsx` → `processEmailContent`). These changes remove latent stored-XSS if any current or future path reads DB HTML without the wire sanitizer.

**Explicitly out of scope for this plan:** X-Zero-Mailbox forgeability, demo-mode `resolveMailHtml` parity, audit report edits, T3MP3ST tooling, open-signup policy, tRPC test shortcuts.

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | Inbound `htmlBody` persisted to Postgres must pass through `sanitizeEmailHtml` with `shouldLoadImages: false` before insert. |
| R2 | Raw MIME remains available via `rawMimeS3Key` for forensics — do not rely on DB `htmlBody` as the only archival copy. |
| R3 | Draft wire `content` must not expose unsanitized `htmlBody` when `textBody` is absent. |
| R4 | Existing `mail-html-sanitize.test.ts` behavior for read path must remain green; add tests proving the new write/wire boundaries. |

## Key Technical Decisions

1. **Sanitize at ingest, not only at read** — matches prior audit intent (storage-serving split). Use the same `sanitizeEmailHtml` helper as `wire-compat.ts` / `processEmailContent` for consistent rules.
2. **Ingest uses `shouldLoadImages: false`** — image policy stays user/session-driven at display time; ingest only strips active content.
3. **Draft wire sanitizes only the `htmlBody` branch** — when `textBody` is present, use it as today (plain text). When falling back to `htmlBody`, sanitize before returning `content`.
4. **No schema migration** — column semantics change (stored HTML becomes sanitized); acceptable for pilot; raw MIME in S3 unchanged.

## Implementation Units

### U1. Sanitize inbound htmlBody at persist

**Goal:** Close Pass 3 “storage path OPEN” for inbound mail at the source.

**Requirements:** R1, R2

**Dependencies:** none

**Files:**
- `apps/server-pilot/src/mail/ingest/store.ts`
- `apps/server-pilot/tests/mail-ingest-sanitize.test.ts` (new)

**Approach:**
- In `persistInboundMessage` transaction, before insert: if `parsed.htmlBody` is non-null/non-empty and contains HTML (`<`), run `sanitizeEmailHtml(parsed.htmlBody, { shouldLoadImages: false }).html` and store result; else store `parsed.htmlBody` unchanged (plain text / null).
- Import `sanitizeEmailHtml` from `../../mail/sanitize-email-html.js`.

**Patterns to follow:** `apps/server-pilot/src/trpc/wire-compat.ts` (`toParsedMessage` sanitization block).

**Test scenarios:**
- Happy path: malicious inbound HTML (`<script>`, `onerror`) persisted as sanitized `htmlBody` without script/handler tokens.
- Edge: `htmlBody` null → still null; plain text without `<` → unchanged.
- Edge: empty string → empty string.

**Verification:** New unit test passes; existing `mail-html-sanitize.test.ts` still passes.

---

### U2. Sanitize draft wire htmlBody fallback

**Goal:** Close alternate serving path where draft `content` could carry raw stored HTML.

**Requirements:** R3

**Dependencies:** U1 (shared helper; can land in parallel if helper import only)

**Files:**
- `apps/server-pilot/src/trpc/routes/draft-wire.ts`
- `apps/server-pilot/tests/draft-wire-sanitize.test.ts` (new)

**Approach:**
- In `toDraftWire`, when `r.textBody` is falsy and `r.htmlBody` is used for `content`, set `content` to sanitized HTML via `sanitizeEmailHtml(r.htmlBody, { shouldLoadImages: false }).html`.
- When `textBody` is truthy, keep `content: r.textBody` (no change).

**Patterns to follow:** U1 / `wire-compat.ts`.

**Test scenarios:**
- Happy path: draft row with `textBody: null`, `htmlBody` containing `<script>` → wire `content` has no script.
- Happy path: draft with `textBody: 'hello'` → `content` is plain text, unchanged.
- Edge: both null → `content` null/empty per current behavior.

**Verification:** New test file green; existing draft tests unchanged.

---

### U3. Regression guard on read path (optional tighten)

**Goal:** Document that read-path sanitization remains belt-and-suspenders after U1.

**Requirements:** R4

**Dependencies:** U1

**Files:**
- `apps/server-pilot/tests/mail-html-sanitize.test.ts`

**Approach:**
- Add one case: row with **already-sanitized** `htmlBody` from ingest still produces safe `processedHtml` via `toParsedMessage` (double-sanitize must not break layout).

**Test scenarios:**
- Ingest-sanitized HTML round-trips through `toParsedMessage` without re-introducing vectors.

**Verification:** Test passes; no production code change unless double-sanitize breaks tags (then adjust ingest check to only sanitize if raw contains disallowed patterns — defer to implementation).

## Scope Boundaries

### In scope
- U1–U3 as above.

### Deferred to Follow-Up Work
- **X-Zero-Mailbox runtime PoC** — needs forged inbound mail through real transport; not knowable statically.
- **Demo-mode `resolveMailHtml` hardening** — requires FE/server sanitization parity strategy; script-strip-only is insufficient vs `sanitizeEmailHtml`.
- **Audit handoff report restructuring** — documentation only.
- **Removing `wire-compat` read-time sanitize** — optimization only after U1 proven in prod; keep defense-in-depth for now.

### Outside this plan
- Production AWS probes, War Room sessions, cli-swarm reruns.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Sanitized stored HTML differs from raw MIME | Raw MIME remains in S3; document in commit/PR. |
| Double sanitization alters rendering | U3 test; ingest uses same helper as read path. |
| Draft HTML used for outbound send later | Outbound send paths should already treat composer HTML as user content; verify no regression in draft send tests. |

## Open Questions

None blocking — both units use existing `sanitizeEmailHtml` with established tests.
