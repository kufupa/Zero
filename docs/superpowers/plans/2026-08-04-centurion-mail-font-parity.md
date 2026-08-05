# Centurion Mail Font Parity (Outlook Calibri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zero hotel mail body typography match Outlook 2016’s default (Calibri 11pt) when typing, sending, and reading — so Centurion staff no longer see “our font vs Centurion font.”

**Architecture:** One server-side outbound wrap at `mail.send` (persist + SMTP same string), FE reply/forward outer-div string swap for WYSIWYG honesty, ProseMirror CSS for compose, post-sanitize display CSS for the read pane. App chrome stays Geist. Do not reopen sanitize `style` attrs.

**Tech Stack:** TipTap/ProseMirror compose, pilot `mail.send` / `processEmailHtmlForDisplay`, `sanitize-html`, Vitest (no pilot RDS).

## Global Constraints

- Pilot-RDS safety: never run Vitest with `DATABASE_URL` pointing at pilot/prod; always `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- Mail body only: list, subject, nav, snippets stay Geist.
- No web fonts in outbound HTML (classic Outlook → Times New Roman trap).
- Display CSS is a fixed helper string — never interpolate message HTML into `<style>`.
- Do not allowlist arbitrary `style=` through sanitize in this plan.
- Hotel target = Windows Outlook 2016 Calibri; Mac = best-effort Arial fallback (honest, not Carlito in SMTP).

## Settled decisions (session)

| Decision | Choice | Source |
|----------|--------|--------|
| Target face/size | `Calibri, Arial, sans-serif` @ `11pt` | MS Outlook 2016 default + ponytail shrink |
| Outbound choke point | Single wrap inside `mail.send` mutation; same HTML → DB + SMTP + draft revision | eng P0 |
| Idempotent marker | `class="nava-mail-body"` (survives sanitize; `data-*` / `style` do not) | eng P0 + sanitize proof |
| FE typography module | No shared package; FE hardcodes same stack string; server owns `wrapMailBodyHtml` | ponytail |
| Legacy `apps/server` | Do not touch unless proven still shipping hotel Centurion mail | ponytail |
| Read-pane color | No forced `#000` in display CSS; inherit host theme | design P0 |
| SMTP color | Outer wrap may set `color:#000000` for recipient white paper | design |
| Compose color | Do not hardcode `#000` on `.ProseMirror` (dark-mode honesty) | design P0 |

## Review disposition

| Gate | Agent | Verdict | Reconciliation |
|------|-------|---------|----------------|
| gstack-plan-eng-review | [Eng](426375d3-e7a0-49c1-ba27-f96312660014) | approve-with-changes | Adopted: single `mail.send` wrap; `class` marker; post-sanitize CSS; concrete tests |
| ponytail-review | [Ponytail](13775253-ebb1-4b99-a81f-b1216c2ae825) | net −80 | Adopted: no dual package; shrink stack; `:host`/inherit display; no apps/server touch; drop forced display black |
| gstack-plan-design-review | [Design](2d57c0e6-7554-4735-b352-68c0b1a1e62a) | approve-with-changes | Adopted: no display `#000`; Mac honesty; chrome vs body boundary |

**Conflict resolved:** eng wanted shared FE/BE constant package; ponytail forbade dual modules — **hardcode identical string on FE + server helper**, asserted by tests on both sides (same literal).

**Independence:** eng / ponytail / design ran as separate Task agents (no `model` pin → parent Auto; not `composer-2.5-fast`).

---

## File map

| File | Role |
|------|------|
| `apps/server-pilot/src/mail/mail-body-typography.ts` | **Create** — `MAIL_BODY_FONT_FAMILY`, `MAIL_BODY_FONT_SIZE`, `wrapMailBodyHtml`, `mailBodyDisplayStyleTag` |
| `apps/server-pilot/tests/mail-body-typography.test.ts` | **Create** — unit tests for wrap + display tag |
| `apps/server-pilot/src/trpc/routes/mail.ts` | **Modify** — wrap `input.html` once before DB + SMTP |
| `apps/server-pilot/src/mail/process-email-html.ts` | **Modify** — prepend display style tag after sanitize |
| `apps/server-pilot/tests/process-email-html-font.test.ts` | **Create** — display CSS present; XSS still stripped |
| `apps/mail/lib/utils.ts` | **Modify** — `constructReplyBody` / `constructForwardBody` Calibri + `nava-mail-body` |
| `apps/mail/tests/construct-reply-body.test.ts` | **Modify** — assert Calibri + class; no apple-system |
| `apps/mail/components/create/prosemirror.css` | **Modify** — Calibri 11pt; no forced black |
| `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md` | **Create** after canary (CE learning) |

