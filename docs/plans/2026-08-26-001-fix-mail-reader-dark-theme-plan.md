---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
plan_depth: standard
date: 2026-08-26
---

# fix: Dark-theme mail reader follows app chrome

## Goal Capsule

Make the Zero mail reading pane follow the user's app theme. Dark theme must not paint a full-height white paper behind every message. Keep sanitized Outlook/HTML mail readable: unstyled text inherits the host, and leftover paper `bgcolor` must not recreate white-on-white.

- **Authority:** User screenshots (dark = white slab, light = seamless) plus RCA of `f347321e` (`fix(mail): isolate legacy content from dark theme`). Pilot-RDS safety overrides convenience. Do not reintroduce `fixNonReadableColors` or user-email CSS allowlisting.
- **Execution profile:** Display-only. Stored MIME, sanitizer allowlists, and outbound wrap stay unchanged. Proof is unit + isolated Chromium fixture, not pilot RDS.
- **Stop conditions:** Stop if a proposed fix mutates stored HTML, allowlists `style=` on inbound mail, or walks the DOM to rewrite arbitrary colors. Those are the rejected 2026-08-23 isolation alternatives.
- **Tail ownership:** Implementation owns tests and code review. Commit, PR, and deploy remain user-directed.

## Review disposition

Paired gate on this artifact (independent subagents). Completeness wins over selector shrinkage. Simplicity wins on extra files and extra server tests.

- Eng ([review](5dd08e58-b002-42da-aad9-5eb5b62273a9)): approve-with-fixes. **Accepted:** shadow write depends on `processingTheme` (C1); paper selectors use CSS `i` plus hashless hex twins (C2); Playwright fixture uses `#FFFFFF`; no `placeholderData`; residual tinted contrast stays named.
- Ponytail ([review](c7752432-9de6-495b-9291-8b54b438f566)): cut new neutralize module if one caller; cut `colorScheme` host override; skip extra dark quote test (`collapse-quoted-html.test.ts` already locks `#313131`). **Accepted:** no host `colorScheme` (inherit `html` from next-themes); no extra server-pilot quote test. **Rejected:** “only `[bgcolor="#ffffff"]`” — Outlook `#FFFFFF` is R4, not YAGNI. **Module kept:** Playwright + `MailContent` are two callers.
- Design ([review](8f36c416-30f5-472a-a8a2-c9118a09f985)): 8.4/10. **Accepted:** `html.dark` when `resolvedTheme` unset (kill A1 white flash); Playwright AE4 tinted cell; snap toggle, keep `flex-1` as canvas. **Hashless selectors kept** (eng C2, cheap).

Canonical executable plan: `docs/superpowers/plans/2026-08-26-mail-reader-dark-theme.md`.

---

## Product Contract

### Summary

Staff who use dark theme must read ordinary hotel mail on a dark canvas. Light theme must keep today's paper look. Designed color cells (non-paper `bgcolor`) stay as authored.

### Problem Frame

Two stacked behaviors produce the white slab in the first screenshot:

1. Sanitizer mismatch. `sanitizeEmailHtml` strips `style` and `color` (XSS) but keeps `bgcolor` (HTML-email layout). Unstyled text therefore inherits the Shadow DOM host, while Outlook wrapper tables often keep `bgcolor="#ffffff"`.
2. Isolation over-correction. `f347321e` (plan `docs/superpowers/plans/2026-08-23-mail-content-dark-mode-isolation.md`) pinned `MailContent`'s host to `#ffffff` / `#000000` / `color-scheme: light` and froze `processingTheme` to `'light'`. That made leftover white tables readable by forcing the entire reader surface to light paper — including unstyled and Zero-wrapped bodies that would have been fine on a dark host. `flex-1` plus host fill makes the paper occupy the whole reading column.

The earlier "text not visible" bug was real: `dark:text-white` on the host plus retained white `bgcolor` produced white-on-white. The isolation fix solved contrast by abandoning dark theme for the body. That is the opposite of what dark-theme-only staff want.

Plain-text / Calibri wrap (`0c7d8cd3`, `wrapMailBodyHtml`) is adjacent, not causal. Outbound `color: #000000` is stripped on display. Print iframes in `mail-display.tsx` stay white on purpose and are out of scope. Compose `.ProseMirror` already uses `bg-background`.

Industry context (Gmail desktop leaves bodies light; Apple Mail lets unset backgrounds show chrome through; Outlook can rewrite colors): Zero should follow Apple's unset-background honesty plus a narrow paper-`bgcolor` neutralize, not Gmail-app inversion and not a contrast-mutation engine.

### Requirements

