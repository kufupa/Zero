# Mail Reader Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Zero mail reading pane follow the user's app theme so dark mode is not a full-column white paper, while leftover Outlook `bgcolor="#ffffff"` tables stay readable.

**Architecture:** `MailContent` is the display boundary. Restore `processingTheme` from `useTheme()` (with `html.dark` when `resolvedTheme` is still unset). Paint the Shadow DOM host with `bg-background text-foreground` instead of hardcoded `#ffffff` / `#000000` / `color-scheme: light`. In dark theme only, prepend a fixed paper-neutralize `<style>` into the shadow write so paper `bgcolor` values become transparent and the host canvas shows through. Sanitizer, stored MIME, `mailBodyDisplayStyleTag()`, and print iframes stay unchanged. Quote-toggle CSS already keys off `theme`; restoring the real processing theme is enough.

**Tech Stack:** React 19, next-themes, open Shadow DOM, CSS attribute selectors (`i` flag), Vitest + happy-dom, Playwright Chromium, pnpm.

## Global Constraints

- Pilot-RDS safety: before every Vitest command run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`; never use pilot/prod RDS or `VITEST_ALLOW_PILOT_RDS=1`.
- Do not reintroduce `fixNonReadableColors`, the `color` package, DOM contrast mutation, or inbound `style=` / `color=` allowlisting.
- Do not mutate stored Postgres HTML or S3 MIME.
- Do not change `sanitizeEmailHtml` allowlists.
- `mailBodyDisplayStyleTag()` stays typography-only (no reader color, no paper CSS on the server).
- Paper neutralize CSS is a fixed literal concatenated **after** `</style>` never interpolates mail HTML into the style tag.
- `email-content-v3` keeps `processingTheme` in the key; do not bump the cache version.
- Playwright fixture: synthetic HTML only. No login, no app server, no PII.
- Commit only task-specific files. Never `--no-verify`, force-push, reset, or destructive cleanup.
- Next step after this plan is `/nava-run`, not a second planning pass.

## Plan review disposition

Source: `docs/plans/2026-08-26-001-fix-mail-reader-dark-theme-plan.md`. Independent gates:

- Eng: approve-with-fixes. Shadow write must depend on `processingTheme`. Paper selectors need `i` + hashless hex twins. Playwright uses `#FFFFFF`.
- Ponytail: no host `colorScheme` override (inherit `html` from next-themes). No extra server quote test. Module exists because Playwright + `MailContent` both need the same CSS string. Rejected “only `#ffffff` lowercase”.
- Design: 8.4/10. `html.dark` when theme unresolved. Keep `flex-1` as theme canvas. Playwright AE4 tinted cell. Snap toggle.

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/mail/lib/mail/mail-paper-neutralize.ts` | Create | Fixed dark-theme paper `bgcolor` CSS string. |
| `apps/mail/components/mail/mail-content.tsx` | Modify | Theme-following host; prepend neutralize CSS when dark; shadow write depends on theme. |
| `apps/mail/tests/mail-content-rendering.test.tsx` | Modify | Mock `next-themes`; replace light-paper host contract; theme-toggle rewrite. |
| `apps/mail/tests/mail-content-cache-key-contract.test.ts` | Modify | `processingTheme` is a variable from `useTheme`, not `'light'`. |
| `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts` | Modify | Chromium: dark canvas + `#FFFFFF` table not white; light regression; tinted cell; `forced-colors`. |
| `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md` | Modify | Stop claiming fixed light-paper host. |

Not modified: `apps/server-pilot/src/mail/sanitize-email-html.ts`, `process-email-html.ts`, `mail-body-typography.ts`, print CSS in `mail-display.tsx`, `collapse-quoted-html.ts` (dark quote CSS already exists; `collapse-quoted-html.test.ts` already asserts `#313131`).

---

### Task 0: Record clean baseline

**Files:** none.

**Interfaces:**
- Consumes: frozen lockfile, current isolation tests.
- Produces: evidence that isolation suites are green before behavior change.

