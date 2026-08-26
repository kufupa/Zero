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
