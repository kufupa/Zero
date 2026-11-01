import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { readFolioFromStay360 } from './stay360-folio.mjs';

// Offline Ext-style fixture exercises the actual record-tab and Folio readers.
async function withFolio(config, work) {
  const record = `<!doctype html><html><body>
    <button class="x-tab x-tab-active" id="record">Record View</button>
    <button class="x-tab" id="folio">Folio</button>
    <div id="record-view"><input name="confirmationnumber" value="${config.recordConfirmation || 'CONF-TEST'}"></div>
    <div id="folio-view" hidden>
      <input name="foliototal" value="0.00"><input name="foliototalcurr" value="ZAR">
      <input name="guestcurrencyestimatetotal" value=""><input name="guestestimatetotalcurr" value="ZAR">
      <div class="x-grid" id="folio-grid">
        <input name="dataspylist" value="Standard Folios"><input name="filterfields" value="Line">
        <input name="selfiltervaluectrl" value="${config.searchValue || ''}"><input name="ff_line" value="${config.columnFilter || ''}">
        <a class="x-btn" id="run">Run</a>
        <div class="x-column-header-text">Line</div><div class="x-column-header-text">Transaction</div>
        <div class="x-grid-view" style="height:200px;overflow:hidden"></div>
      </div>
    </div>
    <script>
      const config = ${JSON.stringify(config)};
      const record = document.getElementById('record'), folio = document.getElementById('folio');
      function showFolio(active) {
        record.classList.toggle('x-tab-active', !active); folio.classList.toggle('x-tab-active', active);
        document.getElementById('record-view').hidden = active; document.getElementById('folio-view').hidden = !active;
      }
      record.onclick = () => showFolio(false); folio.onclick = () => showFolio(true);
      const listeners = {};
      const store = { currentPage: config.page || 1, pageSize: 25, remoteFilter: false,
        on: (event, fn) => { (listeners[event] ||= []).push(fn); },
        un: (event, fn) => { listeners[event] = (listeners[event] || []).filter((item) => item !== fn); },
        isLoading: () => Boolean(config.loading), getCount: () => config.loaded ?? (config.rows || []).length,
        getTotalCount: () => config.total ?? (config.rows || []).length,
        getFilters: () => ({ items: config.filters || [] }) };
      window.Ext = { getCmp: (id) => id === 'folio-grid' ? { getStore: () => store } : null };
      for (const row of config.rows || []) {
        const element = document.createElement('div'); element.className = 'x-grid-row';
        for (const text of row) { const cell = document.createElement('div'); cell.className = 'x-grid-cell'; cell.textContent = text; element.appendChild(cell); }
        document.querySelector('.x-grid-view').appendChild(element);
      }
      if (config.wireBeforeClick) {
        const params = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'FOL',
          GRID_NAME: 'OSFOLO', GRID_ID: '780', DATASPY_ID: '861', COMPONENT_INFO_TYPE: 'DATA_ONLY',
          confirmationnumber: 'CONF-TEST' });
        fetch('/web/base/OSRESV.FOL.xmlhttp?preclick=1', { method: 'POST', body: params }).then(() => {
          for (const fn of listeners.datachanged || []) fn(store);
          for (const fn of listeners.refresh || []) fn(store);
        });
      }
      document.getElementById('run').onclick = async () => {
        if (config.probeFence) {
          window.postResults = await Promise.all(['/web/base/OSRESV.FOL?pageaction=SAVE', '/web/base/payments'].map((url) =>
            fetch(url, { method: 'POST' }).then(() => 'allowed', () => 'blocked')));
        }
        if (config.runHttpFailure) await fetch('/web/base/OSRESV.FOL', { method: 'POST' });
        if (config.wireRefresh) {
          const params = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'FOL',
            GRID_NAME: 'OSFOLO', GRID_ID: '780', DATASPY_ID: '861', COMPONENT_INFO_TYPE: 'DATA_ONLY',
            confirmationnumber: config.wireWrongConfirmation ? 'OTHER' : 'CONF-TEST' });
          await fetch('/web/base/OSRESV.FOL.xmlhttp', { method: 'POST', body: params });
          for (const fn of listeners.datachanged || []) fn(store);
          for (const fn of listeners.refresh || []) fn(store);
          if (config.wireDuplicateRefresh) for (const fn of listeners.refresh || []) fn(store);
          return;
        }
        if (config.noRefresh) return;
        for (const fn of listeners.beforeload || []) fn(store);
        setTimeout(() => { for (const fn of listeners.load || []) fn(store, [], config.unknownLoad ? undefined : !config.fail); }, 10);
      };
    </script>
  </body></html>`;
  const shell = '<h1 class="recordcode">CONF-TEST</h1><div class="x-window"><iframe style="width:900px;height:900px" src="/record?initpath=OSRESV"></iframe></div>';
  const server = createServer((req, res) => {
    const failedRun = config.runHttpFailure && req.method === 'POST' && req.url === '/web/base/OSRESV.FOL';
    if (req.method === 'POST' && req.url.startsWith('/web/base/OSRESV.FOL.xmlhttp')) {
      const grid = { METADATA: { REQUEST_TYPE_META: 'LIST.DATA_ONLY.STORED', RECORDS: req.url.includes('late=1') ? '1' : '0',
        GRIDID: config.wireWrongGrid ? 'wrong' : '780', GRIDNAME: 'OSFOLO',
        DATASPYID: config.wireWrongDataSpy ? 'other' : '861' },
        DATA: config.wireNonempty || req.url.includes('late=1') ? [{}] : [] };
      const pageData = { fromCome: true, grid: { GRIDRESULT: { type: 'LIST.DATA_ONLY.STORED',
        DATASPY: { id: '861', label: 'Standard Folios' }, GRID: grid } }, messages: null };
      const send = () => {
        res.writeHead(config.wireHttpFailure ? 503 : 200, { 'content-type': 'application/json' });
        res.end(config.wireMalformed ? '{not-json' : JSON.stringify({ pageData }).replace('"pageData":', 'pageData:'));
      };
      if (req.url.includes('preclick=1')) setTimeout(send, 2300);
      else send();
      return;
    }
    res.writeHead(failedRun ? 503 : 200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/record?') ? record : shell);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await work(page);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// Release an extra completed response while leaving the displayed grid untouched.
async function releaseLateFolio(page, frame, evaluate = frame.evaluate.bind(frame)) {
  const finished = page.waitForEvent('requestfinished', {
    predicate: (request) => request.url().includes('OSRESV.FOL.xmlhttp?late=1'), timeout: 5000,
  });
  await evaluate(() => fetch('/web/base/OSRESV.FOL.xmlhttp?late=1', {
    method: 'POST', body: new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'FOL',
      GRID_NAME: 'OSFOLO', GRID_ID: '780', DATASPY_ID: '861', COMPONENT_INFO_TYPE: 'DATA_ONLY',
      confirmationnumber: 'CONF-TEST' }),
  }));
  await finished;
}

test('returns a refreshed empty grid and displayed summary without asserting completeness', async () => {
  await withFolio({}, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'loaded_empty');
    assert.deepEqual(result.paging, { rendered: 0, loaded: 0, total: 0, currentPage: 1, pageSize: 25, displayedRecordStatus: null });
    assert.deepEqual(result.summary.folioBalance, { value: '0.00', currency: 'ZAR' });
    assert.deepEqual(result.summary.folioBalanceInGuestCurrency, { value: '', currency: 'ZAR' });
    assert.equal(result.coverage.complete, null);
    assert.equal(result.coverage.refreshVerified, true);
  });
});