---

## Data flow (locked)

```text
TipTap getHTML()
  → FE reply: constructReplyBody (outer div.nava-mail-body + Calibri 11pt inline)
  → FE new: bare <p>…
  → mail.send
       html = wrapMailBodyHtml(input.html)  // skip if .nava-mail-body already present
       → message.htmlBody = html
       → smtpPayload.html = html
  → Outlook recipient sees Calibri 11pt

Inbound / wire display:
  sanitize (strips style; keeps class)
  → processEmailHtmlForDisplay prepends <style data-nava-mail-font>…</style>
  → MailContent shadowRoot.innerHTML
  → Calibri 11pt via CSS; color from host (dark-safe)
```

---

### Task 1: Server typography helper + failing tests

**Files:**
- Create: `apps/server-pilot/src/mail/mail-body-typography.ts`
- Test: `apps/server-pilot/tests/mail-body-typography.test.ts`

**Interfaces:**
- Produces:
  - `export const MAIL_BODY_FONT_FAMILY = "Calibri, Arial, sans-serif"`
  - `export const MAIL_BODY_FONT_SIZE = "11pt"`
  - `export function wrapMailBodyHtml(html: string): string`
  - `export function mailBodyDisplayStyleTag(): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  MAIL_BODY_FONT_FAMILY,
  MAIL_BODY_FONT_SIZE,
  mailBodyDisplayStyleTag,
  wrapMailBodyHtml,
} from '../src/mail/mail-body-typography.js';

describe('wrapMailBodyHtml', () => {
  it('wraps bare TipTap HTML with nava-mail-body + Calibri 11pt', () => {
    const out = wrapMailBodyHtml('<p>hi</p>');
    expect(out).toContain('class="nava-mail-body"');
    expect(out).toContain(`font-family: ${MAIL_BODY_FONT_FAMILY}`);
    expect(out).toContain(`font-size: ${MAIL_BODY_FONT_SIZE}`);
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('color: #000000');
  });

  it('is idempotent when nava-mail-body already present', () => {
    const once = wrapMailBodyHtml('<p>hi</p>');
    const twice = wrapMailBodyHtml(once);
    expect(twice).toBe(once);
    expect(twice.match(/nava-mail-body/g)?.length).toBe(1);
  });

  it('does not wrap empty string into a meaningful body (passthrough empty)', () => {
    expect(wrapMailBodyHtml('')).toBe('');
  });
});

describe('mailBodyDisplayStyleTag', () => {
  it('emits fixed Calibri 11pt CSS without forced black', () => {
    const tag = mailBodyDisplayStyleTag();
    expect(tag).toContain('<style');
    expect(tag).toContain(MAIL_BODY_FONT_FAMILY);
    expect(tag).toContain(MAIL_BODY_FONT_SIZE);
    expect(tag).not.toMatch(/color\s*:\s*#000/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && npx vitest run tests/mail-body-typography.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
export const MAIL_BODY_FONT_FAMILY = 'Calibri, Arial, sans-serif';
export const MAIL_BODY_FONT_SIZE = '11pt';

const MARKER_CLASS = 'nava-mail-body';

export function wrapMailBodyHtml(html: string): string {
  if (!html) return html;
  if (html.includes(MARKER_CLASS)) return html;
  const style = `font-family: ${MAIL_BODY_FONT_FAMILY}; font-size: ${MAIL_BODY_FONT_SIZE}; color: #000000;`;
  return `<div class="${MARKER_CLASS}" style="${style}">${html}</div>`;
}

