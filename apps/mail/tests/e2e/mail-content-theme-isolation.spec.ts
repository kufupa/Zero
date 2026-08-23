import { expect, test } from '@playwright/test';

test('dark app chrome cannot turn unstyled white-paper mail text white', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>
      :root { color-scheme: dark; }
      #app { background: rgb(20, 20, 20); color: rgb(255, 255, 255); }
    </style>
    <div id="app">
      <div
        id="mail-content"
        style="background-color: #ffffff; color: #000000; color-scheme: light;"
      ></div>
    </div>
  `);

  const computed = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#mail-content');
    if (!host) throw new Error('mail-content host missing');

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<table bgcolor="#ffffff"><tbody><tr><td><span data-legacy-copy="true">Readable</span><input data-native-control="true"></td></tr></tbody></table>';

    const text = root.querySelector<HTMLElement>('[data-legacy-copy="true"]');
    const table = root.querySelector<HTMLElement>('table');
    const nativeControl = root.querySelector<HTMLInputElement>('[data-native-control="true"]');
    if (!text || !table || !nativeControl) throw new Error('legacy fixture missing');

    return {
      hostBackground: getComputedStyle(host).backgroundColor,
      hostColor: getComputedStyle(host).color,
      hostColorScheme: getComputedStyle(host).colorScheme,
      tableBackground: getComputedStyle(table).backgroundColor,
      textColor: getComputedStyle(text).color,
      nativeControlColorScheme: getComputedStyle(nativeControl).colorScheme,
    };
  });

  expect(computed).toEqual({
    hostBackground: 'rgb(255, 255, 255)',
    hostColor: 'rgb(0, 0, 0)',
    hostColorScheme: 'light',
    tableBackground: 'rgb(255, 255, 255)',
    textColor: 'rgb(0, 0, 0)',
    nativeControlColorScheme: 'light',
  });

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