test('preserves visible rows and filter inputs while flagging pagination', async () => {
  await withFolio({ rows: [['1', 'Room charge']], loaded: 2, total: 5, searchValue: 'charge', columnFilter: '1' }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.columns, ['Line', 'Transaction']);
    assert.deepEqual(result.rows, [['1', 'Room charge']]);
    assert.deepEqual(result.paging, { rendered: 1, loaded: 2, total: 5, currentPage: 1, pageSize: 25, displayedRecordStatus: null });
    assert.deepEqual(result.filters.value, ['charge']);
    assert.deepEqual(result.filters.columnInputs, [{ name: 'ff_line', value: '1' }]);
  });
});

test('distinguishes a failed refresh from a refresh never observed', async () => {
  await withFolio({ fail: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST', { timeoutMs: 100 });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'STORE_LOAD_FAILED');
  });
  await withFolio({ noRefresh: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST', { timeoutMs: 100 });
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.reason, 'REFRESH_NOT_VERIFIED');
  });
});

test('refuses an unrelated confirmation before opening Folio', async () => {
  await withFolio({}, async (page) => {
    await assert.rejects(readFolioFromStay360(page, 'WRONG'), /CONFIRMATION_HEADER_MISMATCH/);
  });
});


test('keeps the shared read guard and the Folio request fence in the Run path', async () => {
  await withFolio({ probeFence: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'loaded_empty');
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    assert.deepEqual(await frame.evaluate(() => window.postResults), ['blocked', 'blocked']);
  });
});


