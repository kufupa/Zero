// Quick-search orchestration for the HMS header search, shared by cancel-stay.mjs and stay-lookup.mjs. Pure: the page
// actions and the panel check are passed in, so the order of attempts and the window decision are tested without a
// browser (quick-search.test.mjs). The DOM actions themselves live in cancel-stay.mjs.
import { windowCovers } from './cancel-stay-rules.mjs';

// Tried in this order when the panel does not open after the term is typed. Enter is never one of them: with a single
// match it opens the record, which the lookups must not do by accident.
export const QUICK_NUDGES = ['arrowDown', 'clickInside', 'headerRun'];

// actions: { type(), arrowDown(), clickInside(), headerRun() }, each a page action. ready() waits for the panel and
// returns what it found; done(result) says whether that is enough. A result with executed set is a panel whose search
// ran (rows, or "There are no records to display"): nudges cannot change it, so none runs. Returns the last result, the
// stages that ran, and whether the search is done.
export async function driveQuickSearch(actions, { ready, done }) {
  const stages = ['typed'];
  await actions.type();
  let result = await ready();
  for (const nudge of QUICK_NUDGES) {
    if (done(result) || result?.executed) break;
    await actions[nudge]();
    stages.push(nudge);
    result = await ready();
  }
  return { result, stages, done: done(result) };
}

const found = (probe) => Boolean(probe.open || probe.row);
const hasRow = (probe) => Boolean(probe.row);

// The whole confirmation search (cancel-stay.mjs find, preview and commit). io.drive(term, {needRow, done}) runs one
// term through the header search with driveQuickSearch. io.panelShown(), io.window() and io.moveWindow() check and move
// the panel's date window. The order: the typed confirmation; when that finds nothing and the surname is known, the
// surname, where the row with the exact confirmation is taken; when a panel shows a window that misses arrival, the
// window moves and the same term is searched again. An open record for the confirmation is never moved.
export async function runConfirmationSearch(io, { confirmation, lastName = null, arrival = null, allowOpenRecord = true }) {
  const stages = [];
  let method = 'quick';
  let term = confirmation;
  const needRowFor = (current) => !allowOpenRecord || current !== confirmation;
  let run = await io.drive(confirmation, { needRow: needRowFor(confirmation), done: found });
  stages.push(...run.stages);
  let probe = run.result;
  if (!run.done && lastName) {
    term = lastName;
    run = await io.drive(lastName, { needRow: true, done: hasRow });
    stages.push(...run.stages.map((stage) => `surname.${stage}`));
    probe = run.result;
    if (run.done) method = 'quick_surname';
  }
  // Lookups without an arrival never move the window.
  if (arrival && !probe.open && (await io.panelShown())) {
    const window = await io.window();
    if (windowAction({ window, arrival, panelShown: true }) === 'move') {
      await io.moveWindow();
      const moved = await io.drive(term, { needRow: needRowFor(term), done: found });
      stages.push(...moved.stages.map((stage) => `window.${stage}`));
      if (found(moved.result)) {
        probe = moved.result;
        method = 'quick_calendar';
      }
    }
  }
  return { probe, method, stages };
}

// The dropdown row whose confirmation is exactly the wanted one. Null when none, and AMBIGUOUS when more than one matches.
export const AMBIGUOUS = Symbol('ambiguous');

export function pickConfirmationRow(rows, confirmation) {
  const hits = rows.filter((row) => row.confirmation === confirmation);
  if (hits.length === 0) return null;
  return hits.length === 1 ? hits[0] : AMBIGUOUS;
}

// What to do with the panel's date window. It moves only when a panel shows a readable window that does not cover the
// arrival day. Without an arrival, or without a readable window, the window stays as it is.
export function windowAction({ window, arrival, panelShown }) {
  if (!panelShown || !arrival || !window) return 'keep';
  return windowCovers(window, arrival) ? 'keep' : 'move';
}