- [ ] **Step 1: Run focused baseline**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts tests/collapse-quoted-html.test.ts
pnpm --filter @zero/mail exec playwright test --config=playwright.mail-content-theme.config.ts
```

If mail Vitest fails on missing Paraglide:

```bash
pnpm --filter @zero/mail exec paraglide-js compile --project ./project.inlang --outdir ./paraglide --strategy cookie baseLocale --silent
```

Then rerun the mail Vitest command. Generated `apps/mail/paraglide` is never staged.

Expected: all three suites pass. Playwright currently asserts a white host (`rgb(255, 255, 255)`). Any unexpected red triggers RCA before Task 1.

- [ ] **Step 2: Commit nothing**

Baseline only.

---

### Task 1: Theme-following host (failing tests first)

**Files:**
- Modify: `apps/mail/tests/mail-content-rendering.test.tsx`
- Modify: `apps/mail/tests/mail-content-cache-key-contract.test.ts`
- Modify: `apps/mail/components/mail/mail-content.tsx`
- Create: `apps/mail/lib/mail/mail-paper-neutralize.ts` (string only; prepend wired in Task 2)

**Interfaces:**
- Consumes: `useTheme().resolvedTheme`; `document.documentElement.classList` when unresolved.
- Produces: `processingTheme: 'light' | 'dark'`. Host class includes `bg-background text-foreground`. No inline `#ffffff` / `#000000` / `color-scheme: light`. `processEmailContent` receives the real theme.

- [ ] **Step 1: Add the paper CSS module**

Create `apps/mail/lib/mail/mail-paper-neutralize.ts`:

```ts
export const MAIL_PAPER_NEUTRALIZE_STYLE = `<style data-nava-mail-paper="1">
[bgcolor="#ffffff" i],
[bgcolor="#fff" i],
[bgcolor="#fffffe" i],
[bgcolor="ffffff" i],
[bgcolor="fff" i],
[bgcolor="fffffe" i],
[bgcolor="white" i] {
  background-color: transparent !important;
}
</style>`;
```

Do not import this in `MailContent` yet. Task 2 wires the prepend. Creating the module now keeps the selector set in one place for Playwright.

- [ ] **Step 2: Mock next-themes and replace the light-paper host test**

In `apps/mail/tests/mail-content-rendering.test.tsx`, add a hoisted theme mock next to the existing `mocks` object:

```ts
const themeMocks = vi.hoisted(() => ({
  resolvedTheme: 'light' as 'light' | 'dark' | undefined,
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeMocks.resolvedTheme }),
}));
```

In `beforeEach`, reset `themeMocks.resolvedTheme = 'light'` so existing tests keep sending `theme: 'light'`.

Replace `it('processes legacy mail onto a fixed light-paper surface', ...)` with:

```tsx
  it('processes mail onto a theme-following host in dark mode', async () => {
    themeMocks.resolvedTheme = 'dark';
    mocks.processEmailContent.mockResolvedValue({
      processedHtml:
        '<table bgcolor="#FFFFFF"><tr><td><span data-legacy-mail="true">Readable</span></td></tr></table>',
      hasBlockedImages: false,
    });

    renderMailContent();

    await waitFor(() => {
      expect(mocks.processEmailContent).toHaveBeenCalledWith({
        html: RAW_HTML,
        messageId: 'message-42',
        shouldLoadImages: false,
        theme: 'dark',
      });
      expect(renderedHost()?.shadowRoot?.querySelector('[data-legacy-mail="true"]')?.textContent).toBe(
        'Readable',
      );
    });

    const host = renderedHost();
    expect(host?.className).toContain('bg-background');
    expect(host?.className).toContain('text-foreground');
    expect(host?.className).not.toContain('dark:text-white');
    expect(host?.style.getPropertyValue('background-color')).not.toBe('#ffffff');
    expect(host?.style.getPropertyValue('color')).not.toBe('#000000');
    expect(host?.style.getPropertyValue('color-scheme')).toBe('');
    expect(host?.style.getPropertyValue('forced-color-adjust')).toBe('');
  });
```

