import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { readDocumentsFromStay360 } from './stay360-documents.mjs';

test('distinguishes an empty tree from unresolved document nodes', async () => {
  const record = `<!doctype html><html><body>
    <button class="x-tab x-tab-active" id="record">Record View</button>
    <button class="x-tab" id="documents">Documents</button>
    <div id="record-view"><input name="confirmationnumber" value="CONF-TEST"></div>
    <div id="documents-view" hidden>Documents</div>
    <script>
      const recordTab = document.getElementById('record');
      const documentsTab = document.getElementById('documents');
      function showDocuments(active) {
        recordTab.classList.toggle('x-tab-active', !active);
        documentsTab.classList.toggle('x-tab-active', active);
        document.getElementById('record-view').hidden = active;
        document.getElementById('documents-view').hidden = !active;
      }
      recordTab.onclick = () => showDocuments(false);
      documentsTab.onclick = () => showDocuments(true);
      function node(spec) {
        const children = (spec.children || []).map(node);
        return { data: spec.data || {}, isLeaf: () => Boolean(spec.leaf),
          isLoaded: () => spec.loaded !== false,
          cascadeBy(callback) { callback(this); children.forEach((child) => child.cascadeBy(callback)); } };
      }
      let root;
      window.setTree = (children) => { root = node({ children }); };
      const store = { getRootNode: () => root, isLoading: () => false };
      window.Ext = { ComponentQuery: { query: () => [{
        isVisible: () => !document.getElementById('documents-view').hidden,
        getStore: () => store,
      }] } };
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
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    await frame.waitForFunction(() => typeof window.setTree === 'function');
    const read = async (children) => {
      await frame.evaluate((items) => window.setTree(items), children);
      return readDocumentsFromStay360(page, 'CONF-TEST');
    };

    const empty = await read([{ leaf: true, data: { text: 'No Documents' } }]);
    assert.equal(empty.coverage.status, 'loaded_empty');
    assert.equal(empty.coverage.refreshVerified, false);
    assert.equal(empty.coverage.complete, null);
    assert.equal(empty.documents.length, 0);

    const unloaded = await read([{ loaded: false }]);
    assert.equal(unloaded.coverage.status, 'partial');
    assert.equal(unloaded.coverage.unloadedFolders, 1);

    const unknown = await read([{ leaf: true, data: { text: 'Unexpected item' } }]);
    assert.equal(unknown.coverage.status, 'partial');
    assert.equal(unknown.coverage.unrecognizedLeaves, 1);

    const codeOnly = await read([{ leaf: true, data: { documentCode: '73' } }]);
    assert.deepEqual(codeOnly.documents.map(({ name, documentCode }) => ({ name, documentCode })),
      [{ name: null, documentCode: '73' }]);
    assert.equal(codeOnly.coverage.unnamedDocuments, 1);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
