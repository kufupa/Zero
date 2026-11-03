import test from 'node:test';
import assert from 'node:assert/strict';
import { stageSavedAdultForComposition } from './guest-stay-amend-adults.mjs';
import { matchesComposedDateAdultDraft, stageSavedDatesForComposition } from './guest-stay-amend-date-room-rate.mjs';
import { runLabtestAmendSave } from './labtest-amend-save.mjs';

const expected = { arrival: '2027-01-18', departure: '2027-01-20', adults: 1 };
const before = () => ({
  data: { arrivaldate: '01/18/2027', departuredate: '01/20/2027', adults: '1', nights: '2',
    arrivaldayofweek: 'Mon', departuredayofweek: 'Wed', grandtotal: '500', tax: '0', ratetax: '0',
    enablecheckavailability: '0', confirmationnumber: '20270000001-1', companyid: '', emailaddress: '', udfchkbox04: '0' },
  values: { arrivaldate: '18-JAN-2027', departuredate: '20-JAN-2027', adults: '1', nights: '2',
    arrivaldayofweek: 'Mon', departuredayofweek: 'Wed', grandtotal: '500.00', tax: '0.00',
    confirmationnumber: '20270000001-1', companyid: '', emailaddress: '', udfchkbox04: '0' },
  partyControls: [], partyInputsBlank: true, formDirty: false, recordDirty: false, dirtyFields: [], modifiedFields: [],
});
const staged = (sync = false) => {
  const value = before();
  Object.assign(value.values, { departuredate: '21-JAN-2027', nights: '3', departuredayofweek: 'Thu', grandtotal: '', tax: '' });
  Object.assign(value.data, { ratetax: '', enablecheckavailability: '-1' });
  value.formDirty = value.recordDirty = true;
  value.dirtyFields = ['departuredate', 'nights', 'departuredayofweek', 'grandtotal', 'tax'];
  value.modifiedFields = ['ratetax', 'enablecheckavailability'];
  if (sync) {
    Object.assign(value.data, { departuredate: '01/21/2027', nights: '3', departuredayofweek: 'Thu', grandtotal: '', tax: '' });
    value.modifiedFields.push('departuredate', 'nights', 'departuredayofweek', 'grandtotal', 'tax');
  }
  return value;
};

test('observed cleared prices and exact date changes are accepted only at the proper sync stage', () => {
  assert.equal(matchesComposedDateAdultDraft(before(), staged(), expected, { departure: '2027-01-21' }, { synced: false }), true);
  assert.equal(matchesComposedDateAdultDraft(before(), staged(), expected, { departure: '2027-01-21' }), false);
  assert.equal(matchesComposedDateAdultDraft(before(), staged(true), expected, { departure: '2027-01-21' }), true);
  const combined = staged(true);
  combined.data.adults = combined.values.adults = '2';
  combined.modifiedFields.push('adults'); combined.dirtyFields.push('adults');
  assert.equal(matchesComposedDateAdultDraft(before(), combined, expected, { departure: '2027-01-21', adults: 2 }), true);
});

test('identity, parties, send flag, price and unapproved or inconsistent date changes fail closed', () => {
  for (const [part, key, value] of [
    ['data', 'confirmationnumber', '20270000002-1'], ['data', 'companyid', 'other'],
    ['data', 'emailaddress', 'guest@example.invalid'], ['data', 'udfchkbox04', '1'],
    ['data', 'grandtotal', '501'], ['values', 'nights', '4'], ['values', 'departuredayofweek', 'Fri'],
    ['values', 'departuredate', '22-JAN-2027'], ['data', 'ArrivalDate', '01/18/2027'],
  ]) {
    const draft = staged(true); draft[part][key] = value;
    assert.equal(matchesComposedDateAdultDraft(before(), draft, expected, { departure: '2027-01-21' }), false, `${part}.${key}`);
  }
  const extraDirty = staged(true); extraDirty.modifiedFields.push('emailaddress');
  assert.equal(matchesComposedDateAdultDraft(before(), extraDirty, expected, { departure: '2027-01-21' }), false);
  const changedControls = staged(true); changedControls.partyControls.push({ name: 'company', value: 'other' });
  assert.equal(matchesComposedDateAdultDraft(before(), changedControls, expected, { departure: '2027-01-21' }), false);
});

test('no caller can stage adult or date edits outside the active saved-stay lifecycle', async () => {
  const forged = { isActive: () => true, remainingMs: () => 1000, baseline: before(), frame: {}, page: {} };
  await assert.rejects(stageSavedAdultForComposition(forged, expected, 2), /AMEND_STAGE_NOT_ACTIVE/);
  await assert.rejects(stageSavedDatesForComposition(forged, expected, { departure: '2027-01-21' }), /AMEND_STAGE_NOT_ACTIVE/);
});