export function mailBodyDisplayStyleTag(): string {
  return `<style data-nava-mail-font="1">
:host, .mail-content-root, .nava-mail-body {
  font-family: ${MAIL_BODY_FONT_FAMILY};
  font-size: ${MAIL_BODY_FONT_SIZE};
}
</style>`;
}
```

Note: shadow injection uses this tag as first child of `shadowRoot.innerHTML`; `:host` inherits onto fragment. Prefer inheritance over `body,p,div,td,li,span` lists.

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit** (only if user asked for commits)

```bash
git add apps/server-pilot/src/mail/mail-body-typography.ts apps/server-pilot/tests/mail-body-typography.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): add Outlook Calibri body typography helper

EOF
)"
```

---

### Task 2: Wire wrap into `mail.send`

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (send mutation; around smtpPayload / htmlBody insert)
- Test: extend or add `apps/server-pilot/tests/mail-send-font-wrap.test.ts` (unit-level: import wrap + assert call site via thin exported helper if needed; prefer testing that send path uses `wrapMailBodyHtml` by extracting one-liner prepare)

**Interfaces:**
- Consumes: `wrapMailBodyHtml` from Task 1
- Produces: persisted `htmlBody` === `smtpPayload.html` === wrapped HTML

- [ ] **Step 1: Write failing contract test**

If full `mail.send` integration needs DB, skip DB and test a tiny exported prep:

```ts
// apps/server-pilot/src/mail/prepare-outbound-html.ts
import { wrapMailBodyHtml } from './mail-body-typography.js';
export function prepareOutboundHtml(html: string): string {
  return wrapMailBodyHtml(html);
}
```

```ts
import { describe, expect, it } from 'vitest';
import { prepareOutboundHtml } from '../src/mail/prepare-outbound-html.js';

