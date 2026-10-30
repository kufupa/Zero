import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { readGuestFormsFromStay360 } from './stay360-guest-form.mjs';

// Exercise the actual reader and browser waits against a small, offline Ext-style grid.
async function withGuestGrid(config, run) {
  const record = `<!doctype html><html><body>
    <button class="x-tab x-tab-active" id="record">Record View</button>
    <button class="x-tab" id="guest">Guest Details</button>
    <div id="record-view"><input name="confirmationnumber" value="CONF-TEST"></div>
    <div id="guest-view" hidden>
      <div class="x-grid" id="guest-grid">
        <div class="x-column-header-text">First Name</div>
        <div class="x-column-header-text">Last Name</div>
        <div class="x-column-header-text">Primary Guest</div>
      </div>
      <div class="x-form-item"><label>First Name</label><input name="firstname"></div>
      <div class="x-form-item"><label>Last Name</label><input name="lastname"></div>
      <div class="x-form-item"><label>Profile ID</label><input name="guestid"></div>
      <div class="x-form-item"><label>Email</label><input name="emailaddress"></div>
    </div>
    <script>
      const config = ${JSON.stringify(config)};
      const grid = document.getElementById('guest-grid');
      const recordTab = document.getElementById('record');
      const guestTab = document.getElementById('guest');
      function showGuest(active) {
        recordTab.classList.toggle('x-tab-active', !active);
        guestTab.classList.toggle('x-tab-active', active);
        document.getElementById('record-view').hidden = active;
        document.getElementById('guest-view').hidden = !active;
      }
      recordTab.onclick = () => showGuest(false);
      guestTab.onclick = () => showGuest(true);
      const data = config.rows.map((row) => ({ firstname: row.first, lastname: row.last, guestid: row.nativeId || '' }));
      const store = { getAt: (index) => ({ data: data[index] }), getCount: () => data.length, getTotalCount: () => data.length };
      window.Ext = { getCmp: (id) => id === grid.id ? { getStore: () => store } : null };
      window.selectionClicks = 0;
      config.rows.forEach((row, index) => {
        const element = document.createElement('div');
        element.className = 'x-grid-row';
        element.setAttribute('data-recordindex', index);
        for (const value of [row.first, row.last, '']) {
          const cell = document.createElement('div');
          cell.className = 'x-grid-cell';
          cell.textContent = value;
          element.appendChild(cell);
        }
        element.onclick = () => {
          window.selectionClicks += 1;
          grid.querySelectorAll('.x-grid-row').forEach((item) => item.classList.remove('x-grid-row-selected'));
          element.classList.add('x-grid-row-selected');
          setTimeout(() => {
            for (const [name, value] of Object.entries({ firstname: row.first, lastname: row.last,
              guestid: row.profileId || '', emailaddress: row.email })) {
              document.querySelector('input[name="' + name + '"]').value = value;
            }
          }, row.delay || 0);
          if (config.changeGrid && index === 0) setTimeout(() => {
            data[1].lastname = 'Changed';
            grid.querySelectorAll('.x-grid-row')[1].querySelectorAll('.x-grid-cell')[1].textContent = 'Changed';
          }, 100);
        };
        grid.appendChild(element);
      });
    </script>
  </body></html>`;
  const shell = '<h1 class="recordcode">CONF-TEST</h1><div class="x-window"><iframe style="width:900px;height:900px" src="/record?initpath=OSRESV"></iframe></div>';
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url.startsWith('/record?') ? record : shell);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await run(page);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const email = (guest) => guest.form.fields.find((field) => field.name === 'emailaddress').value;

test('does not associate forms with duplicate names lacking unique native IDs', async () => {
  const rows = [
    { first: 'Alex', last: 'Example', profileId: 'one', email: 'one@example.invalid' },
    { first: 'Alex', last: 'Example', profileId: 'two', email: 'two@example.invalid', delay: 900 },
  ];
  await withGuestGrid({ rows }, async (page) => {
    const result = await readGuestFormsFromStay360(page, 'CONF-TEST');
    assert.equal(result.grid.coverage.formsRead, 0);
    assert.equal(result.grid.coverage.unresolvedIdentities, 2);
    assert.deepEqual(result.guests.map((guest) => [guest.error, guest.form]), [
      ['GUEST_IDENTITY_AMBIGUOUS', null], ['GUEST_IDENTITY_AMBIGUOUS', null],
    ]);
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    assert.equal(await frame.evaluate(() => window.selectionClicks), 0);
  });
});

test('waits for each duplicate-name form to match its distinct native ID', async () => {
  const rows = [
    { first: 'Alex', last: 'Example', nativeId: 'one', profileId: 'one', email: 'one@example.invalid' },
    { first: 'Alex', last: 'Example', nativeId: 'two', profileId: 'two', email: 'two@example.invalid', delay: 900 },
  ];
  await withGuestGrid({ rows }, async (page) => {
    const result = await readGuestFormsFromStay360(page, 'CONF-TEST');
    assert.equal(result.grid.coverage.formsRead, 2);
    assert.equal(result.grid.coverage.unresolvedIdentities, 0);
    assert.deepEqual(result.guests.map(email), ['one@example.invalid', 'two@example.invalid']);
    assert.ok(result.guests.every((guest) => guest.identityVerifiedBy === 'row_name_and_native_id'));
  });
});

test('refuses a grid that changes during a form read', async () => {
  const rows = [
    { first: 'Alex', last: 'Example', profileId: 'one', email: 'one@example.invalid' },
    { first: 'Sam', last: 'Sample', profileId: 'two', email: 'two@example.invalid' },
  ];
  await withGuestGrid({ rows, changeGrid: true }, async (page) => {
    await assert.rejects(readGuestFormsFromStay360(page, 'CONF-TEST'), /GUEST_FORM_IDENTITY_CHANGED|GUEST_GRID_CHANGED/);
  });
});