test('a fenced prepare-only lifecycle stages and synchronizes a date without clicking Save', async () => {
  let draft = before(), clicks = 0;
  const input = { count:async () => 1, fill:async () => { draft = staged(); }, press:async () => {},
    evaluate:async (_callback, arg) => {
      if (typeof arg === 'string') return { componentDate:'2027-01-21', formModelDate:'2027-01-21' };
      if (arg?.before) { assert.deepEqual(arg.before, draft); draft = staged(true); }
      return true;
    } };
  const frame = { locator:(selector) => selector.startsWith('input[') ? input : { count:async () => 0 },
    evaluate:async (_callback, arg) => Array.isArray(arg) ? structuredClone(draft) : performance.now() };
  const save = { click:async () => { clicks += 1; } };
  const context = { route:async () => {}, unroute:async () => {} };
  const page = { context:() => context, route:async () => {}, unroute:async () => {},
    locator:() => ({ count:async () => 1 }), on:() => {}, off:() => {}, waitForTimeout:async () => {} };
  const result = await runLabtestAmendSave(page, {
    prepareOnly:true, prepare:async () => ({ frame, save, baseline:before(), enableComposedStage:true }),
    stage:async (_bounded, _prepared, stageContext) => stageSavedDatesForComposition(stageContext, expected, { departure:'2027-01-21' }),
    matches:() => false, validate:async () => true,
  });
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'PREPARE_ONLY');
  assert.equal(clicks, 0);
  assert.equal(draft.data.departuredate, '01/21/2027');
});

for (const [label, changes, order] of [
  ['forward', { arrival: '2027-01-19', departure: '2027-01-20' }, ['departuredate', 'arrivaldate']],
  ['backward with adults', { arrival: '2027-01-17', departure: '2027-01-18', adults: 2 }, ['arrivaldate', 'departuredate']],
]) {
  test(`one-night ${label} shift stages both dates under the fence`, async () => {
    const initial = { arrival: '2027-01-18', departure: '2027-01-19', adults: 1 };
    const base = before();
    Object.assign(base.data, { departuredate: '01/19/2027', nights: '1', departuredayofweek: 'Tue' });
    Object.assign(base.values, { departuredate: '19-JAN-2027', nights: '1', departuredayofweek: 'Tue' });
    let draft = structuredClone(base), clicks = 0;
    const days = { arrival: initial.arrival, departure: initial.departure }, stagedOrder = [], intermediate = [];
    const wire = (day) => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
    const display = (day) => `${day.slice(8, 10)}-JAN-${day.slice(0, 4)}`;
    const weekday = (day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${day}T00:00:00Z`).getUTCDay()];
    const markDirty = () => {
      draft.dirtyFields = Object.keys(draft.values).filter((key) => draft.values[key] !== base.values[key]);
      draft.modifiedFields = Object.keys(draft.data).filter((key) => draft.data[key] !== base.data[key]);
      draft.formDirty = draft.dirtyFields.length > 0;
      draft.recordDirty = draft.modifiedFields.length > 0;
    };
    const applyDates = (part) => {
      const format = part === 'data' ? wire : display;
      Object.assign(draft[part], { arrivaldate: format(days.arrival), departuredate: format(days.departure),
        nights: String((Date.parse(`${days.departure}T00:00:00Z`) - Date.parse(`${days.arrival}T00:00:00Z`)) / 86400000),
        arrivaldayofweek: weekday(days.arrival), departuredayofweek: weekday(days.departure) });
    };
    const controls = Object.fromEntries(['arrival', 'departure'].map((name) => [name, {
      count: async () => 1,
      fill: async (value) => { assert.equal(value, display(changes[name])); days[name] = changes[name];
        draft.data.enablecheckavailability = '-1'; applyDates('values'); markDirty(); stagedOrder.push(`${name}date`); },
      press: async () => {},
      evaluate: async (_callback, arg) => {
        if (typeof arg === 'string') return { componentDate: days[name], formModelDate: days[name] };
        if (arg?.before) { assert.deepEqual(arg.before, draft); intermediate.push(structuredClone(draft));
          applyDates('data'); markDirty(); }
        return true;
      },
    }]));
    const frame = { locator: (selector) => selector.startsWith('input[name="arrivaldate"]') ? controls.arrival :
      selector.startsWith('input[name="departuredate"]') ? controls.departure : { count: async () => 0 },
      evaluate: async (_callback, arg) => Array.isArray(arg) ? structuredClone(draft) : performance.now() };
    const save = { click: async () => { clicks += 1; } };
    const context = { route: async () => {}, unroute: async () => {} };
    const page = { context: () => context, route: async () => {}, unroute: async () => {},
      locator: () => ({ count: async () => 1 }), on: () => {}, off: () => {}, waitForTimeout: async () => {} };
    const result = await runLabtestAmendSave(page, {
      prepareOnly: true, prepare: async () => ({ frame, save, baseline: base, enableComposedStage: true }),
      stage: async (_bounded, _prepared, stageContext) => {
        let preceding = null;
        if (changes.adults) {
          draft.data.adults = draft.values.adults = String(changes.adults);
          draft.data.enablecheckavailability = '-1'; markDirty(); preceding = structuredClone(draft);
        }
        return stageSavedDatesForComposition(stageContext, initial, changes, preceding);
      },
      matches: () => false, validate: async () => true,
    });
    assert.equal(result.outcome, 'not_dispatched');
    assert.equal(result.issue, 'PREPARE_ONLY');
    assert.deepEqual(stagedOrder, order);
    assert.equal(intermediate.length, 2);
    assert.equal(intermediate[1].data.nights, '2');
    assert.equal(intermediate[1].values.nights, '1');
    assert.equal(draft.data.nights, '1');
    assert.ok(draft.dirtyFields.includes('arrivaldate') && draft.dirtyFields.includes('departuredate'));
    assert.equal(clicks, 0);
  });
}