Keep the demo-path test, but change its host assertions to the same theme-following contract (default mock theme is light):

```tsx
    expect(renderedHost()?.className).toContain('bg-background');
    expect(renderedHost()?.className).toContain('text-foreground');
    expect(renderedHost()?.style.getPropertyValue('background-color')).not.toBe('#ffffff');
    expect(renderedHost()?.style.getPropertyValue('color')).not.toBe('#000000');
    expect(renderedHost()?.style.getPropertyValue('color-scheme')).toBe('');
```

- [ ] **Step 3: Update the cache-key source contract**

In `apps/mail/tests/mail-content-cache-key-contract.test.ts`, replace the isolation-era assertions:

```ts
    expect(queryKey).toContain('processingTheme,');
    expect(source).not.toContain("const processingTheme = 'light';");
    expect(source).toContain('useTheme');
    expect(source).toContain("document.documentElement.classList.contains('dark')");
```

Keep digest / `email-content-v3` / no raw `html` in the key / no `0x811c9dc5`.

- [ ] **Step 4: Run tests to verify they fail**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
```

Expected: FAIL because `MailContent` still hardcodes `'light'` and `#ffffff`, and does not import `useTheme`.

- [ ] **Step 5: Implement the host**

In `apps/mail/components/mail/mail-content.tsx`:

1. Restore `import { useTheme } from 'next-themes';`
2. Replace `const processingTheme = 'light';` with:

```ts
  const { resolvedTheme } = useTheme();
  const processingTheme: 'light' | 'dark' =
    resolvedTheme === 'dark' ||
    (resolvedTheme !== 'light' &&
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'))
      ? 'dark'
      : 'light';
```

3. Replace the host `className` / `style` with:

```tsx
        className="mail-content w-full flex-1 overflow-scroll no-scrollbar px-4 bg-background text-foreground"
```

Delete the inline `style={{ backgroundColor, color, colorScheme }}` object entirely. Do not set `colorScheme` on the host; next-themes already sets `color-scheme` on `html`.

- [ ] **Step 6: Re-run Task 1 tests**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
```

Expected: PASS. Paper CSS is not prepended yet; that is Task 2. Unstyled mail in dark mode is already a dark canvas (R1/R3).

- [ ] **Step 7: Commit**

```bash
git add apps/mail/lib/mail/mail-paper-neutralize.ts apps/mail/components/mail/mail-content.tsx apps/mail/tests/mail-content-rendering.test.tsx apps/mail/tests/mail-content-cache-key-contract.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): follow app theme in the reader host

Stop painting every message body onto hardcoded light paper so dark chrome is not a white slab.
EOF
)"
```

---

### Task 2: Dark-mode paper `bgcolor` neutralize

**Files:**
- Modify: `apps/mail/components/mail/mail-content.tsx`
- Modify: `apps/mail/tests/mail-content-rendering.test.tsx`
- Modify: `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts`
- Modify: `apps/mail/tests/mail-content-cache-key-contract.test.ts` (assert module selectors)

**Interfaces:**
- Consumes: `MAIL_PAPER_NEUTRALIZE_STYLE`, `processingTheme`, `resolvedHtml`.
- Produces: `shadowHtml = processingTheme === 'dark' ? MAIL_PAPER_NEUTRALIZE_STYLE + resolvedHtml : resolvedHtml`. Effect writes `shadowHtml` and depends on it (not `resolvedHtml` alone).

- [ ] **Step 1: Add failing rendering coverage for prepend + theme rewrite**

Append inside `describe('MailContent processing states', ...)`:

```tsx
  it('prepends paper neutralize CSS in dark theme and rewrites shadow when theme flips', async () => {
    mocks.processEmailContent.mockResolvedValue({
      processedHtml: '<p data-plain-mail="true">Hello</p>',
      hasBlockedImages: false,
    });

    const { queryClient, rerender } = renderMailContent();
    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-plain-mail="true"]')?.textContent).toBe(
        'Hello',
      );
    });
    expect(renderedHost()?.shadowRoot?.innerHTML).not.toContain('data-nava-mail-paper');

    themeMocks.resolvedTheme = 'dark';
    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-42" html={RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(mocks.processEmailContent).toHaveBeenCalledWith({
        html: RAW_HTML,
        messageId: 'message-42',
        shouldLoadImages: false,
        theme: 'dark',
      });
      expect(renderedHost()?.shadowRoot?.innerHTML).toContain('data-nava-mail-paper');
      expect(renderedHost()?.shadowRoot?.querySelector('[data-plain-mail="true"]')?.textContent).toBe(
        'Hello',
      );
    });
  });
