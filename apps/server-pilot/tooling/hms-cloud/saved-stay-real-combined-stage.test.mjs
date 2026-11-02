import test from 'node:test';
import assert from 'node:assert/strict';
import { stageRealStayCombinedWithoutSave as stage } from './saved-stay-real-combined-stage.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const expected = { confirmation:'12345678-1', guestId:'42', firstName:'Example', lastName:'Guest',
  arrival:'2026-11-15', departure:'2026-11-20', roomType:'EXKNG', ratePlan:'NCOR1B', adults:1 };
const changes = { departure:'2026-11-21', adults:2 };
function fixture({ stale = false, wrongGuest = false, blocked = false, wrongNative = false, extraField = false,
  pendingTitle = false, pendingCommit = false, dialogCommit = false, executeAdultCallback = false,
  staleBrowserForm = false, duplicateAdultOption = false, executeDateCallback = false, readonlyDate = false,
  wrongNativeField = null } = {}) {
  const data = { propertycode:'HRCEN', status:'Reserved', confirmationnumber:expected.confirmation,
    guestid:wrongGuest ? '99' : expected.guestId, firstname:expected.firstName, lastname:expected.lastName,
    arrivaldate:'11/15/2026', departuredate:'11/20/2026', roomtype:expected.roomType,
    rateplan:expected.ratePlan, adults:'1', other:'original' };
  const values = { ...data, guestid:expected.guestId, arrivaldate:'15-NOV-2026', departuredate:'20-NOV-2026' };
  const snapshot = { data, values, formDirty:false, recordDirty:false, dirtyFields:[], modifiedFields:[],
    partyControls:[{name:'company',value:'Example Company'}], partyInputsBlank:false };
  const pageRoutes = [], contextRoutes = [], events = [], dateEdits = [];
  let reads = 0, dialogHandler, releasePending;
  const pending = () => new Promise((resolve) => { releasePending = resolve; });
  const runAdultCallback = (fn, arg) => {
    const element = { id:'adults-inputEl', name:'adults', value:snapshot.values.adults, offsetWidth:1,
      dispatchEvent:() => {}, disabled:false, readOnly:false };
    const guest = { id:'guest-inputEl', name:'guestid', offsetWidth:1 };
    const records = [{value:'1',display:'1'}, {value:'2',display:'2'}];
    if (duplicateAdultOption) records.push({value:'2',display:'2'});
    const nativeForm = { getValues:() => ({...snapshot.values}), isDirty:() => snapshot.formDirty };
    const record = { data:staleBrowserForm ? {...snapshot.data, other:'stale'} : snapshot.data,
      get dirty() { return snapshot.recordDirty; }, get modified() { return Object.fromEntries(snapshot.modifiedFields.map((name) => [name, true])); },
      set:(name, value) => { snapshot.data[name] = String(value); } };
    const form = { el:{dom:{contains:(el) => el === element}}, getRecord:() => record, getForm:() => nativeForm,
      updateRecord:() => { events.push('adult'); snapshot.values.adults = element.value; snapshot.formDirty = true;
        snapshot.recordDirty = true; snapshot.dirtyFields.push('adults'); snapshot.modifiedFields.push('adults'); } };
    const component = { up:() => form, valueField:'value', displayField:'display',
      store:{getCount:() => records.length, getAt:(index) => records[index]},
      getValue:() => element.value, setValue:(option) => { element.value = option.display; }, fireEvent:() => {} };
    const saved = Object.fromEntries(['Ext','document','getComputedStyle','FocusEvent'].map((key) => [key, globalThis[key]]));
    globalThis.Ext = { getCmp:(id) => id === 'guest' ? {up:() => form} : component };
    globalThis.document = { querySelectorAll:() => [guest] };
    globalThis.getComputedStyle = () => ({visibility:'visible'});
    globalThis.FocusEvent = class { constructor() {} };
    try { return fn(element, arg); } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    }
  };
  const runDateCallback = (fn, arg, name) => {
    const element = { id:'date-inputEl', name, value:snapshot.values[name], disabled:false, readOnly:readonlyDate };
    const guest = { id:'guest-inputEl', name:'guestid', offsetWidth:1, closest:() => null };
    const form = { el:{dom:{contains:(el) => el === element}} };
    const day = () => {
      const parts = element.value.split('-'), months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      return new Date(Number(parts[2]), months.indexOf(parts[1]), Number(parts[0]));
    };
    const component = { up:() => form, getValue:day, getModelData:() => ({[name]:day()}) };
    const saved = Object.fromEntries(['Ext','document','getComputedStyle'].map((key) => [key, globalThis[key]]));
    globalThis.Ext = { getCmp:(id) => id === 'guest' ? {up:() => form} : component };
    globalThis.document = { querySelectorAll:() => [guest] };
    globalThis.getComputedStyle = () => ({visibility:'visible'});
    try { return fn(element, arg); } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    }
  };
  const input = (name) => ({
    count:async () => 1,
    evaluate:async (_fn, arg) => {
      if (name === 'adults' && arg && Object.hasOwn(arg, 'commitChange')) {
        if (executeAdultCallback) return runAdultCallback(_fn, arg);
        if (arg.commitChange) {
          if (pendingCommit || dialogCommit) {
            events.push('adult-pending');
            const task = pending();
            if (dialogCommit) dialogHandler?.({});
            return task;
          }
          events.push('adult'); snapshot.data.adults = String(arg.adults); snapshot.values.adults = String(arg.adults);
          snapshot.formDirty = true; snapshot.recordDirty = true;
          snapshot.dirtyFields.push('adults'); snapshot.modifiedFields.push('adults');
          if (extraField) snapshot.data.other = 'changed';
          if (blocked) await pageRoutes.at(-1)({ abort:async () => events.push('abort') });
        }
        return true;
      }
      if (executeDateCallback && name !== 'adults') return runDateCallback(_fn, arg, name);
      if (typeof arg === 'string') {
        const [day, month, year] = snapshot.values[name].split('-');
        const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const actual = `${year}-${String(months.indexOf(month) + 1).padStart(2, '0')}-${day}`;
        return { componentDate:actual, formModelDate:wrongNative || wrongNativeField === name ? '1900-01-01' : actual };
      }
      return true;
    },
    fill:async (value) => { events.push('date'); dateEdits.push({ name, value }); snapshot.values[name] = value; },
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
  const page = { context:() => context, url:() => ORIGIN, title:async () => pendingTitle ? pending() : 'Infor HMS - HRCEN',
    locator:() => ({count:async () => 1, elementHandle:async () => ({contentFrame:async () => frame})}),
    route:async (_pattern, handler) => { pageRoutes.push(handler); },
    on:(name, handler) => { if (name === 'dialog') dialogHandler = handler; }, waitForTimeout:async () => {} };
  return {page, pageRoutes, contextRoutes, events, dateEdits, release:(value) => releasePending?.(value)};
}

test('stages adult and date in one deny-all context without any Save exception', async () => {
  const f = fixture(); const result = await stage(f.page, expected, changes);
  assert.equal(result.outcome, 'updated_unsaved'); assert.equal(result.saveEligible, false);
  assert.equal(result.saveDispatched, false); assert.equal(result.requiresContextClosure, true);
  assert.deepEqual(f.events, ['adult','date']);
  for (const deny of [f.pageRoutes.at(-1), f.contextRoutes.at(-1)]) {
    let aborted = false;
    await deny({abort:async () => { aborted = true; }, fallback:() => { throw new Error('must not pass'); },
      continue:() => { throw new Error('must not pass'); }});
    assert.equal(aborted, true);
  }
  assert.equal((await stage(f.page, expected, changes)).issue, 'PAGE_ALREADY_USED');
});

test('stages arrival-only and both-date changes in the valid native edit order', async () => {
  const cases = [
    { changes:{ arrival:'2026-11-16', adults:2 }, order:[['arrivaldate','16-NOV-2026']] },
    { changes:{ arrival:'2026-11-16', departure:'2026-11-21', adults:2 },
      order:[['arrivaldate','16-NOV-2026'], ['departuredate','21-NOV-2026']] },
    { changes:{ arrival:'2026-11-22', departure:'2026-11-25', adults:2 },
      order:[['departuredate','25-NOV-2026'], ['arrivaldate','22-NOV-2026']] },
    { changes:{ arrival:'2026-11-20', departure:'2026-11-23', adults:2 },
      order:[['departuredate','23-NOV-2026'], ['arrivaldate','20-NOV-2026']] },
  ];
  for (const scenario of cases) {
    const f = fixture();
    const result = await stage(f.page, expected, scenario.changes);
    assert.equal(result.outcome, 'updated_unsaved');
    assert.equal(result.saveEligible, false);
    assert.deepEqual(f.dateEdits, scenario.order.map(([name, value]) => ({ name, value })));
  }
});

test('rejects mismatched native readback for either changed date', async () => {
  for (const wrongNativeField of ['arrivaldate', 'departuredate']) {
    const f = fixture({ wrongNativeField });
    const result = await stage(f.page, expected, { arrival:'2026-11-16', departure:'2026-11-21', adults:2 });
    assert.equal(result.outcome, 'stage_uncertain');
    assert.equal(result.issue, 'REAL_DATE_DRAFT_UNVERIFIED');
    assert.equal(result.saveEligible, false);
  }
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


test('deadline returns while a browser call is pending and prevents subsequent edits', async () => {
  const f = fixture({pendingTitle:true});
  const result = await stage(f.page, expected, changes, {timeoutMs:10});
  assert.equal(result.outcome, 'not_staged');
  assert.equal(result.issue, 'REAL_STAGE_TIMEOUT');
  assert.equal(result.requiresContextClosure, true);
  f.release('Infor HMS - HRCEN');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events, []);
});

test('native dialog or timeout during adult dispatch yields uncertain and never continues to date', async () => {
  for (const config of [{pendingCommit:true}, {dialogCommit:true}]) {
    const f = fixture(config);
    const result = await stage(f.page, expected, changes, {timeoutMs:20});
    assert.equal(result.outcome, 'stage_uncertain');
    assert.equal(result.issue, config.dialogCommit ? 'UNEXPECTED_DIALOG' : 'REAL_STAGE_TIMEOUT');
    assert.equal(result.requiresContextClosure, true);
    f.release(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.events, ['adult-pending']);
  }
});


test('executes adult browser callback and rejects a stale form or duplicate native option', async () => {
  const valid = fixture({executeAdultCallback:true});
  const success = await stage(valid.page, expected, changes);
  assert.equal(success.outcome, 'updated_unsaved');
  assert.deepEqual(valid.events, ['adult', 'date']);
  for (const config of [{staleBrowserForm:true}, {duplicateAdultOption:true}]) {
    const f = fixture({executeAdultCallback:true, ...config});
    const result = await stage(f.page, expected, changes);
    assert.equal(result.outcome, 'not_staged');
    assert.equal(result.issue, config.staleBrowserForm ? 'ADULT_PREIMAGE_UNVERIFIED' : 'ADULT_OPTION_NOT_UNIQUE');
    assert.deepEqual(f.events, []);
  }
});


test('executes date browser checks and rejects a read-only date control', async () => {
  const valid = fixture({executeAdultCallback:true, executeDateCallback:true});
  assert.equal((await stage(valid.page, expected, changes)).outcome, 'updated_unsaved');
  const blocked = fixture({executeAdultCallback:true, executeDateCallback:true, readonlyDate:true});
  const result = await stage(blocked.page, expected, changes);
  assert.equal(result.outcome, 'stage_uncertain');
  assert.equal(result.issue, 'AMEND_FIELD_UNSUPPORTED');
  assert.deepEqual(blocked.events, ['adult']);
});
