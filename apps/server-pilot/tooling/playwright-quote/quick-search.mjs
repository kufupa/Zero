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

// ISO date plus a number of days (UTC, so no daylight saving shifts).
export function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The two 60-day windows that cover arrival plus or minus 60 days: one starting 60 days before arrival (it ends on the
// arrival) and one starting on the arrival (it ends 60 days after it). The panel windows are 60 days long.
export function windowStartsAround(arrival, days = 60) {
  return [addDaysIso(arrival, -days), arrival];
}

// The whole confirmation search (cancel-stay.mjs find, preview and commit). io.drive(term, {needRow, done}) runs one
// term through the header search with driveQuickSearch. io.panelShown() says whether a panel is showing, and
// io.moveWindow(startIso) moves the panel's date window to start on that day. The order:
//   1. when arrival is known and a panel is showing, each window of windowStartsAround(arrival);
//   2. otherwise the confirmation in the default window, then those arrival windows if a panel appears;
//   3. the confirmation in the original window again (arrival is only a hint);
//   4. when it is still not there and the surname is known, the surname.
// The arrival is only a hint for the windows. The match is on the confirmation number alone. An open record for the
// confirmation is used as it stands and never moves the window.
export async function runConfirmationSearch(io, { confirmation, lastName = null, arrival = null, allowOpenRecord = true }) {
  const stages = [];
  const drive = async (term, prefix, done) => {
    const run = await io.drive(term, { needRow: !allowOpenRecord || term !== confirmation, done });
    stages.push(...run.stages.map((stage) => (prefix ? `${prefix}.${stage}` : stage)));
    return run;
  };
  let probe = { open: null, row: null, executed: false };
  // Arrival-known searches move the 60-day window first (U4). Confirmation-only
  // search in the default (today) window misses 2028 stays and then opens the
  // calendar row, which times out (STALE_SCREEN, findMethod=quick_calendar).
  if (arrival && (await io.panelShown())) {
    for (const start of windowStartsAround(arrival)) {
      await io.moveWindow(start);
      const run = await drive(confirmation, `window.${start}`, found);
      if (run.done) return { probe: run.result, method: 'quick', stages };
      probe = run.result;
    }
  } else {
    const run = await drive(confirmation, '', found);
    if (run.done) return { probe: run.result, method: 'quick', stages };
    probe = run.result;
    if (arrival && (await io.panelShown())) {
      for (const start of windowStartsAround(arrival)) {
        await io.moveWindow(start);
        const again = await drive(confirmation, `window.${start}`, found);
        if (again.done) return { probe: again.result, method: 'quick', stages };
        probe = again.result;
      }
    }
  }
  if (arrival) {
    const original = await drive(confirmation, 'original', found);
    if (original.done) return { probe: original.result, method: 'quick', stages };
    probe = original.result;
  }
  if (lastName) {
    const surnameRun = await drive(lastName, 'surname', hasRow);
    if (surnameRun.done) return { probe: surnameRun.result, method: 'quick_surname', stages };
    probe = surnameRun.result;
  }
  return { probe, method: 'quick', stages };
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