test('returns matching loaded rows without claiming the full ledger', async () => {
  await withFolio({ rows: [['1', 'Room charge']] }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'loaded');
    assert.deepEqual(result.rows, [['1', 'Room charge']]);
    assert.equal(result.coverage.complete, null);
  });
});

test('does not call an unreported load success or failure', async () => {
  await withFolio({ unknownLoad: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST', { timeoutMs: 100 });
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.coverage.refreshVerified, false);
  });
  await withFolio({ loading: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST', { timeoutMs: 100 });
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.reason, 'STORE_UNAVAILABLE_OR_LOADING');
  });
});

test('refuses a Record View confirmation that differs from the header', async () => {
  await withFolio({ recordConfirmation: 'OTHER' }, async (page) => {
    await assert.rejects(readFolioFromStay360(page, 'CONF-TEST'), /RECORD_CONFIRMATION_MISMATCH/);
  });
});


test('distinguishes a failed Folio HTTP request from a successful store event', async () => {
  await withFolio({ runHttpFailure: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'FOLIO_REQUEST_FAILED');
    assert.equal(result.coverage.refreshVerified, false);
  });
});

// The Cloud Folio grid updates through datachanged/refresh rather than store load.
test('matches an empty data-only response to the current stay and store refresh', async () => {
  await withFolio({ wireRefresh: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'loaded_empty');
    assert.equal(result.coverage.refreshVerified, true);
    assert.equal(result.coverage.refreshMethod, 'matched_empty_folio_response_and_store_events');
    assert.equal(result.coverage.responseRowCorrelation, 'empty_response_and_empty_grid');
    assert.equal(result.coverage.complete, null);
  });
});

test('does not infer emptiness from an unbound or malformed data-only response', async () => {
  for (const config of [{ wireWrongConfirmation: true }, { wireWrongGrid: true },
    { wireWrongDataSpy: true }, { wireMalformed: true }, { wireNonempty: true }, { wireDuplicateRefresh: true }]) {
    await withFolio({ wireRefresh: true, ...config }, async (page) => {
      const result = await readFolioFromStay360(page, 'CONF-TEST');
      assert.equal(result.status, 'not_loaded');
      assert.equal(result.coverage.refreshVerified, false);
    });
  }
});

test('rejects an extra Folio response arriving after the initial wire check', async () => {
  await withFolio({ wireRefresh: true }, async (page) => {
    const locator = page.locator.bind(page);
    let headerLookups = 0;
    page.locator = (selector, ...args) => {
      const result = locator(selector, ...args);
      if (selector === 'h1.recordcode:visible' && ++headerLookups === 2) {
        const count = result.count.bind(result);
        result.count = async () => {
          const frame = page.frames().find((item) => item.url().includes('initpath=OSRESV'));
          await releaseLateFolio(page, frame);
          return count();
        };
      }
      return result;
    };
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.deepEqual(result.coverage.folioRequests, { observed: 2, failed: 0, pending: 0 });
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.coverage.refreshVerified, false);
    assert.equal(result.coverage.complete, null);
  });
});

test('rejects a request completing while the grid snapshot is in flight', async () => {
  await withFolio({ wireRefresh: true }, async (page) => {
    const frame = page.frames().find((item) => item.url().includes('initpath=OSRESV'));
    const evaluate = frame.evaluate.bind(frame);
    frame.evaluate = async (fn, arg) => {
      const result = await evaluate(fn, arg);
      if (String(fn).includes('FOLIO_GRID_CHANGED')) await releaseLateFolio(page, frame, evaluate);
      return result;
    };
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.deepEqual(result.coverage.folioRequests, { observed: 2, failed: 0, pending: 0 });
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.reason, 'FOLIO_RESPONSE_UNVERIFIED');
    assert.equal(result.coverage.refreshVerified, false);
    assert.equal(result.coverage.complete, null);
  });
});

test('does not infer emptiness when the wire response and visible grid disagree', async () => {
  await withFolio({ wireRefresh: true, rows: [['1', 'Room charge']] }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.coverage.refreshVerified, false);
    assert.deepEqual(result.rows, [['1', 'Room charge']]);
  });
});

test('reports a failed data-only response rather than empty results', async () => {
  await withFolio({ wireRefresh: true, wireHttpFailure: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'FOLIO_REQUEST_FAILED');
  });
});

test('does not attribute a pre-click response to the Run refresh', async () => {
  await withFolio({ wireBeforeClick: true, noRefresh: true }, async (page) => {
    const result = await readFolioFromStay360(page, 'CONF-TEST', { timeoutMs: 2500 });
    assert.equal(result.status, 'not_loaded');
    assert.equal(result.coverage.refreshVerified, false);
  });
});
