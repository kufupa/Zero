import test from 'node:test';
import assert from 'node:assert/strict';
import { openHotelAvailability, playwright } from './fetch-quote.mjs';

test('opens the intended availability screen while the menu moves under the pointer', async (t) => {
  const browser = await playwright().chromium.launch({ headless: true,
    executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.setDefaultTimeout(1000);
  await page.setContent(`
    <a class="app-menu-trigger">Menu</a>
    <span class="x-tree-node-text" style="display:block">Front Desk</span>
    <span id="hotel" class="x-tree-node-text" style="display:block;height:40px">Hotel Availability</span>
    <script>
      window.opened = 0;
      window.finishedMoving = false;
      let steps = 0;
      const moving = setInterval(() => {
        hotel.style.marginTop = (++steps * 5) + 'px';
      }, 70);
      setTimeout(() => { clearInterval(moving); window.finishedMoving = true; }, 850);
      hotel.addEventListener('click', () => {
        if (!window.finishedMoving) return;
        window.clickedTop = hotel.getBoundingClientRect().top;
        window.opened += 1;
        document.body.insertAdjacentHTML('beforeend', '<h1>Hotel Availability</h1><input name="dates">');
      });
    </script>`);
  await openHotelAvailability(page);
  assert.equal(await page.evaluate(() => window.opened), 1);
  assert.equal(await page.evaluate(() => window.clickedTop), await page.locator('#hotel').evaluate((e) => e.getBoundingClientRect().top));
});
