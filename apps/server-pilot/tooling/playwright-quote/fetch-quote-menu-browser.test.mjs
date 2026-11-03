import test from 'node:test';
import assert from 'node:assert/strict';
import { openHotelAvailability, playwright } from './fetch-quote.mjs';

test('opens the intended availability screen while the menu moves under the pointer', async (t) => {
  const browser = await playwright().chromium.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.setDefaultTimeout(1000);
  await page.setContent(`
    <a class="app-menu-trigger">Menu</a>
    <span class="x-tree-node-text" style="display:block">Front Desk</span>
    <span id="hotel" class="x-tree-node-text" style="display:block;height:40px">Hotel Availability</span>
    <script>
      window.opened = 0;
      const readyAt = performance.now() + 300;
      hotel.addEventListener('pointerdown', () => {
        if (performance.now() >= readyAt) return;
        const movingRow = document.createElement('div');
        movingRow.style.height = '40px';
        hotel.before(movingRow);
      });
      hotel.addEventListener('click', () => {
        window.opened += 1;
        document.body.insertAdjacentHTML('beforeend', '<h1>Hotel Availability</h1><input name="dates">');
      });
    </script>`);
  await openHotelAvailability(page);
  assert.equal(await page.evaluate(() => window.opened), 1);
});