- R1. Dark app theme: message-body host uses app canvas (`background` + `foreground`), not hardcoded white paper.
- R2. Light app theme: message body remains light paper; no visual regression vs today.
- R3. Unstyled / `nava-mail-body` mail in dark theme: light inherited text on dark host. Readable. No white slab.
- R4. Legacy `bgcolor="#ffffff"` (and the small paper-white set below) in dark theme: wrapper tables do not paint a white canvas; inherited host text stays readable. The `bgcolor` attribute may remain in HTML.
- R5. Non-paper authored `bgcolor` (brand/tint/dark cells) is kept and not recolored.
- R6. Quote-ellipsis controls match the active theme (`quotedToggleStyles(theme)`), not a forced light palette.
- R7. OS `forced-colors` stays enabled (`forced-color-adjust` unset).
- R8. Sanitizer allowlists, stored MIME, `wrapMailBodyHtml`, and print HTML stay unchanged.
- R9. `email-content-v3` keeps `processingTheme` in the key; the value follows `resolvedTheme` again so dark and light processed HTML cache separately. No cache version bump.

### Acceptance Examples

- AE1. Dark theme + unstyled `<p>Hello</p>`: host computed background is the app dark canvas, text is light, no `#ffffff` host style.
- AE2. Dark theme + `<table bgcolor="#ffffff">…unstyled span…`: table does not compute to white; span text is light and readable.
- AE3. Light theme + same table: white table + dark text, as today.
- AE4. Dark theme + `<td bgcolor="#12341D">` (or other non-paper): cell keeps that background.
- AE5. Theme toggle from light to dark on an open thread: reader canvas and quote controls update (cache key includes theme).

### Scope Boundaries

#### Included

- `MailContent` host surface and `processingTheme`.
- Shadow-DOM paper-white neutralize CSS for dark theme (processed + demo paths).
- Quote-toggle theme restored to the real reader theme.
- Tests that currently lock light-paper isolation.

#### Deferred to Follow-Up Work

- Per-node contrast rewriting for arbitrary tinted `bgcolor` + missing foreground (the 2026-08-23 known gap).
- Sender-authored `prefers-color-scheme` / `color-scheme` in inbound HTML (sanitizer strips `style` anyway).
- Compose editor theming (already theme-backed).
- Print output.

#### Non-Goals

- Reintroducing `fixNonReadableColors` or the `color` package.
- Allowlisting inbound `style=` / `color=` for fonts or themes.
- CSS `filter: invert()` on the mail body.
- Changing sanitizer tags/attributes.
- Mutating stored Postgres HTML or S3 MIME.
- Pilot-RDS Vitest.

---

## Planning Contract

### KTD1. Host follows app theme; isolation hardcoded paper is the bug

`MailContent` restores `useTheme().resolvedTheme` with `'light'` fallback (same as pre-`f347321e`). Host classes: keep layout (`mail-content w-full flex-1 overflow-scroll no-scrollbar px-4`); add `bg-background text-foreground`. Inline `colorScheme` follows `processingTheme`. Remove `backgroundColor: '#ffffff'`, `color: '#000000'`, and forced `color-scheme: light`.

Rationale: the white slab is the host, not mysterious inner CSS. Unstyled mail then inherits correctly. Shadow custom properties inherit from the light-DOM host, so Tailwind theme tokens work without piercing.

### KTD2. Neutralize paper `bgcolor` with CSS, not a color engine

When `processingTheme === 'dark'`, prepend a fixed `<style data-nava-mail-paper="1">` into the shadow tree (both processed HTML and frontend-only demo). Selectors (case-insensitive):

- `[bgcolor="#ffffff"]`
- `[bgcolor="#fff"]`
- `[bgcolor="#fffffe"]`
- `[bgcolor="white"]`

Rule: `background-color: transparent !important;`

Do not parse luminance. Do not walk nodes. Do not strip the attribute (light theme and sanitizer tests still see `bgcolor="#ffffff"`). Non-matching `bgcolor` is untouched (R5).

Rationale: sanitizer already removed inline `background-color` / `color`. The only surviving paper canvas is this attribute. Transparent paper lets the themed host show through — Apple Mail's "unset background shows chrome" behavior, applied to the Outlook default we kept on purpose.

Place the CSS string in `apps/mail/lib/mail/mail-paper-neutralize.ts` and prepend in the existing `shadowRoot.innerHTML = resolvedHtml` effect. One injection site. Server `mailBodyDisplayStyleTag()` stays typography-only.

### KTD3. Restore real `processingTheme` for quote controls only

`processingTheme = (resolvedTheme === 'dark' ? 'dark' : 'light')`. Pass it to `processEmailContent` as today. Server `quotedToggleStyles(theme)` already has a dark palette (`#313131`). Isolation froze this to light so toggles matched the white host; that coupling reverses.

Do not change `processEmailHtmlForDisplay` HTML besides quote CSS already gated on `theme`. Do not put paper-neutralize CSS on the server (avoids a second copy and keeps typography helper theme-free).

### KTD4. Tests that lock isolation must change meaning, not be deleted blindly

Update, do not orphan:

