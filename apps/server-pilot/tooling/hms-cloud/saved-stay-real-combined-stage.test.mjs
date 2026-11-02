import test from 'node:test';
import assert from 'node:assert/strict';
import { stageRealStayCombinedWithoutSave as stage } from './saved-stay-real-combined-stage.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const expected = { confirmation:'12345678-1', guestId:'42', firstName:'Example', lastName:'Guest',
  arrival:'2026-11-15', departure:'2026-11-20', roomType:'EXKNG', ratePlan:'NCOR1B', adults:1 };
const changes = { departure:'2026-11-21', adults:2 };
function fixture({ stale = false, wrongGuest = false, blocked = false, wrongNative = false, extraField = false } = {}) {
  const data = { propertycode:'HRCEN', status:'Reserved', confirmationnumber:expected.confirmation,
    guestid:wrongGuest ? '99' : expected.guestId, firstname:expected.firstName, lastname:expected.lastName,
    arrivaldate:'11/15/2026', departuredate:'11/20/2026', roomtype:expected.roomType,
    rateplan:expected.ratePlan, adults:'1', other:'original' };
  const values = { ...data, guestid:expected.guestId, arrivaldate:'15-NOV-2026', departuredate:'20-NOV-2026' };
  const snapshot = { data, values, formDirty:false, recordDirty:false, dirtyFields:[], modifiedFields:[],
    partyControls:[{name:'company',value:'Example Company'}], partyInputsBlank:false };
  const pageRoutes = [], contextRoutes = [], events = [];
  let reads = 0;
  const input = (name) => ({
    count:async () => 1,
    evaluate:async (_fn, arg) => {
      if (name === 'adults' && arg && Object.hasOwn(arg, 'commitChange')) {
        if (arg.commitChange) {
          events.push('adult'); snapshot.data.adults = String(arg.adults); snapshot.values.adults = String(arg.adults);
          snapshot.formDirty = true; snapshot.recordDirty = true;
          snapshot.dirtyFields.push('adults'); snapshot.modifiedFields.push('adults');
          if (extraField) snapshot.data.other = 'changed';
          if (blocked) await pageRoutes.at(-1)({ abort:async () => events.push('abort') });
        }
        return true;
      }
      if (typeof arg === 'string') return { componentDate:'2026-11-21', formModelDate:wrongNative ? '2026-11-20' : '2026-11-21' };
      return true;
    },
    fill:async (value) => { events.push('date'); snapshot.values[name] = value; },
    press:async () => { snapshot.dirtyFields.push(name); },
  });
  const frame = { url:() => `${ORIGIN}/record`, evaluate:async (_fn, arg) => {
    if (arg === undefined) return 1;
    reads++; const result = structuredClone(snapshot);
    if (stale && reads === 2) result.data.guestid = '99';
    return result;
  }, locator:(selector) => {
    if (selector.includes('Save')) throw new Error('Save must not be located');
    return input(selector.split('"')[1]);
  } };
  const context = { _options:{serviceWorkers:'block'}, serviceWorkers:() => [], pages:() => [page],
    route:async (_pattern, handler) => { contextRoutes.push(handler); } };
  const page = { context:() => context, url:() => ORIGIN, title:async () => 'Infor HMS - HRCEN',
    locator:() => ({count:async () => 1, elementHandle:async () => ({contentFrame:async () => frame})}),
    route:async (_pattern, handler) => { pageRoutes.push(handler); }, on:() => {}, waitForTimeout:async () => {} };
  return {page, pageRoutes, contextRoutes, events};
}

test('stages adult and date in one deny-all context without any Save exception', async () => {
  const f = fixture(); const result = await stage(f.page, expected, changes);
  assert.equal(result.outcome, 'updated_unsaved'); assert.equal(result.saveEligible, false);
  assert.equal(result.saveDispatched, false); assert.deepEqual(f.events, ['adult','date']);
  for (const deny of [f.pageRoutes.at(-1), f.contextRoutes.at(-1)]) {
    let aborted = false;
    await deny({abort:async () => { aborted = true; }, fallback:() => { throw new Error('must not pass'); },
      continue:() => { throw new Error('must not pass'); }});
    assert.equal(aborted, true);
  }
  assert.equal((await stage(f.page, expected, changes)).issue, 'PAGE_ALREADY_USED');
});

test('rejects stale or incorrect identity before editing', async () => {
  for (const config of [{stale:true},{wrongGuest:true}]) {
    const f = fixture(config); const result = await stage(f.page, expected, changes);
    assert.equal(result.outcome, 'not_staged'); assert.deepEqual(f.events, []);
  }
});

test('reports uncertain after blocked request, unrelated changes, or wrong native date', async () => {
  for (const config of [{blocked:true},{extraField:true},{wrongNative:true}]) {
    const f = fixture(config); const result = await stage(f.page, expected, changes);
    assert.equal(result.outcome, 'stage_uncertain'); assert.equal(result.saveDispatched, false);
    if (config.blocked || config.extraField) assert.equal(f.events.includes('date'), false);
  }
});

test('rejects unsupported fields and invalid changes before touching page', async () => {
  const f = fixture();
  for (const bad of [{...changes, save:true}, {...changes, childCount:1}, {adults:2, departure:'2026-11-15'},
    {adults:2, departure:'2026-02-30'}, {adults:2, arrival:null, departure:'2026-11-21'},
    {adults:1, departure:'2026-11-21'}]) {
    assert.equal((await stage(f.page, expected, bad)).outcome, 'input_gap');
  }
  assert.deepEqual(f.events, []); assert.equal(f.pageRoutes.length, 0);
});
