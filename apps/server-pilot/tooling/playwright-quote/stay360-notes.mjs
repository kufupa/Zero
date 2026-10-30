// Shared handling for the read-only Notes popup, including popups inside record frames.
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const handlers = new WeakMap();

function saveNotePrivately(note) {
  const explicitRoot = process.env.STAY360_PRIVATE_ROOT;
  const privateRoot = explicitRoot || fileURLToPath(new URL('../../../../.private/', import.meta.url));
  const noteRoot = join(privateRoot, 'stay360-confirmation');
  // The workspace .private directory can be shared; the notes child must be private.
  for (const directory of explicitRoot ? [privateRoot, noteRoot] : [noteRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('NOTE_PRIVATE_DIRECTORY_UNSAFE');
  }
  const directory = mkdtempSync(join(noteRoot, 'note-'));
  const path = join(directory, 'note.json');
  writeFileSync(path, JSON.stringify(note, null, 2), { mode: 0o600, flag: 'wx' });
  return path;
}

// Only dismiss the explicitly titled Notes dialog, never an unrelated prompt.
export async function dismissNotesOrThrow(root, { allowRecordFrame = false } = {}) {
  const page = typeof root.page === 'function' ? root.page() : root;
  const state = handlers.get(page);
  let release;
  if (state) {
    while (state.activeDismissal) await state.activeDismissal;
    state.activeDismissal = new Promise((resolve) => { release = resolve; });
    state.handling = true;
  }
  try {
    const dialogs = root.locator('.x-window:visible:not(.x-menu)');
    const notes = [];
    let noteDialog = null;
    let recordFrames = 0;
    for (let index = 0, count = await dialogs.count(); index < count; index += 1) {
      const dialog = dialogs.nth(index);
      const frames = dialog.locator('iframe:visible');
      if (allowRecordFrame && await frames.count() === 1) {
        const isRecordFrame = await frames.evaluate((element) => {
          const url = new URL(element.src, location.href);
          return url.origin === location.origin && url.searchParams.get('initpath') === 'OSRESV';
        });
        if (isRecordFrame && ++recordFrames === 1) continue;
      }
      const titles = dialog.locator('.x-window-header-text:visible');
      const title = await titles.count() === 1 ? (await titles.innerText()).trim() : '';
      if (!/^(Note|Notes)$/.test(title) || noteDialog) throw new Error('UNEXPECTED_DIALOG');
      noteDialog = dialog;
    }
    if (noteDialog) {
      const close = noteDialog.locator('a.x-btn:visible').filter({ hasText: /^Close$/ });
      if (await close.count() !== 1) throw new Error('NOTE_CLOSE_NOT_UNIQUE');
      const note = await noteDialog.evaluate((element) => ({
        title: element.querySelector('.x-window-header-text')?.innerText.trim() || '',
        text: element.innerText.trim(),
        fields: [...element.querySelectorAll('input:not([type="hidden"]):not([type="password"]), textarea, select')]
          .filter((field) => field.getBoundingClientRect().width && field.getBoundingClientRect().height)
          .map((field) => ({
            name: field.name || null,
            type: field.type || field.tagName.toLowerCase(),
            value: field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value,
          })),
      }));
      note.privateCapture = saveNotePrivately(note);
      notes.push(note);
      const handle = await noteDialog.elementHandle();
      await close.click();
      await handle.waitForElementState('hidden');
    }
    return notes;
  } finally {
    if (state) {
      state.handling = false;
      state.activeDismissal = null;
      release();
    }
  }
}

function scanNotes(page, state) {
  if (state.scanPromise) return state.scanPromise;
  if (state.handling || state.failure || page.isClosed()) return Promise.resolve();
  const scan = (async () => {
    try {
      let origin;
      try { origin = new URL(page.url()).origin; } catch { /* The main page may be navigating. */ }
      const roots = [page, ...page.frames().filter((frame) => {
        if (frame === page.mainFrame()) return false;
        try { return new URL(frame.url()).origin === origin; } catch { return false; }
      })];
      for (const root of roots) {
        if (root !== page && root.isDetached()) continue;
        try {
          const titles = root.locator('.x-window:visible:not(.x-menu) .x-window-header-text:visible')
            .filter({ hasText: /^(Note|Notes)$/ });
          if (!await titles.count()) continue;
          const notes = await dismissNotesOrThrow(root, { allowRecordFrame: root === page });
          state.notes.push(...notes);
          state.closedCount += notes.length;
        } catch (error) {
          if (root !== page && root.isDetached()) continue;
          throw error;
        }
      }
    } catch (error) {
      if (page.isClosed()) return;
      // Stop the flow if a popup cannot be handled safely.
      state.failure = error;
      await page.close().catch(() => {});
    }
  })();
  state.scanPromise = scan;
  void scan.then(() => { if (state.scanPromise === scan) state.scanPromise = null; });
  return scan;
}

// Handle Notes during action retries and passive waits, including inside record frames.
export async function installStay360NotesHandler(page) {
  let state = handlers.get(page);
  if (state) return state.ready;
  state = { notes: [], handling: false, activeDismissal: null, scanPromise: null,
    failure: null, closedCount: 0, ready: null };
  handlers.set(page, state);
  state.ready = (async () => {
    await page.addLocatorHandler(page.locator('body'), async () => {
      if (!state.handling) await scanNotes(page, state);
    }, { noWaitAfter: true });
    if (page.isClosed()) return;
    const timer = setInterval(() => { void scanNotes(page, state); }, 400);
    timer.unref();
    page.once('close', () => clearInterval(timer));
  })();
  try {
    await state.ready;
  } catch (error) {
    handlers.delete(page);
    throw error;
  }
}

export async function takeHandledNotes(page) {
  const state = handlers.get(page);
  if (!state) return [];
  if (state.scanPromise) await state.scanPromise;
  while (state.activeDismissal) await state.activeDismissal;
  if (state.failure) throw state.failure;
  return state.notes.splice(0);
}

export function notesHandlerFailure(page) {
  return handlers.get(page)?.failure ?? null;
}

export function notesHandlerStats(page) {
  return { automaticallyClosed: handlers.get(page)?.closedCount ?? 0 };
}
