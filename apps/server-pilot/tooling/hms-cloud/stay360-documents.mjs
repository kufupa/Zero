// Read document names from the already-open stay; never download or change them.
import { openStay360RecordTab } from './stay360-record-tabs.mjs';
import { dismissNotesOrThrow, takeHandledNotes } from '../playwright-quote/stay360-notes.mjs';
import { observeDocumentRefresh } from './stay360-document-refresh.mjs';

export async function readDocumentsFromStay360(page, confirmation, { identity } = {}) {
  const observer = identity === undefined ? null : observeDocumentRefresh(page, confirmation, identity);
  try {
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
      const observedNodes = [];
      let unloadedFolders = 0;
      let unrecognizedLeaves = 0;
      let metadataIssues = 0;
      let metadataValues = 0;
      let metadataKeys = 0;
      let metadataCharacters = 0;
      let omittedNodes = 0;
      const unsupported = (reason) => {
        metadataIssues += 1;
        return { type: 'unsupported', reason };
      };
      // Tagged values keep null, undefined, absent fields, whitespace and nested
      // values distinct across Playwright serialization. Unsupported data is
      // reported rather than silently converted into a usable empty value.
      const capture = (value, ancestors = new Set(), depth = 0) => {
        metadataValues += 1;
        if (metadataValues > 20000 || depth > 12) return unsupported('capture_limit');
        if (value === null) return { type: 'null' };
        if (value === undefined) return { type: 'undefined' };
        if (typeof value === 'string') {
          metadataCharacters += value.length;
          if (metadataCharacters > 2000000) return unsupported('capture_limit');
          return { type: 'string', value };
        }
        if (typeof value === 'boolean') return { type: 'boolean', value };
        if (typeof value === 'number') return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
        if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
        if (typeof value !== 'object') return unsupported(typeof value);
        if (ancestors.has(value)) return unsupported('circular');
        try {
          if (value instanceof Date) return Number.isNaN(value.getTime())
            ? unsupported('invalid_date') : { type: 'date', value: value.toISOString() };
          const array = Array.isArray(value);
          const prototype = Object.getPrototypeOf(value);
          if (!array && prototype !== Object.prototype && prototype !== null) return unsupported('object_type');
          const next = new Set(ancestors);
          next.add(value);
          const fields = [];
          for (const key of Reflect.ownKeys(value)) {
            metadataKeys += 1;
            if (metadataKeys > 20000) {
              fields.push({ key: null, value: unsupported('capture_limit') });
              break;
            }
            if (typeof key !== 'string') {
              fields.push({ key: null, value: unsupported('symbol_key') });
              continue;
            }
            metadataCharacters += key.length;
            if (metadataCharacters > 2000000) {
              fields.push({ key: null, value: unsupported('capture_limit') });
              break;
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
              fields.push({ key, value: unsupported('accessor') });
              continue;
            }
            fields.push({ key, value: capture(descriptor.value, next, depth + 1) });
            if (metadataValues > 20000) break;
          }
          return { type: array ? 'array' : 'object', fields };
        } catch {
          return unsupported('inspection_failed');
        }
      };
      root.cascadeBy((node) => {
        const leaf = node.isLeaf();
        let observation;
        if (observedNodes.length < 10000) {
          observation = { leaf, documentIndex: null, data: capture(node.data) };
          observedNodes.push(observation);
        } else {
          omittedNodes += 1;
        }
        if (!leaf) {
          if (!node.isLoaded?.()) unloadedFolders += 1;
          return;
        }
        const data = node.data || {};
        const label = clean(data.text);
        const parsed = label.match(/^(\d+):\s*(.+)$/);
        const name = clean(data.documentFileName) || parsed?.[2] || null;
        const documentCode = clean(data.documentcode) || clean(data.documentCode) || parsed?.[1] || null;
        if (!name && !documentCode) {
          // HMS renders "No Documents" as a leaf; other unknown leaves cannot prove emptiness.
          if (!/^no\s+documents?[.!]?$/i.test(label)) unrecognizedLeaves += 1;
          return;
        }
        // No native identifier has been proven stable across refreshes and sessions.
        const description = clean(data.description) || null;
        if (observation) observation.documentIndex = documents.length;
        documents.push({ name, documentCode, documentId: null, description, label });
      });
      return {
        documents,
        observedNodes,
        hasUnloadedFolders: unloadedFolders > 0,
        coverage: {
          status: unloadedFolders || unrecognizedLeaves || metadataIssues || omittedNodes
            ? 'partial' : documents.length ? 'loaded' : 'loaded_empty',
          metadataCapture: metadataIssues || omittedNodes ? 'partial' : 'captured',
          metadataIssues,
          omittedNodes,
          loadedDocuments: documents.length,
          unloadedFolders,
          unrecognizedLeaves,
          unnamedDocuments: documents.filter((document) => !document.name).length,
          refreshVerified: false,
          complete: null,
        },
        captureScope: 'Loaded document tree nodes only; refresh and full coverage are not verified.',
      };
    });
    notes.push(...await takeHandledNotes(page));
    // A correlated HTTP response is a network observation, not a tree freshness or coverage proof.
    result.coverage.refreshObservation = observer ? observer.result(frame) : { status: 'not_requested' };
    return { ...result, notes };
  } finally {
    observer?.stop();
  }
}
