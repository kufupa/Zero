// Read document names from the already-open stay; never download or change them.
import { openStay360RecordTab } from './stay360-record-tabs.mjs';
import { dismissNotesOrThrow, takeHandledNotes } from '../playwright-quote/stay360-notes.mjs';

export async function readDocumentsFromStay360(page, confirmation) {
  const { frame, notes } = await openStay360RecordTab(page, confirmation, 'Documents');
  const waitForLoadedTree = async () => {
    try {
      await frame.waitForFunction(() => {
        const components = (globalThis.Ext?.ComponentQuery?.query('treepanel') || []).filter((component) => component.isVisible?.(true));
        if (components.length !== 1) return false;
        const store = components[0].getStore?.();
        return Boolean(store?.getRootNode?.()?.isLoaded?.()) &&
          typeof store.isLoading === 'function' && !store.isLoading();
      }, null, { timeout: 25000 });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error('DOCUMENT_TREE_NOT_LOADED');
      throw error;
    }
  };
  await waitForLoadedTree();
  // HMS can render the tab before its initial refresh begins.
  await page.waitForTimeout(1200);
  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
  await waitForLoadedTree();
  const result = await frame.evaluate(() => {
    const components = (globalThis.Ext?.ComponentQuery?.query('treepanel') || []).filter((component) => component.isVisible?.(true));
    if (components.length !== 1) throw new Error('DOCUMENT_TREE_NOT_UNIQUE');
    const store = components[0].getStore?.();
    const root = store?.getRootNode?.();
    if (!root?.isLoaded?.() || typeof store.isLoading !== 'function' || store.isLoading()) {
      throw new Error('DOCUMENT_TREE_NOT_LOADED');
    }
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const documents = [];
    let unloadedFolders = 0;
    root.cascadeBy((node) => {
      if (!node.isLeaf()) {
        if (!node.isLoaded?.()) unloadedFolders += 1;
        return;
      }
      const data = node.data || {};
      const label = clean(data.text);
      const parsed = label.match(/^(\d+):\s*(.+)$/);
      const name = clean(data.documentFileName) || parsed?.[2] || null;
      const documentCode = clean(data.documentcode) || clean(data.documentCode) || parsed?.[1] || null;
      if (!name && !documentCode) return; // HMS can render a placeholder leaf for an empty folder.
      documents.push({ name, documentCode, label });
    });
    return {
      documents,
      hasUnloadedFolders: unloadedFolders > 0,
      coverage: {
        status: unloadedFolders ? 'partial' : documents.length ? 'loaded' : 'empty',
        loadedDocuments: documents.length,
        unloadedFolders,
        unnamedDocuments: documents.filter((document) => !document.name).length,
        complete: null,
      },
      captureScope: 'Loaded document tree nodes only; full coverage and additional pages are not verified.',
    };
  });
  notes.push(...await takeHandledNotes(page));
  return { ...result, notes };
}