describe('prepareOutboundHtml', () => {
  it('wraps AI/bare paragraphs for SMTP', () => {
    expect(prepareOutboundHtml('<p>Thanks</p>')).toContain('nava-mail-body');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (missing prepare or unused)

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && npx vitest run tests/mail-send-font-wrap.test.ts
```

- [ ] **Step 3: Implement**

In `mail.send`, before building `smtpPayload` / insert:

```ts
import { prepareOutboundHtml } from '../../mail/prepare-outbound-html.js';
// ...
const html = prepareOutboundHtml(input.html);
// use `html` for smtpPayload.html, message.htmlBody, draft revision htmlBody
```

Do **not** wrap inside `sendInput` Zod transform (eng: wrong place).

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit** (if requested)

---

### Task 3: Display CSS after sanitize

**Files:**
- Modify: `apps/server-pilot/src/mail/process-email-html.ts`
- Test: `apps/server-pilot/tests/process-email-html-font.test.ts`

**Interfaces:**
- Consumes: `mailBodyDisplayStyleTag()`
- Produces: `processedHtml` starting with style tag; still XSS-safe

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { processEmailHtmlForDisplay } from '../src/mail/process-email-html.js';
import { MAIL_BODY_FONT_FAMILY } from '../src/mail/mail-body-typography.js';

describe('processEmailHtmlForDisplay font default', () => {
  it('prepends Calibri display CSS after sanitize', () => {
    const { processedHtml } = processEmailHtmlForDisplay({
      html: '<p class="MsoNormal" style="font-family:Calibri">Hello</p><script>alert(1)</script>',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://example.test',
      attachments: [],
    });
    expect(processedHtml).toContain('data-nava-mail-font');
    expect(processedHtml).toContain(MAIL_BODY_FONT_FAMILY);
    expect(processedHtml).not.toContain('<script');
    expect(processedHtml).not.toMatch(/style="font-family:Calibri"/);
  });
});
```

- [ ] **Step 2: Run — FAIL** (no style tag yet)

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && npx vitest run tests/process-email-html-font.test.ts
```

- [ ] **Step 3: Implement**

```ts
import { mailBodyDisplayStyleTag } from './mail-body-typography.js';
// after sanitize + cid + quoted:
const processedHtml = `${mailBodyDisplayStyleTag()}${processQuotedContent(...)}`;
```

If `processQuotedContent` already returns a string, prepend style once. Do not put user HTML inside the style tag.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit** (if requested)

---

### Task 4: FE reply/forward wrappers

**Files:**
- Modify: `apps/mail/lib/utils.ts` (`constructReplyBody`, `constructForwardBody`)
- Modify: `apps/mail/tests/construct-reply-body.test.ts`

**Interfaces:**
- Produces: outer `<div class="nava-mail-body" style="font-family: Calibri, Arial, sans-serif; font-size: 11pt;">` (no `#000` required on FE quote chrome; server wrap adds black if bare — reply path already marked so send skips)

Use the **exact** family/size literals matching server constants.

- [ ] **Step 1: Update failing expectations**

```ts
it('uses Outlook Calibri body stack not apple-system', () => {
  const html = constructReplyBody(
    '<p>hiii</p>',
    '7/23/2026, 11:33:26 AM',
    { name: 'aroransh17', email: 'aroransh17@gmail.com' },
    [{ name: 'Nava', email: 'navaai@legacyhotels.co.za' }],
    '<p>hi!!</p>',
  );
  expect(html).toContain('nava-mail-body');
  expect(html).toContain('Calibri, Arial, sans-serif');
  expect(html).toContain('font-size: 11pt');
  expect(html).not.toContain('apple-system');
});
```

Same idea for `constructForwardBody`.

- [ ] **Step 2: Run**

```bash
cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && npx vitest run tests/construct-reply-body.test.ts
```

Expected: FAIL on apple-system / missing Calibri.

- [ ] **Step 3: Replace outer font-family in both constructors**

```ts
<div class="nava-mail-body" style="font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit** (if requested)

---

### Task 5: Compose editor CSS

**Files:**
- Modify: `apps/mail/components/create/prosemirror.css`

**Interfaces:** none (CSS only)

- [ ] **Step 1: Change `.ProseMirror` block**

```css
.ProseMirror {
  font-family: Calibri, Arial, sans-serif;
  font-size: 11pt;
  font-weight: 400;
  /* color: inherit from theme — do not force #000 (dark mode) */
}
```

- [ ] **Step 2: Manual smoke (no Vitest required)** — open compose in browser; confirm computed font-family includes Calibri (Windows) or Arial (Mac).

- [ ] **Step 3: Commit** (if requested)

---

### Task 6: Regression sweep + CE solution note

**Files:**
- Create (after verify): `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md`

- [ ] **Step 1: Run targeted suites**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
cd apps/server-pilot && npx vitest run tests/mail-body-typography.test.ts tests/mail-send-font-wrap.test.ts tests/process-email-html-font.test.ts tests/sanitize-email-html.test.ts
cd ../mail && npx vitest run tests/construct-reply-body.test.ts
```

Expected: all PASS. No pilot RDS.

- [ ] **Step 2: Manual canary (pilot)**

1. Compose new Centurion mail + reply in Zero (Windows).
2. Receive in Outlook 2016 / Word engine → body Calibri 11pt.
3. Open same thread in Zero → compose + read look Calibri; chrome still Geist.
4. Dark mode: body text still readable (no black-on-dark from our CSS).

- [ ] **Step 3: Write CE solution** — root cause chain, sanitize strips styles, Calibri contract, choke point `mail.send`, display CSS after sanitize.

---

## Out of scope

- Font picker / per-mailbox themes
- Reopening sanitize `style` allowlist
- Print iframe Arial (`mail-display` / `thread-display` print paths)
- Changing Geist app chrome
- Carlito webfont in SMTP
- `apps/server` (non-pilot) unless later proven live for Centurion

## Definition of done

- [ ] All Task 1–5 tests green under `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`
- [ ] Outbound HTML contains `nava-mail-body` + Calibri 11pt for bare and reply paths (idempotent)
- [ ] Read pane injects display CSS; dark mode readable
- [ ] Compose ProseMirror uses Calibri 11pt
- [ ] Manual Outlook canary notes recorded
- [ ] CE solution doc written

## Next step

`/nava-run` on `docs/superpowers/plans/2026-08-04-centurion-mail-font-parity.md` (subagent-driven preferred).
