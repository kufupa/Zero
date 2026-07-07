import { expect, type Page } from '@playwright/test';

export async function dismissMailOnboarding(page: Page) {
  await page.waitForTimeout(1000);

  const skipTour = page.getByRole('button', { name: 'Skip for now' });
  if (await skipTour.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipTour.click();
    await page.waitForTimeout(500);
    return;
  }

  const legacyWelcome = page.getByText('Welcome to Zero Email!');
  if (await legacyWelcome.isVisible({ timeout: 1000 }).catch(() => false)) {
    await page.locator('body').click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(500);
  }
}

export async function expectPilotInboxVisible(page: Page) {
  await expect(
    page.getByRole('link', { name: 'Inbox', exact: true }).first(),
  ).toBeVisible({ timeout: 15000 });
}