```

In `mail-content-cache-key-contract.test.ts`, after the existing file read of `mail-content.tsx`, also lock the CSS module:

```ts
  it('keeps case-insensitive paper bgcolor selectors in the neutralize stylesheet', () => {
    const css = readFileSync(
      new URL('../lib/mail/mail-paper-neutralize.ts', import.meta.url),
      'utf8',
    );
    expect(css).toContain('[bgcolor="#ffffff" i]');
    expect(css).toContain('[bgcolor="#fff" i]');
    expect(css).toContain('[bgcolor="#fffffe" i]');
    expect(css).toContain('[bgcolor="ffffff" i]');
    expect(css).toContain('[bgcolor="white" i]');
    expect(css).toContain('data-nava-mail-paper');
  });
```

- [ ] **Step 2: Rewrite the Playwright fixture**

Replace `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts` entirely:

```ts
import { expect, test } from '@playwright/test';
import { MAIL_PAPER_NEUTRALIZE_STYLE } from '../../lib/mail/mail-paper-neutralize';

test('dark host keeps unstyled text readable on neutralized paper tables', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>
      :root { color-scheme: dark; }
      #app { background: rgb(20, 20, 20); color: rgb(255, 255, 255); }
    </style>
    <div id="app">
      <div id="mail-content" class="bg-background text-foreground"></div>
    </div>
  `);

  const computed = await page.evaluate((paperStyle) => {
    const host = document.querySelector<HTMLElement>('#mail-content');
    if (!host) throw new Error('mail-content host missing');
    host.style.backgroundColor = 'rgb(20, 20, 20)';
    host.style.color = 'rgb(255, 255, 255)';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `${paperStyle}
      <table bgcolor="#FFFFFF"><tbody><tr>
        <td><span data-legacy-copy="true">Readable</span><input data-native-control="true"></td>
        <td bgcolor="#12341D" data-tinted-cell="true">Kept</td>
      </tr></tbody></table>`;

    const text = root.querySelector<HTMLElement>('[data-legacy-copy="true"]');
    const table = root.querySelector<HTMLElement>('table');
    const tinted = root.querySelector<HTMLElement>('[data-tinted-cell="true"]');
    const nativeControl = root.querySelector<HTMLInputElement>('[data-native-control="true"]');
    if (!text || !table || !tinted || !nativeControl) throw new Error('legacy fixture missing');

    return {
      hostBackground: getComputedStyle(host).backgroundColor,
      hostColor: getComputedStyle(host).color,
      tableBackground: getComputedStyle(table).backgroundColor,
      textColor: getComputedStyle(text).color,
      tintedBackground: getComputedStyle(tinted).backgroundColor,
      nativeControlColorScheme: getComputedStyle(nativeControl).colorScheme,
    };
  }, MAIL_PAPER_NEUTRALIZE_STYLE);

  expect(computed.hostBackground).toBe('rgb(20, 20, 20)');
  expect(computed.hostColor).toBe('rgb(255, 255, 255)');
  expect(computed.tableBackground).not.toBe('rgb(255, 255, 255)');
  expect(computed.textColor).toBe('rgb(255, 255, 255)');
  expect(computed.tintedBackground).toBe('rgb(18, 52, 29)');
  expect(computed.nativeControlColorScheme).toBe('dark');

  await page.emulateMedia({ forcedColors: 'active' });
  const forcedColors = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#mail-content');
    if (!host) throw new Error('mail-content host missing');
    return {
      mediaActive: matchMedia('(forced-colors: active)').matches,
      adjustment: getComputedStyle(host).forcedColorAdjust,
    };
  });

  expect(forcedColors).toEqual({ mediaActive: true, adjustment: 'auto' });
});

test('light host keeps paper tables white', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>
      :root { color-scheme: light; }
      #app { background: rgb(255, 255, 255); color: rgb(0, 0, 0); }
    </style>
    <div id="app">
      <div id="mail-content"></div>
    </div>
  `);

  const computed = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#mail-content');
    if (!host) throw new Error('mail-content host missing');
    host.style.backgroundColor = 'rgb(255, 255, 255)';
    host.style.color = 'rgb(0, 0, 0)';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<table bgcolor="#FFFFFF"><tbody><tr><td><span data-legacy-copy="true">Readable</span></td></tr></tbody></table>';

    const text = root.querySelector<HTMLElement>('[data-legacy-copy="true"]');
    const table = root.querySelector<HTMLElement>('table');
    if (!text || !table) throw new Error('legacy fixture missing');

    return {
      tableBackground: getComputedStyle(table).backgroundColor,
      textColor: getComputedStyle(text).color,
    };
  });

  expect(computed).toEqual({
    tableBackground: 'rgb(255, 255, 255)',
    textColor: 'rgb(0, 0, 0)',
  });
});
```

If Playwright cannot resolve the TS import, paste `MAIL_PAPER_NEUTRALIZE_STYLE`'s string literal into the evaluate call instead of importing. Do not change selectors.

- [ ] **Step 3: Run tests to verify they fail**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
pnpm --filter @zero/mail exec playwright test --config=playwright.mail-content-theme.config.ts
```