- `apps/mail/tests/mail-content-rendering.test.tsx` — host no longer asserts `#ffffff` / `#000000` / `color-scheme: light`. Assert theme-following host + dark processing call. Mock `next-themes`.
- `apps/mail/tests/mail-content-cache-key-contract.test.ts` — `processingTheme` still in the key; must NOT require `const processingTheme = 'light'` or forbid `useTheme`.
- `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts` — keep synthetic Chromium, no PII. New contract: dark app chrome, themed host, paper `bgcolor` table is not white, unstyled text is light.
- `apps/server-pilot/tests/process-email-html-font.test.ts` — keep "retains white `bgcolor` while stripping style" (sanitize contract). Quote-control test stays light-theme default unless a new dark-theme quote test is added in the same file.

### KTD5. Docs boundary

Update `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md` so it no longer claims `MailContent` owns a fixed light-paper surface. Record: host follows theme; paper `bgcolor` is neutralized in dark CSS only; typography helper still must not force reader color.

### Assumptions

- A1. `resolvedTheme` undefined on first paint falls back to light; a one-frame light flash in dark-preferring users is acceptable (pre-isolation behavior).
- A2. Paper-white set above covers Centurion/Outlook wrappers. Oddballs like `#f7f7f7` remain authored surfaces (deferred gap, same class as tinted templates).
- A3. Frontend-only demo is in scope for host + neutralize because it shares the `innerHTML` write.
- A4. `bg-background` / `text-foreground` on the host is sufficient; no extra CSS variables inside the shadow.

### Dependencies and Sequencing

U1 tests + host theme restore. U2 paper-neutralize CSS + Playwright. U3 quote theme + cache-key contract. U4 solution-doc. U1 can land alone and already removes the white slab for unstyled mail; U2 is required for Outlook tables.

### Risks

- Dark logos designed for white paper may look odd on dark canvas. Accepted; inversion is a non-goal.
- Tinted `bgcolor` + inherited light text can fail contrast. Documented residual; do not expand into a mutator.
- Duplicate neutralize style if processed HTML is later given the same tag on the server. Mitigation: server does not emit it.

---

## Implementation Units

### U1. Theme-following MailContent host

Files:

- `apps/mail/components/mail/mail-content.tsx`
- `apps/mail/tests/mail-content-rendering.test.tsx`
- `apps/mail/tests/mail-content-cache-key-contract.test.ts`

Restores `useTheme`, `processingTheme` from `resolvedTheme`, theme token host styles. Failing tests first.

### U2. Dark-mode paper `bgcolor` neutralize

Files:

- Create `apps/mail/lib/mail/mail-paper-neutralize.ts`
- `apps/mail/components/mail/mail-content.tsx` (prepend in shadow write)
- `apps/mail/tests/mail-content-rendering.test.tsx`
- `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts`

Fixed CSS string. No HTML parser. Playwright proves computed styles in Chromium.

### U3. Quote controls follow reader theme

Files:

- Covered by U1's `processingTheme` restore
- `apps/server-pilot/tests/process-email-html-font.test.ts` (add dark-theme quote assertion; keep light assertion)

No server production change if `quotedToggleStyles` already keys off `theme`.

### U4. Institutional doc

Files:

- `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md`

---

## Verification Contract

Pilot-RDS: before every Vitest command, `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never `VITEST_ALLOW_PILOT_RDS=1`. Never source `.env.production` into a test shell.

Commands:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts
pnpm --filter @zero/mail exec playwright test --config=playwright.mail-content-theme.config.ts
```

Browser fixture: synthetic HTML only. No login, no app server, no PII.

Manual canary (not a gate): dark theme open a short unstyled thread and an Outlook table thread; light theme both still paper.

---

## Definition of Done

- R1–R9 have a named test or an explicit residual note (R5 tinted contrast = residual).
- No `backgroundColor: '#ffffff'` on `.mail-content`.
- No `fixNonReadableColors` / `from 'color'` in `apps/mail`.
- Isolation Playwright spec name may stay; assertions match the new contract.
- Solution doc no longer describes fixed light-paper as current behavior.

---

## Appendix

### Causal chain (RCA)

1. Staff use dark theme (`html.dark`, chrome tokens correct).
2. `MailContent` host is open Shadow DOM; descendants inherit host `color` / `background`.
3. `sanitizeEmailHtml` drops `style`/`color`, keeps `bgcolor`.
4. Pre-isolation: host had `dark:text-white` → white text on retained `#ffffff` tables → invisible text (the Synexis/formatting-era complaint).
5. `f347321e` set host to white/black/`color-scheme: light` and `processingTheme = 'light'`.
6. Every message, including unstyled letters, sits on a white flex child. Light theme hides the bug. Dark theme shows the first screenshot.

### Rejected alternatives

- Keep light-paper host, shrink height: still a white card; user asked for dark theme, not a smaller paper.
- Full inversion / Gmail-app rewrite: images and brand cells break; isolation plan already forbade it.
- Allowlist `style` for colors: XSS surface; Calibri solution forbids it.
- Two-tier "paper card vs themeable" classifier: extra machinery; neutralizing paper whites + themed host is the same outcome for the Centurion default.