Expected: Vitest FAIL — dark shadow innerHTML lacks `data-nava-mail-paper`. Playwright dark test FAIL — table still `rgb(255, 255, 255)` until the style is prepended in the evaluate payload (the import supplies the style; if the import works, the dark Playwright test may already pass as a CSS-contract test even before React wiring). The rendering test is the React wiring proof and must be red.

- [ ] **Step 4: Wire prepend + theme-dependent shadow write**

In `apps/mail/components/mail/mail-content.tsx`:

```ts
import { MAIL_PAPER_NEUTRALIZE_STYLE } from '@/lib/mail/mail-paper-neutralize';
```

After `resolvedHtml` is computed, add:

```ts
  const shadowHtml = useMemo(() => {
    if (!resolvedHtml) return resolvedHtml;
    return processingTheme === 'dark'
      ? `${MAIL_PAPER_NEUTRALIZE_STYLE}${resolvedHtml}`
      : resolvedHtml;
  }, [processingTheme, resolvedHtml]);
```

Replace the innerHTML effect so it writes `shadowHtml` and depends on it:

```ts
  useEffect(() => {
    if (!shouldRenderContent || !shadowRootRef.current || !shadowHtml) return;

    shadowRootRef.current.innerHTML = shadowHtml;
  }, [shadowHtml, shouldRenderContent]);
```

Do not interpolate `resolvedHtml` into the style tag. Prefix only.

- [ ] **Step 5: Re-run Task 2 tests**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
pnpm --filter @zero/mail exec playwright test --config=playwright.mail-content-theme.config.ts
```

Expected: PASS. Dark table computed background is not `rgb(255, 255, 255)` (typically `rgba(0, 0, 0, 0)`). Tinted cell stays `rgb(18, 52, 29)`. Light test still white table + black text. `forced-color-adjust` remains `auto`.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/components/mail/mail-content.tsx apps/mail/tests/mail-content-rendering.test.tsx apps/mail/tests/mail-content-cache-key-contract.test.ts apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts apps/mail/lib/mail/mail-paper-neutralize.ts
git commit -m "$(cat <<'EOF'
fix(mail): neutralize paper bgcolor in dark reader

Let Outlook white wrapper tables show the themed canvas instead of a white slab.
EOF
)"
```

---

### Task 3: Update the Calibri solution boundary

**Files:**
- Modify: `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md`

**Interfaces:**
- Consumes: Task 1–2 behavior.
- Produces: docs that no longer describe a fixed light-paper `MailContent` host as current.

- [ ] **Step 1: Replace items 5–6 and the Boundary paragraph**

Replace:

```
5. `MailContent` owns the fixed light-paper display surface (`#ffffff` / `#000000` / `color-scheme: light`) so a dark Zero shell cannot produce white text on retained white legacy mail.
6. `.ProseMirror` — Calibri 11pt; color inherits theme.

Boundary: fixed host guarantees only legacy light-paper inherited-text case. It intentionally does no dynamic per-node contrast rewriting and makes no recoloring or contrast guarantee for arbitrary retained dark/tinted `bgcolor` templates.
```

with:

```
5. `MailContent` follows the app theme (`bg-background` / `text-foreground`). Dark theme prepends paper-`bgcolor` neutralize CSS (`#ffffff` / `#fff` / `#fffffe` / `white`, case-insensitive, plus hashless hex twins) so Outlook wrapper tables do not recreate a white canvas or white-on-white text. `mailBodyDisplayStyleTag()` stays typography-only and must not force reader color.
6. `.ProseMirror` — Calibri 11pt; color inherits theme.

Boundary: host theme + paper neutralize covers unstyled mail and default Outlook white wrappers. It intentionally does no per-node contrast rewriting and makes no recoloring or contrast guarantee for arbitrary retained dark/tinted `bgcolor` templates.
```

In Related, add:

```
- Reader dark theme: `docs/superpowers/plans/2026-08-26-mail-reader-dark-theme.md`
```

- [ ] **Step 2: Commit**

```bash
git add docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md
git commit -m "$(cat <<'EOF'
docs(mail): record theme-following reader host

Stop describing isolation light-paper as the current MailContent contract.
EOF
)"
```

---

### Task 4: Final verification

**Files:** none new.

- [ ] **Step 1: Re-run the full focused gate**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts tests/collapse-quoted-html.test.ts
pnpm --filter @zero/mail exec playwright test --config=playwright.mail-content-theme.config.ts
pnpm --filter @zero/mail exec eslint components/mail/mail-content.tsx lib/mail/mail-paper-neutralize.ts tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts tests/e2e/mail-content-theme-isolation.spec.ts
```

Expected: all green. `process-email-html-font` still contains `bgcolor="#ffffff"` (sanitize contract). Dark quote CSS remains covered by `collapse-quoted-html.test.ts`.

- [ ] **Step 2: Grep forbidden regressions**

```bash
rg "backgroundColor: '#ffffff'|const processingTheme = 'light'|fixNonReadableColors" apps/mail/components/mail/mail-content.tsx apps/mail/lib
```

Expected: no matches.

Manual canary (not a gate): dark theme, short unstyled thread, Outlook-table thread; light theme both still paper. Compose and print out of scope.

---

## Self-review

- R1–R3 → Task 1 host. R4/R5/R7 → Task 2 Playwright. R6 → `processingTheme` restore + existing `collapse-quoted-html.test.ts`. R8 → sanitizer/MIME untouched. R9 → cache key still includes `processingTheme`.
- C1 (theme-dependent shadow write) is Task 2 `shadowHtml` memo. C2 (`i` + hashless) is the CSS module.
- No TBD / implement later. No second color engine.
- Residual (tinted `bgcolor` + missing foreground, near-whites like `#f7f7f7`, dark logos on dark canvas) stays documented, not implemented.
