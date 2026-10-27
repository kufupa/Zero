#!/usr/bin/env node
// Native Playwright quote workflow. Development exports have no import side effects.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAudit } from './audit.mjs';
import { getHmsPropertyRegistration, installRegisteredAvailabilityReadOnlyGuard, resolveSecretSource, validateHmsPropertySecret } from './property-registry.mjs';
import { normalizeQuoteRequest, assessConstraints, sumDisplayedRates, orderOptions, aggregateOutcome, composeAllocation, restrictedNightsOf } from './quote-contract.mjs';
import { attachBorrowedSession, authenticatedShellReady, login, newBorrowedContext, saveSlotStorageState, slotStorageStatePath } from './session-reuse.mjs';
import { lookupActiveProperty, withReadCliPage } from './read-cli-lease.mjs';
import { profileFor } from './property-profile.mjs';

export { withReadCliPage as withLeasedReadPage };

export { attachBorrowedSession, authenticatedShellReady, login, newBorrowedContext, saveSlotStorageState, slotStorageStatePath };

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const exec = promisify(execFile);

export function playwright() {
  if (require('playwright/package.json').version !== '1.63.0') throw new Error('PLAYWRIGHT_VERSION_MISMATCH');
  return require('playwright');
}

export async function readSecret(env = process.env) {
  let raw;
  try {
    const source = resolveSecretSource(env);
    if (source.source === 'file') raw = await readFile(source.path, 'utf8');
    else raw = (await exec('aws', ['secretsmanager', 'get-secret-value',
      '--secret-id', source.secretId, '--region', env.AWS_REGION ?? 'af-south-1',
      '--query', 'SecretString', '--output', 'text'], { timeout: 20000, maxBuffer: 1000000 })).stdout;
    const secret = JSON.parse(raw);
    for (const key of ['loginUrl', 'username', 'password', 'expectedTenant', 'expectedPropertyCode', 'expectedPropertyName']) {
      if (typeof secret[key] !== 'string' || !secret[key]) throw new Error('missing field');
    }
    return source.property ? validateHmsPropertySecret(source.property, secret) : secret;
  } catch { throw new Error('PMS_CREDENTIAL_CONFIGURATION'); }
}

export async function openHotelAvailability(page) {
  await page.locator('a.app-menu-trigger:visible').click();
  const node = (name) => page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) });
  await node('Front Desk').click();
  for (let attempt = 0; attempt < 4 && !(await node('Hotel Availability').count()); attempt += 1) {
    await node('Availability').click();
    await node('Hotel Availability').waitFor({ timeout: 3000 }).catch(() => {});
  }
  await node('Hotel Availability').click();
  await page.locator('input[name="startdate"]:visible').waitFor();
  await page.getByRole('heading',{name:'Hotel Availability',exact:true}).waitFor();
}

export async function applyGuests(page, room) {
  await page.locator('input[name="guests"]:visible').click();
  await page.locator('input[name="adults"]:visible').fill(String(room.adults));
  await page.locator('input[name="children"]:visible').fill(String(room.children));
  await page.locator('input[name="children"]:visible').press('Tab');
  const ages = page.locator('input[role="combobox"][name^="uxcombobox-"]:visible');
  if (await ages.count() !== room.children) throw new Error('CHILD_AGE_CONTROL_COUNT_MISMATCH');
  for (let i=0; i<room.children; i++) {
    await ages.nth(i).locator('xpath=ancestor::table[1]').locator('.x-form-arrow-trigger').click();
    await page.locator('[role="option"]:visible').filter({ hasText: new RegExp(`^${room.childAges[i]}$`) }).click();
  }
  await page.locator('a[id$="-applyBtn"]:visible').click();
}

export async function search(page) {
  // HMS uses anchors without a button role; the hidden companion Search is
  // not actionable. This selector was inspected on the live client screen.
  await page.locator('a.x-btn:visible').filter({ hasText: /^Search$/ }).click();
}

export async function selectSalesStrategy(page, label = 'BAR') {
  const input = page.locator('input[name="salesstrategy"]');
  await input.locator('xpath=ancestor::table[1]').locator('.x-form-arrow-trigger').click();
  const choices=await input.evaluate(e=>Ext.getCmp(e.id.replace(/-inputEl$/,'')).getStore().getRange().map(r=>({value:r.data.value,display:r.data.display})));
  if(process.env.HMS_DUMP_SALES_STRATEGY==='1'){
    const dumpPath=fileURLToPath(new URL('../../../../.private/create-screen/sales-strategy-store.json',import.meta.url));
    await writeFile(dumpPath,JSON.stringify(choices,null,2),{mode:0o600});
  }
  const choice=configuredChoice(choices,label);
  if(!choice){await page.keyboard.press('Escape');throw new Error('UNSUPPORTED_SALES_STRATEGY');}
  await page.getByRole('option',{name:choice.display,exact:true}).click();
  return input.evaluate(e=>Ext.getCmp(e.id.replace(/-inputEl$/,'')).getValue());
}

export function configuredChoice(choices,value) {
  const matches=choices.filter(c=>c.value===value||c.display===value);
  return matches.length===1?matches[0]:null;
}

export function nativeRestrictedVisibility(request) {return !request.rateContext?.group;}

export function rateRow(page, roomCode, rateCode) {
  if (![roomCode, rateCode].every(x => /^[A-Z0-9_-]+$/.test(x))) throw new Error('UNSUPPORTED_NATIVE_CODE');
  return page.locator(`xpath=//tr[contains(@class,"x-grid-data-row")][.//span[contains(@class,"rateshopping-treecolumn-rateplan-cell") and starts-with(normalize-space(.),"${rateCode}:")]][preceding-sibling::tr[td[contains(@class,"rateshopping-roomtype-cell")]][1]//span[@data-qtip and normalize-space(.)="${roomCode}"]]`);
}

const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
export function displayDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}-${months[Number(month)-1]}-${year}`;
}
export function stayDates(request) {
  const dates = [];
  for (let d = Date.parse(request.arrivalDate); d < Date.parse(request.departureDate); d += 86400000)
    dates.push(new Date(d).toISOString().slice(0,10));
  return dates;
}
export function validateRequest(request) {
  const normalized=normalizeQuoteRequest(request);
  return normalized.ok?[]:normalized.issues.map(i=>i.path);
}

export async function readCalendar(page) {
  return page.evaluate(() => {
    const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const headers = [...document.querySelectorAll('.x-column-header-text')].filter(visible).map(e=>e.textContent.trim()).filter(x=>/^\d\d-[A-Z]{3}-\d{4}/.test(x));
    let room = null;
    const options = [];
    for (const row of document.querySelectorAll('tr.x-grid-data-row')) {
      const cells = [...row.children];
      const roomCell = cells[0]?.matches('.rateshopping-roomtype-cell');
      if (!visible(row)) {if(roomCell)room=null;continue;}
      if (roomCell) {
        const label = cells[0].querySelector('span[data-qtip]');
        room = { code: label?.textContent.trim(), label: label?.getAttribute('data-qtip'), inventory: cells.slice(1).map(e=>e.textContent.trim()) };
      }
      const rate = cells[0]?.querySelector('.rateshopping-treecolumn-rateplan-cell');
      if (rate && room) options.push({ room, rate: rate.textContent.trim(), board: cells[0].querySelector('.mealplan')?.getAttribute('data-qtip') ?? null,
        prices: cells.slice(1).map(e=>e.textContent.trim()) });
    }
    return { headers, options };
  });
}

export async function saveEvidence(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory,name), typeof value === 'string' ? value : JSON.stringify(value,null,2)+'\n', { mode: 0o600 });
}

/** Only the exact value 'on' enables the provisional quote capture. Anything else stays sequential. */
export function quoteTraceAsyncEnabled(env = process.env) {
  return env?.QUOTE_TRACE_ASYNC === 'on';
}

// Milliseconds per phase, written to result.json (phaseMs) and events.jsonl. Searches add to criteria, grid and details, so a
// run with the group search and the public reset reports both. criteriaReset and criteriaShot are inside criteria; criteriaReset
// also counts the trailing public reset. A phase that never ran stays 0.
export const QUOTE_PHASES = ['secret', 'cdp', 'login', 'nav', 'criteria', 'criteriaReset', 'criteriaShot', 'grid', 'details', 'traceFinish'];
export function createPhaseClock(now = () => performance.now()) {
  const ms = Object.fromEntries(QUOTE_PHASES.map((name) => [name, 0]));
  return {
    ms,
    async time(name, work) {
      const started = now();
      try { return await work(); } finally { ms[name] += Math.round(now() - started); }
    },
  };
}

/**
 * The quote capture as it stands before the trace is finished: audit status 'pending', no trace
 * hash. Returns null unless the outcome is still a quote after the screenshot contract. It reads
 * audit state only; the trace is still stopped and sanitized by audit.finish() afterwards.
 */
export function provisionalQuoteCapture({result,audit,directory,started,now=Date.now()}) {
  if(result?.outcome!=='quote') return null;
  const provisional=applyQuoteScreenshotContract({...result,audit:audit.snapshot(),elapsedMs:now-started,evidenceDirectory:directory});
  return provisional.outcome==='quote'?provisional:null;
}

export function normalizePrice(displayed, currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const symbol=/^[R$€£]/.exec(displayed)?.[0];
  const expectedSymbol=({ZAR:'R',USD:'$',AUD:'$',EUR:'€',GBP:'£'})[currency];
  if(symbol&&expectedSymbol&&symbol!==expectedSymbol)return null;
  const match = /^(?:R|\$|€|£)?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/.exec(displayed);
  return match ? {displayed,amount:match[1].replaceAll(',',''),currency,basis:'per_room_per_night'} : null;
}
function displayedSourceAmount(value) {
  const match=/^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return null;
  const fraction=(match[2]??'').padEnd(3,'0');
  const minor=BigInt(match[1])*100n+BigInt(fraction.slice(0,2))+(fraction[2]>='5'?1n:0n);
  return `${minor/100n}.${String(minor%100n).padStart(2,'0')}`;
}
export function unknownTotals() { return {wholeStay:null,allRooms:null,taxInclusive:null}; }

export function projectCriteria(raw) {
  const keys = ['propertyCodes','startDate','numberOfDays','lengthOfStay','adultCount','childCount','childAges',
    'salesStrategy','roomTypeCodes','ratePlanCodes','groupID','organizationID','travelAgencyID','currency',
    'convertFromPropertyCurrency','shopByDay','showRestrictedSellOptions','showExclusiveRates'];
  return Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));
}

export function assertApplied(request, room, criteria, {resolvedContext={},startDate=request.arrivalDate,roomCodes='',rateCodes='',strategy}={}) {
  if (request.rateContext?.group&&request.search?.salesStrategy) throw new Error('UNSUPPORTED_GROUP_SALES_STRATEGY');
  const label=request.search?.salesStrategy??(request.rateContext?'Preset':'BAR');
  const salesStrategy=strategy!==undefined?strategy:request.rateContext?.group?null:({
    BAR:'BAR',Preset:'PRESET',Promotions:'PROMO',Wholesale:'WS','Negotiated Contracted':'CON',
    'Negoticated Contracted':'CON','Group & Convention':'GNC',Government:'GOV','Comp / House Use':'CMPHS',
    'Airline Crews':'AIR','Domestic Leisure':'DOML',Other:'OTH'})[label];
  if (salesStrategy===undefined) throw new Error('UNVERIFIED_SALES_STRATEGY');
  const expected = {propertyCodes:request.propertyCode,startDate:`${startDate}T00:00:00`,
    adultCount:room.adults,childCount:room.children,salesStrategy,lengthOfStay:'DY',shopByDay:false,
    roomTypeCodes:roomCodes,ratePlanCodes:rateCodes};
  for (const [kind,key] of Object.entries({organization:'organizationID',agency:'travelAgencyID',group:'groupID'})) {
    if (request.rateContext?.[kind] && resolvedContext[kind]?.id===undefined) throw new Error(`UNRESOLVED_CONTEXT_${kind}`);
    expected[key]=request.rateContext?.[kind]?resolvedContext[kind].id:'';
  }
  for (const [key,value] of Object.entries(expected)) if (criteria[key] !== value) throw new Error(`APPLIED_CRITERIA_MISMATCH_${key}`);
  if (JSON.stringify(criteria.childAges ?? []) !== JSON.stringify(room.childAges)) throw new Error('APPLIED_CRITERIA_MISMATCH_childAges');
  if (request.requestedCurrency) {
    if (criteria.currency!==request.requestedCurrency || criteria.convertFromPropertyCurrency!==true) throw new Error('UNVERIFIED_CURRENCY_CONVERSION');
  } else if (criteria.convertFromPropertyCurrency!==false || criteria.currency!==null) throw new Error('UNVERIFIED_CURRENCY_CONVERSION');
}

async function expandCriteria(page) {
  if (!await page.locator('input[name="salesstrategy"]').isVisible()) {
    await page.locator('a.x-btn:visible').filter({ has: page.locator('.chevron use[href="#icon-caret-down"]') }).click();
  }
}

const normalizedText=value=>String(value??'').trim().replace(/\s+/g,' ').toLowerCase();
export function matchReference(reference,rows) {
  const matches=rows.filter(r=>reference.nativeId!==undefined
    ? String(r.id)===String(reference.nativeId)
    : reference.code!==undefined
      ? r.code===reference.code
      : normalizedText(r.name)===normalizedText(reference.name));
  if (matches.length!==1) {
    const error=new Error(matches.length?'AMBIGUOUS_REFERENCE':'REFERENCE_NOT_FOUND');
    error.candidates=matches.map(r=>({code:r.code,name:r.name}));throw error;
  }
  return matches[0];
}

const contextControls={
  organization:{field:'organization',nameFilter:'ff_companyname',codeFilter:'ff_companyid',idFilter:'ff_companyid',id:'companyid',code:'companyid',name:'companyname'},
  agency:{field:'travelagency',nameFilter:'ff_travelagencyname',codeFilter:'ff_iatanumber',id:'travelagencyid',code:'iatanumber',name:'travelagencyname'},
  group:{field:'groupname',nameFilter:'ff_groupsname',codeFilter:'ff_confirmationnumber',id:'propgroupbookingid',code:'confirmationnumber',name:'groupsname'},
};

export function searchSignature(request,room) {
  return JSON.stringify({property:request.propertyCode,arrival:request.arrivalDate,departure:request.departureDate,
    adults:room.adults,children:room.children,ages:room.childAges,context:request.rateContext??{},currency:request.requestedCurrency??null,
    strategy:request.search?.salesStrategy??null,
    roomCodes:[...(room.required?.roomCodes??(request.roomCode?[request.roomCode]:[]))].sort(),
    rateCodes:[...(room.required?.rateCodes??(request.rateCode?[request.rateCode]:[]))].sort()});
}

// Agency has no ID filter in HMS: a nativeId is searched by its name, then matched on travelagencyid.
export function pickerFilter(kind,reference) {
  const config=contextControls[kind];
  const filter=reference.nativeId!==undefined&&config.idFilter?{name:config.idFilter,value:reference.nativeId}
    :reference.code!==undefined?{name:config.codeFilter,value:reference.code}
    :{name:config.nameFilter,value:reference.name};
  if (typeof filter.value!=='string'||!filter.value) throw new Error(`REFERENCE_FILTER_MISSING_${kind}`);
  return filter;
}

export async function resolveReference(page,kind,reference) {
  const config=contextControls[kind];
  const {name:filterName,value:filterValue}=pickerFilter(kind,reference);
  await expandCriteria(page);
  const input=page.locator(`input[name="${config.field}"]:visible`);
  await input.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger').click();
  const filter=page.locator(`input[name="${filterName}"]:visible`);
  const popup=page.locator('.x-window:visible').filter({has:filter});
  try {
    await filter.waitFor();
    await filter.fill(filterValue);
    await filter.press('Enter');
    await page.waitForFunction(name=>{
      const input=document.querySelector(`input[name="${name}"]`),win=input?.closest('.x-window');
      const grid=window.Ext?.ComponentQuery.query('grid').find(g=>g.getEl()?.dom.closest(`#${win?.id}`));
      return grid&&!grid.getStore().isLoading()&&!Ext.Ajax.isLoading();
    },filterName);
    // Read the picker store only. All actions remain ordinary UI interactions;
    // whitelist native identities, never contacts/credit-card/session fields.
    const rows=await filter.evaluate((input,cfg)=>{
      const win=input.closest('.x-window');
      const grid=Ext.ComponentQuery.query('grid').find(g=>g.getEl()?.dom.closest(`#${win.id}`));
      return grid.getStore().getRange().map(r=>({id:r.data[cfg.id],code:r.data[cfg.code],name:r.data[cfg.name]}));
    },config);
    const selected=matchReference(reference,rows);
    if (typeof selected.id!=='string'||!selected.id) throw new Error(`MISSING_NATIVE_REFERENCE_ID_${kind}`);
    await popup.getByText(reference.code??selected.name,{exact:true}).dblclick();
    await popup.waitFor({state:'hidden'});
    if (normalizedText(await input.inputValue())!==normalizedText(selected.name)) throw new Error(`REFERENCE_READBACK_MISMATCH_${kind}`);
    return selected;
  } catch(error) {
    error.phase=`${kind}_picker`;
    if (await popup.isVisible()) await popup.locator('a.x-btn').filter({hasText:/^Cancel$/}).click();
    throw error;
  }
}

async function setToggle(page,name,value) {
  const input=page.locator(`input[name="${name}"]:visible`);
  const read=()=>input.evaluate(e=>Ext.getCmp(e.id.replace(/-inputEl$/,'')).getValue());
  if (await read()!==value) await input.click();
  if (await read()!==value) throw new Error(`TOGGLE_READBACK_MISMATCH_${name}`);
}

async function applyCurrency(page,currency) {
  const input=page.locator('input[name="currency"]:visible');
  if (!currency) {await input.fill('');await input.press('Tab');await setToggle(page,'convertcurrency',false);return;}
  await input.locator('xpath=ancestor::table[1]').locator('.x-form-arrow-trigger').click();
  const configured=await input.evaluate(e=>Ext.getCmp(e.id.replace(/-inputEl$/,'')).getStore().getRange().map(r=>({code:r.data.value,label:r.data.display})));
  const entry=configured.find(c=>c.code===currency);
  if (!entry) {await page.keyboard.press('Escape');throw new Error('REQUESTED_CURRENCY_NOT_CONFIGURED');}
  await page.getByRole('option',{name:entry.label,exact:true}).click();
  await setToggle(page,'convertcurrency',true);
}

export async function resetPublicControls(page) {
  await dismissEmptyCalendar(page);
  await expandCriteria(page);
  for (const field of ['groupname','organization','travelagency','roomtypes','rateplans']) {
    const input=page.locator(`input[name="${field}"]`);
    if (await input.inputValue()) {await input.fill('');await input.press('Tab');}
  }
  await applyCurrency(page);
  await selectSalesStrategy(page,'BAR');
  await setToggle(page,'includemultirateoptions',false);
}

export async function readRoomFacts(page,propertyCode) {
  await expandCriteria(page);
  await page.locator('input[name="roomtypes"]:visible').locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger').click();
  const filter=page.locator('input[name="ff_roomtypecode"]:visible');
  await filter.waitFor();
  const popup=page.locator('.x-window:visible').filter({has:filter});
  try {
    await page.waitForFunction(()=>!Ext.Ajax.isLoading());
    return await filter.evaluate((e,property)=>{
      const grid=Ext.ComponentQuery.query('grid').find(g=>g.getEl()?.dom.closest(`#${e.closest('.x-window').id}`));
      return grid.getStore().getRange().map(r=>r.data).filter(r=>r.property===property)
        .map(r=>({code:r.roomtypecode,label:r.roomtypename,property:r.property,bed:r.bedtype}));
    },propertyCode);
  } finally {await popup.locator('a.x-btn:visible').filter({hasText:/^Cancel$/}).click();await popup.waitFor({state:'hidden'});}
}

async function dismissEmptyCalendar(page) {
  if (await page.getByText('Selected criteria is not available for these dates.',{exact:true}).isVisible())
    await page.locator('.x-message-box:visible a.x-btn').filter({hasText:/^OK$/}).click();
}

// The criteria fill for one search: reset, then every field this request needs. Returns the applied values the window loop checks.
async function applyCriteria(page, request, room, criteriaCheckpoint, clock) {
  await clock.time('criteriaReset', () => resetPublicControls(page));
  // Pickers can be date-scoped. Do not resolve this request against a previous
  // group's calendar; selecting a group can then change the date again.
  await page.locator('input[name="startdate"]').fill(displayDate(request.arrivalDate));
  await page.locator('input[name="startdate"]').press('Tab');
  const resolvedContext={};
  // Group changes date/strategy; restore requested occupancy/dates afterward.
  for (const kind of ['group','organization','agency']) if (request.rateContext?.[kind])
    resolvedContext[kind]=await resolveReference(page,kind,request.rateContext[kind]);
  if (request.rateContext?.group&&request.search?.salesStrategy) throw new Error('UNSUPPORTED_GROUP_SALES_STRATEGY');
  const strategy=request.rateContext?.group?null:await selectSalesStrategy(page,request.search?.salesStrategy??(request.rateContext?'Preset':'BAR'));
  await page.locator('input[name="startdate"]').fill(displayDate(request.arrivalDate));
  await page.locator('input[name="startdate"]').press('Tab');
  await applyGuests(page,room);
  await applyCurrency(page,request.requestedCurrency);
  // Visibility only. Native false hides whole rows based on the 14-day grid,
  // including offers available for our shorter stay. Enforce restrictions below.
  const showRestricted=nativeRestrictedVisibility(request);
  await setToggle(page,'includemultirateoptions',showRestricted);
  const roomCodes=(room.required?.roomCodes??(request.roomCode?[request.roomCode]:[])).join(',');
  const rateCodes=(room.required?.rateCodes??(request.rateCode?[request.rateCode]:[])).join(',');
  for(const [field,value] of [['roomtypes',roomCodes],['rateplans',rateCodes]]) {
    await page.locator(`input[name="${field}"]`).fill(value);await page.locator(`input[name="${field}"]`).press('Tab');
  }
  if (await page.locator('input[name="propertycodes"]').inputValue()!==request.propertyCode) throw new Error('PROPERTY_MISMATCH');
  await clock.time('criteriaShot', criteriaCheckpoint);
  return {resolvedContext,strategy,roomCodes,rateCodes,showRestricted};
}

export async function searchCalendar(page, request, room, criteriaCheckpoint=async()=>{}, onWindow=async()=>{}, clock=createPhaseClock()) {
  const {resolvedContext,strategy,roomCodes,rateCodes,showRestricted}=await clock.time('criteria',()=>applyCriteria(page,request,room,criteriaCheckpoint,clock));
  const windows=[];
  let expectedStart=request.arrivalDate;
  for (let index=0;index<3;index++) {
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/internalBooking/hotelAvail/inquiryForGrid'&&r.request().method()==='POST',{timeout:45000});
    pending.catch(()=>{});
    const [response]=await clock.time('grid',()=>Promise.all([pending,index===0?search(page):page.locator('a.x-btn[data-qtip="Page Right"]:visible').click()]));
    if(!response.ok())throw new Error(`SEARCH_HTTP_${response.status()}`);
    const criteria=projectCriteria(response.request().postDataJSON());
    assertApplied(request,room,criteria,{resolvedContext,startDate:expectedStart,strategy,roomCodes,rateCodes});
    if(criteria.showRestrictedSellOptions!==showRestricted)throw new Error('RESTRICTED_VISIBILITY_READBACK_MISMATCH');
    if(await page.locator('input[type="password"]:visible').count())throw new Error('SESSION_RETURNED_TO_LOGIN');
    const body=await response.json();
    if(!body.availabilitydata) {
      await clock.time('grid',()=>page.getByText('Selected criteria is not available for these dates.',{exact:true}).waitFor({timeout:15000}));
      windows.push({criteria,data:null,calendar:null});break;
    }
    await clock.time('grid',()=>page.waitForFunction(start=>{
      const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const dates=[...document.querySelectorAll('.x-column-header-text')].filter(visible).map(e=>e.textContent.trim());
      const first=dates.find(t=>/^\d\d-[A-Z]{3}-\d{4}/.test(t));
      return first?.startsWith(start)&&!Ext.Ajax.isLoading()&&![...document.querySelectorAll('.x-mask,.x-mask-msg,.x-loadmask')].some(visible);
    },displayDate(expectedStart),{timeout:30000}));
    const calendar=await clock.time('grid',()=>readCalendar(page));
    windows.push({criteria,data:body.availabilitydata,calendar});
    await onWindow(windows.at(-1),{resolvedContext,index});
    const shown=body.availabilitydata.datesList.slice(0,calendar.headers.length).map(nativeDate);
    if(shown.includes(request.departureDate))break;
    if(!shown.length||!shown.at(-1)||shown.at(-1)>=request.departureDate)break;
    expectedStart=new Date(Date.parse(shown.at(-1))+86400000).toISOString().slice(0,10);
  }
  return {windows,resolvedContext,productFilterMode:'native_codes_then_local_conditions',searchCount:windows.length,
    issues:showRestricted?[]:[issue('GROUP_VISIBILITY_LIMIT','rateContext.group','PMS locks group restricted-visibility off; complete option coverage is unestablished.')]};
}

function nativeDate(value) {
  const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

const issue = (code,path,reason,action='Inspect source evidence or narrow the request.') => ({code,path,reason,action});
const restrictionKeys = ['combClosed','combClosedToArrival','combClosedToDeparture','combMinLOSToArrival',
  'combMinLOSToDeparture','combMaxLOSToArrival','combMaxLOSToDeparture','combMinLOSToThrough','combMaxLOSToThrough'];
const pick = (object,keys) => Object.fromEntries(keys.filter(k=>Object.hasOwn(object??{},k)).map(k=>[k,object[k]]));

// Preserve bounded native labels as observations only, never package/tax/child entitlement.
export function nativeBundleLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0,32).flatMap(value=>{
    if (!value || typeof value!=='object') return [];
    const code=typeof value.code==='string'?value.code.trim().slice(0,64):null;
    const label=typeof value.label==='string'?value.label:typeof value.desc==='string'?value.desc:null;
    if (!label?.trim()) return [];
    return [{...(code?{code}:{}),label:label.trim().slice(0,256)}];
  });
}

export function projectWindow({criteria,data,calendar}) {
  const columns=raw=>Object.fromEntries(Object.entries(raw??{}).filter(([k])=>/^col\d+$/.test(k)).map(([k,v])=>[k,
    pick(v,['value','groupValue','overbookingLimitCount','israteavailable','restricted',...restrictionKeys])]));
  return {criteria:projectCriteria(criteria??{}),calendar,data:data?{datesList:data.datesList,
    children:(data.children??[]).filter(p=>p.isprop&&!p.issummary).map(p=>({...pick(p,['code','desc','currency','isprop','issummary']),
      children:(p.children??[]).map(r=>({...pick(r,['code','desc','buildingCode','roomTypeCategoryCode','isroomtype']),columns:columns(r.columns),
        children:(r.children??[]).map(t=>({...pick(t,['code','desc','currency','currencysymbol','isNegotiatedRate','restricted','haspolicies',
          'ismealplan','ispkg','minLOS','maxLOS','minLeadTime','maxLeadTime','limitedRatePlanRestriction','maxNights','availableLimitNightCount']),nonroombundleslist:nativeBundleLabels(t.nonroombundleslist),columns:columns(t.columns)}))}))}))}:null};
}

export function sourceFacts(option, roomInformation='') {
  // These are exact inspected native labels, not room-code/occupancy guesses.
  const bedLabels = new Map([['One Queen Bed','queen'],['Two Double Beds','double'],['One King Bed','king'],['King Bed','king'],
    ['Two Single Beds','twin'],['One Single Bed','single'],['One Double Bed','double']]);
  const lines=new Set(roomInformation.split('\n').map(x=>x.trim()));
  const bedType=[...bedLabels].find(([label])=>lines.has(label))?.[1];
  const boardBase=({'Bed & Breakfast R':'breakfast','Bed & Breakfast NR':'breakfast','Room Only R':'room_only','Dinner Bed & Breakfast R':'dinner_bed_breakfast','Dinner, Bed & Breakfast R':'dinner_bed_breakfast','Dinner, Bed, Breakfast & Beverage R':'dinner_bed_breakfast'})[option.board];
  return {roomCode:option.room.code,rateCode:option.rate.code,bedType,boardBase,
    features:[{name:'room_description',value:option.room.label}]};
}

function rateAvailability(rate,nightly,departure,quantity,nights) {
  if (nightly.some(n=>n.inventory<quantity)) return {status:'unavailable'};
  if (rate.restricted===true) return {status:'restricted',reason:'Rate is explicitly restricted by HMS.'};
  const closedNight=nightly.find(n=>n.restricted===true||n.rateAvailable===false||n.restrictions.combClosed===true);
  if (closedNight) return {status:'restricted',reason:`HMS closes or restricts night ${closedNight.date}.`};
  if (nightly[0]?.restrictions.combClosedToArrival===true)
    return {status:'restricted',reason:'HMS closes the requested arrival date to arrivals.'};
  if (departure?.combClosedToDeparture===true)
    return {status:'restricted',reason:'HMS closes the requested departure date to departures.'};

  const minTests=[
    ['Rate minimum stay',rate.minLOS],
    ['Arrival minimum stay',nightly[0]?.restrictions.combMinLOSToArrival],
    ['Departure minimum stay',departure?.combMinLOSToDeparture],
    ...nightly.map(n=>[`Night ${n.date} minimum stay`,n.restrictions.combMinLOSToThrough]),
  ];
  const maxTests=[
    ['Rate maximum stay',rate.maxLOS],
    ['Arrival maximum stay',nightly[0]?.restrictions.combMaxLOSToArrival],
    ['Departure maximum stay',departure?.combMaxLOSToDeparture],
    ...nightly.map(n=>[`Night ${n.date} maximum stay`,n.restrictions.combMaxLOSToThrough]),
  ];
  const minViolation=minTests.find(([,limit])=>typeof limit==='number'&&limit>nights);
  if(minViolation) return {status:'restricted',reason:`${minViolation[0]} requires ${minViolation[1]} nights; requested stay is ${nights} nights.`};
  const maxViolation=maxTests.find(([,limit])=>typeof limit==='number'&&limit>0&&limit<nights);
  if(maxViolation) return {status:'restricted',reason:`${maxViolation[0]} allows ${maxViolation[1]} nights; requested stay is ${nights} nights.`};
  if (rate.restricted!==false || !departure || departure.combClosedToDeparture!==false ||
    nightly.some(n=>n.rateAvailable!==true||n.restricted!==false||n.restrictions.combClosed!==false) ||
    nightly[0]?.restrictions.combClosedToArrival!==false ||
    [rate.minLeadTime,rate.maxLeadTime,rate.limitedRatePlanRestriction,rate.maxNights,rate.availableLimitNightCount].some(x=>x!==null&&x!==undefined&&x!==false&&x!==0)) return {status:'unknown'};
  return {status:'available'};
}

const SEARCH_STRATEGY_CODES = Object.freeze({
  BAR: 'BAR', Preset: 'PRESET', Promotions: 'PROMO', Wholesale: 'WS',
  Government: 'GOV', 'Airline Crews': 'AIR', 'Domestic Leisure': 'DOML',
  Other: 'OTHER', 'Negoticated Contracted': 'NC', 'Negotiated Contracted': 'NC',
});

function profileStrategyCode(request) {
  const label = request.search?.salesStrategy;
  if (typeof label !== 'string' || !label) return '';
  return SEARCH_STRATEGY_CODES[label] ?? label.trim().toUpperCase();
}

/** rateScope stays public|contextual|unknown. classifyRate 'government' is only used for eligibility. */
function quoteRateScope(profile, code, strategy, isNegotiatedRate) {
  if (!profile) return 'unknown';
  const classified = profile.classifyRate(code, strategy, isNegotiatedRate);
  if (classified === 'public') return 'public';
  if (classified === 'contextual') return 'contextual';
  return 'unknown';
}

function strategyPartyKind(profile, strategy, code) {
  const row = profile?.rates?.strategies?.[strategy];
  if (!row || !Array.isArray(row.plans) || !row.plans.includes(code)) return null;
  if (row.scope === 'agency') return 'agency';
  if (row.scope === 'company') return 'organization';
  return null;
}

// Merge only native/visible observations. An invalid row is isolated, never a
// reason to throw away verified siblings or manufacture a sold-out response.
export function extractOptions(request,room,windows,resolvedContext={}) {
  const issues=[],candidates=new Map(),wanted=[...stayDates(request),request.departureDate],seenStarts=new Set();
  const profile = profileFor(request.propertyCode);
  const strategyCode = profileStrategyCode(request);
  for (const [windowIndex,window] of windows.entries()) {
    const {data,calendar}=window;
    if (!data || !calendar || !Array.isArray(data.children) || !Array.isArray(data.datesList)) {
      issues.push(issue('NULL_OR_INVALID_CALENDAR',`windows[${windowIndex}]`,'Missing calendar is not proof of unavailable inventory.'));continue;
    }
    const dates=data.datesList.map(nativeDate),headers=calendar.headers;
    if (!headers.length || headers.some((h,i)=>!dates[i]||!h.startsWith(displayDate(dates[i]))) || new Set(dates).size!==dates.length) {
      issues.push(issue('CHANGED_CALENDAR_HEADERS',`windows[${windowIndex}]`,'Visible dates do not match this response.'));continue;
    }
    if (seenStarts.has(dates[0])) issues.push(issue('STALE_CALENDAR_PAGE',`windows[${windowIndex}]`,'Repeated page did not add coverage.'));
    seenStarts.add(dates[0]);
    const property=data.children.find(p=>p.isprop&&!p.issummary&&p.code===request.propertyCode);
    if (!property) {issues.push(issue('PROPERTY_RESULT_MISSING',`windows[${windowIndex}]`,'Requested property absent.'));continue;}
    const windowIds=new Set();
    for (const nativeRoom of property.children??[]) {
      const seenCodes=new Set((nativeRoom.children??[]).map(r=>r.code));
      const rates=[...(nativeRoom.children??[])];
      for (const row of calendar.options) {
        if (row.room?.code!==nativeRoom.code) continue;
        const parsed=/^([A-Z0-9_-]+):\s*(.*)$/.exec(String(row.rate??''));
        if (!parsed || seenCodes.has(parsed[1])) continue;
        if (calendar.options.filter(o=>o.room.code===nativeRoom.code&&o.rate.startsWith(`${parsed[1]}: `)).length!==1) continue;
        const columns={};
        let priced=true;
        for (const date of wanted) {
          const idx=dates.indexOf(date);
          if (idx<0) continue;
          const price=normalizePrice(row.prices?.[idx],property.currency);
          if (!price) {priced=false;break;}
          columns[`col${idx+1}`]={value:Number(price.amount)};
        }
        if (!priced) continue;
        rates.push({code:parsed[1],desc:parsed[2].trim(),currency:property.currency,columns});
        seenCodes.add(parsed[1]);
      }
      for (const rate of rates) {
      const id=`${request.propertyCode}:${nativeRoom.code}:${rate.code}`;
      let option=candidates.get(id);
      if (!option) {
        option={id,room:{code:nativeRoom.code,label:nativeRoom.desc,buildingCode:nativeRoom.buildingCode??null},
          rate:{code:rate.code,label:rate.desc,...(nativeBundleLabels(rate.nonroombundleslist).length?{bundleLabels:nativeBundleLabels(rate.nonroombundleslist)}:{})},roomCode:nativeRoom.code,rateCode:rate.code,board:null,
          nightly:[],observations:new Map(),issues:[],held:false,_rate:rate,_nativeRoom:nativeRoom,
          sourceCurrency:property.currency,rateScope:quoteRateScope(profile,rate.code,strategyCode,rate.isNegotiatedRate)};
        candidates.set(id,option);
      }
      if(windowIds.has(id))option.issues.push(issue('AMBIGUOUS_NATIVE_ID',id,'Multiple native rows share this identity.'));
      windowIds.add(id);
      const identityKeys=['desc','currency','isNegotiatedRate','restricted','minLOS','maxLOS','minLeadTime','maxLeadTime','ismealplan','ispkg','maxNights','availableLimitNightCount'];
      if(JSON.stringify(pick(option._rate,identityKeys))!==JSON.stringify(pick(rate,identityKeys))||JSON.stringify(nativeBundleLabels(option._rate.nonroombundleslist))!==JSON.stringify(nativeBundleLabels(rate.nonroombundleslist))||option._nativeRoom.buildingCode!==nativeRoom.buildingCode)
        option.issues.push(issue('RATE_IDENTITY_CHANGED',id,'Rate eligibility, terms or pool identity changed across observations.'));
      // The grid label can differ from native desc for the same code; nightly
      // price/inventory agreement below is the binding proof.
      const dom=calendar.options.filter(o=>o.room.code===nativeRoom.code&&o.rate.startsWith(`${rate.code}: `));
      if (dom.length!==1) {option.issues.push(issue('RATE_NOT_BOUND_TO_VISIBLE_GRID',id,'Native row is hidden, missing or ambiguous.'));continue;}
      option.board=dom[0].board;
      const shown=dom[0].rate.slice(rate.code.length+2).trim();
      option.rate={...(shown&&shown!==rate.desc?{code:rate.code,label:shown,nativeLabel:rate.desc}:{code:rate.code,label:rate.desc}),...(nativeBundleLabels(rate.nonroombundleslist).length?{bundleLabels:nativeBundleLabels(rate.nonroombundleslist)}:{})};
      for (const date of wanted) {
        const idx=dates.indexOf(date);
        if (idx<0||idx>=headers.length) continue;
        const column=rate.columns?.[`col${idx+1}`],inventory=nativeRoom.columns?.[`col${idx+1}`]?.value;
        const price=normalizePrice(dom[0].prices[idx],rate.currency);
        if (!column || !Number.isInteger(inventory) || String(inventory)!==dom[0].room.inventory[idx] || !price ||
          price.amount!==displayedSourceAmount(column.value) || (request.requestedCurrency&&price.currency!==request.requestedCurrency)) {
          option.issues.push(issue('PRICE_OR_INVENTORY_SOURCE_MISMATCH',`${id}:${date}`,'Amount, currency or inventory lacks current visible/native agreement.'));continue;
        }
        const observation={date,inventory,price,sourceAmount:String(column.value),restricted:column.restricted,rateAvailable:column.israteavailable,
          restrictions:pick(column,restrictionKeys)};
        const prior=option.observations.get(date);
        if (prior&&JSON.stringify(prior.fact)!==JSON.stringify(observation)) option.issues.push(issue('OVERLAP_CHANGED',`${id}:${date}`,'Overlapping pages disagree.'));
        else option.observations.set(date,{fact:observation,windowIndex,index:idx});
      }
    }
    }
  }
  const options=[];
  const contextRequested=Object.keys(request.rateContext??{});
  const contextVerified=contextRequested.length>0&&contextRequested.every(k=>resolvedContext[k]?.id!==undefined&&
    windows.every(w=>w.criteria?.[({organization:'organizationID',agency:'travelAgencyID',group:'groupID'})[k]]===resolvedContext[k].id));
  const rateFilter=[...(room.required?.rateCodes??[]),...(request.rateCode?[request.rateCode]:[])];
  const roomFilter=[...(room.required?.roomCodes??[]),...(request.roomCode?[request.roomCode]:[])];
  const strategy=String(request.search?.salesStrategy??'').toUpperCase();
  const unfiltered=!rateFilter.length&&!roomFilter.length&&(strategy===''||strategy==='PRESET')
    &&windows.every(w=>!w.criteria?.ratePlanCodes&&!w.criteria?.roomTypeCodes);
  const coverageIncomplete=issues.some(i=>['NULL_OR_INVALID_CALENDAR','CHANGED_CALENDAR_HEADERS','STALE_CALENDAR_PAGE','PROPERTY_RESULT_MISSING'].includes(i.code));
  const noSpecialRates=!coverageIncomplete&&unfiltered&&contextRequested.length>0&&contextVerified&&candidates.size>0
    &&[...candidates.values()].some(o=>o.rateScope==='public')
    &&[...candidates.values()].every(o=>o.rateScope!=='contextual');
  if(noSpecialRates)issues.push(issue('NO_SPECIAL_RATES','rateContext','No special/negotiated rates for this party. Public BAR is returned.','Tell the guest this is BAR, not a contracted rate.'));
  for (const option of candidates.values()) {
    const missing=wanted.filter(date=>!option.observations.has(date));
    if (missing.length) option.issues.push(issue('INCOMPLETE_DATES',option.id,`Missing nights/departure: ${missing.join(', ')}`));
    const invalid=option.issues.length>0;
    // Keep incomplete identity, not unverified monetary claims.
    option.nightly=invalid?[]:wanted.slice(0,-1).map(d=>option.observations.get(d).fact);
    option.departure=option.observations.get(request.departureDate)?.fact.restrictions??null;
    const availability=invalid?{status:'unknown'}:rateAvailability(option._rate,option.nightly,option.departure,room.quantity,wanted.length-1);
    option.availability=availability.status;
    if(availability.reason)option.availabilityReason=availability.reason;
    const governmentFamily=!contextRequested.length&&windows.every(w=>w.criteria?.salesStrategy==='GOV')&&profile?.classifyRate(option.rate.code,strategyCode,option._rate.isNegotiatedRate,option.rate.label)==='government';
    const requiredKind=strategyPartyKind(profile,strategyCode,option.rate.code);
    const strategyContextOk=!requiredKind||(contextVerified&&contextRequested.includes(requiredKind));
    option.eligibility=invalid?'unknown':governmentFamily||option.rateScope==='public'?'verified':option.rateScope==='contextual'&&contextVerified&&strategyContextOk?'verified':'conditional';
    if (option.availability==='restricted') option.eligibility='conditional';
    Object.assign(option,assessConstraints(room,sourceFacts(option)));
    if (contextRequested.length&&!(option.rateScope==='contextual'&&contextVerified&&strategyContextOk)) {
      // ponytail: a verified party's public row stays bookable as the BAR it is; an unverified context keeps it unresolved.
      if(contextVerified&&option.rateScope==='public') {
        option.conditions.push({kind:'preferred',field:'rateContext',status:'unsatisfied',requested:request.rateContext,evidence:null,reason:noSpecialRates?'No special rates for this party; public BAR is returned.':'Public rate for this party; any contract rate is reported separately.'});
      } else {
        option.conditions.push({kind:'required',field:'rateContext',status:'unknown',requested:request.rateContext,evidence:null,reason:'Public/conditional row does not prove requested contextual entitlement.'});
        if(option.matchStatus==='match') option.matchStatus='unresolved';
      }
    }
    option.calculated=invalid?{ok:false,reason:'incomplete_dates'}:sumDisplayedRates(option.nightly.map(n=>({date:n.date,...n.price})),room.quantity);
    option.displayedSum=option.calculated.ok?option.calculated.perRoom.amount:null;
    option.details={status:'not_requested',room:{status:'not_inspected'},rate:{status:'not_inspected'},meal:{status:'not_inspected'},package:{status:'not_inspected'},policy:{status:'not_inspected'}};
    option.totals=unknownTotals();
    issues.push(...option.issues);
    options.push(option);
  }
  if (!options.length&&!issues.length) issues.push(issue('NO_INTERPRETABLE_ROWS','search','No native/visible candidates; inventory absence is not established.'));
  const blocking=issues.filter(i=>i.code!=='NO_SPECIAL_RATES');
  return {options,issues,completeness:{search:blocking.length?'partial':'complete',requiredFacts:blocking.length?'partial':'complete',
    sourceOptions:candidates.size,examinedOptions:options.length,windowCount:windows.length}};
}

export function selectOption(request, room, data, calendar) {
  // Compatibility for development callers only; the runtime enumerates every
  // option. An ambiguous call no longer silently picks a winning row.
  const parsed=extractOptions(request,room,[{data,calendar}]);
  const options=parsed.options.filter(o=>(!request.roomCode||o.room.code===request.roomCode)&&(!request.rateCode||o.rate.code===request.rateCode));
  if(options.length!==1)throw new Error('EXPLICIT_OPTION_SELECTION_REQUIRED');
  const option=options[0];
  if(!option.departure)throw new Error('DEPARTURE_RESTRICTION_NOT_DISPLAYED');
  if(option.issues.length)throw new Error(option.issues[0].code);
  return {nativeRoom:option._nativeRoom,rate:option._rate,nightly:option.nightly,
    indexes:stayDates(request).map(d=>option.observations.get(d).index),available:option.availability==='available',
    dom:calendar.options.find(o=>o.room.code===option.room.code&&o.rate===`${option.rate.code}: ${option.rate.label}`)};
}

export function limitOptions(ordered,max) {
  const options=ordered.slice(0,max),hidden=ordered.slice(max);
  const quoteEligible=o=>o.matchStatus==='match'&&o.eligibility==='verified'&&o.availability==='available';
  return {options,truncated:hidden.length>0,matchingRowsUnseen:hidden.some(quoteEligible)};
}
// ponytail: a cut alternative is not a cut match, so it must not mark a party read incomplete (OPTION_LIMIT counts as coverage).
export function hiddenRowsMatter(ordered,max){return ordered.slice(max).some(o=>o.matchStatus!=='alternative');}

export function reapplyBedAssessment(option,assessment) {
  const contextConditions=option.conditions.filter(c=>c.field==='rateContext');
  Object.assign(option,assessment);
  option.conditions.push(...contextConditions);
  if(contextConditions.some(c=>c.kind==='required')&&option.matchStatus==='match')option.matchStatus='unresolved';
  return option;
}

export function detailReadBudgetMs(env=process.env) {
  const raw=env?.QUOTE_DETAIL_BUDGET_MS;
  if(raw===undefined||raw==='')return 90_000;
  const n=Number(raw);
  return Number.isFinite(n)&&n>=0?Math.floor(n):90_000;
}

export function unreadDetails() {
  return {status:'not_read',nightly:[],
    room:{status:'not_inspected'},rate:{status:'not_inspected'},
    meal:{status:'not_inspected'},package:{status:'not_inspected'},
    policy:{status:'not_inspected'}};
}

export function detailCandidates(mode,options) {
  return mode==='full'?[...options]:[];
}

export function pricedEligibleOptions(options) {
  return options.filter(o=>o.matchStatus==='match'&&o.eligibility==='verified'&&o.availability==='available'&&o.details?.status!=='not_read');
}

export function groupOutcomeFromOptions(options,{details='summary',searchComplete=true}={}) {
  const eligible=pricedEligibleOptions(options);
  let outcome=eligible.length?'quote':options.length&&options.every(o=>o.matchStatus==='alternative')?'no_match':
    options.some(o=>o.matchStatus==='unresolved'||o.eligibility!=='verified')?'partial':
    options.length&&options.every(o=>o.availability==='unavailable')?'unavailable':'partial';
  const requiredPartial=(details==='full'&&options.some(o=>o.details?.status==='partial'))||
    (options.some(o=>o.matchStatus==='unresolved')&&!eligible.length);
  const requiredFacts=requiredPartial?'partial':'complete';
  if(!searchComplete||requiredFacts!=='complete')outcome='partial';
  return {outcome,eligible,requiredFacts};
}

export async function readDetails(page, chosen, prefix, checkpoint=async()=>{}, cachedRoom) {
  const row=rateRow(page,chosen.nativeRoom.code,chosen.rate.code);
  const rowInformation=await row.locator('td').first().evaluate(e=>({
    rateInfoControlPresent:!!e.querySelector('.cell-info'),
    labels:[...e.querySelectorAll('[data-qtip]')].map(n=>({kind:n.className,text:n.getAttribute('data-qtip')})),
  }));
  const details=[];
  for (const [n,index] of chosen.indexes.entries()) {
    await row.locator('td').nth(index+1).click();
    const [year,month,day]=chosen.nightly[n].date.split('-');
    const selected=page.getByText(new RegExp(`Selected Date : .*${day}-${month}-${year}`));
    await selected.waitFor({timeout:20000});
    const roomLabel=`Room Type : ${chosen.nativeRoom.code} - ${chosen.nativeRoom.desc}`;
    const rateLabel=`Rate Plan : ${chosen.rate.code} - ${chosen.rate.desc}`;
    await page.getByText(roomLabel,{exact:true}).waitFor();
    await page.getByText(rateLabel,{exact:true}).waitFor();
    const panel=page.getByText('Availability Details',{exact:true}).locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," x-panel ")][1]');
    let sourceText=await panel.innerText();
    const roomHeader=panel.locator('.x-panel-header').filter({hasText:/^Room Type$/});
    if(await roomHeader.count()) {
      const collapsed=await roomHeader.evaluate(e=>e.closest('.x-panel')?.classList.contains('x-panel-collapsed'));
      if(collapsed)await roomHeader.click();
      const expanded=await panel.innerText();if(expanded!==sourceText)sourceText+='\n'+expanded;
    }
    details.push({date:chosen.nightly[n].date,selectedDate:await selected.innerText(),room:roomLabel,rate:rateLabel,sourceText});
    await checkpoint(`${prefix}-night-${n+1}-details`);
  }
  if(cachedRoom)return {details,roomInformation:cachedRoom,rowInformation};
  const roomRow=page.getByText(chosen.nativeRoom.code,{exact:true}).locator('xpath=ancestor::tr[1]');
  await roomRow.locator('.cell-info').click();
  const card=page.locator('.x-window:visible').filter({hasText:'Room Type Information'});
  await card.waitFor();
  // Wait for the actual room content, not merely the empty card shell.
  await card.getByText(chosen.nativeRoom.desc,{exact:true}).waitFor();
  const roomInformation=await card.innerText();
  await checkpoint(`${prefix}-room-information`);
  await page.keyboard.press('Escape');
  await card.waitFor({state:'hidden'});
  return {details,roomInformation,rowInformation};
}

export async function runInPage(page, request, directory, event=()=>{}, checkpoint=async name=>{
  await mkdir(join(directory,'screenshots'),{recursive:true,mode:0o700});
  await page.screenshot({path:join(directory,'screenshots',`${name}.png`),fullPage:true,timeout:10000});
}, clock=createPhaseClock(), env=process.env) {
  if(!request.normalizedFrom) {
    const normalized=normalizeQuoteRequest(request);
    if(!normalized.ok)return resultEnvelope({outcome:'input_gap',issues:normalized.issues,
      allocation:{status:'not_selected',reason:'Caller input is invalid; no allocation was checked.',pools:[]},
      searchCompleteness:{status:'not_started',searchCount:0}});
    request=normalized.request;
  }
  const groups=[],cache=new Map(),issues=[],copiedShots=[];
  let fatal=false,searchCount=0;
  for(const [index,room] of request.rooms.entries()) {
    const prefix=`group-${index+1}`,signature=searchSignature(request,room);
    event(`${prefix}-search`);
    try {
      let entry=cache.get(signature);
      const reusedSource=Boolean(entry);
      if(!entry) {
        const details=new Map(),roomCache=new Map(),detailIssues=[];
        let allowedDetails,detailsStartedAt,detailsBudgetDone=false;
        const detailBudgetMs=detailReadBudgetMs(env);
        const source=await searchCalendar(page,request,room,()=>checkpoint(`${prefix}-criteria-applied`),async(window,{resolvedContext,index:windowIndex})=>{
          if(request.details!=='full'||detailsBudgetDone)return;
          if(detailsStartedAt===undefined)detailsStartedAt=performance.now();
          const partial=extractOptions(request,room,[window],resolvedContext);
          if(!allowedDetails)allowedDetails=new Set(detailCandidates('full',partial.options).map(o=>o.id));
          for(const option of partial.options.filter(o=>allowedDetails.has(o.id))) {
            if(performance.now()-detailsStartedAt>=detailBudgetMs){detailsBudgetDone=true;break;}
            const previous=details.get(option.id);
            const seen=new Set(previous?.details.map(d=>d.date)??[]);
            const observations=stayDates(request).filter(d=>!seen.has(d)).map(d=>option.observations.get(d)).filter(Boolean);
            if(!observations.length||option.issues.some(i=>i.code!=='INCOMPLETE_DATES'))continue;
            try {
              const read=await clock.time('details',()=>readDetails(page,{nativeRoom:option._nativeRoom,rate:option._rate,
                nightly:observations.map(o=>o.fact),indexes:observations.map(o=>o.index)},
              `${prefix}-window-${windowIndex+1}-offer-${allowedDetails.size===1?1:[...allowedDetails].indexOf(option.id)+1}`,checkpoint,roomCache.get(option.room.code)));
              roomCache.set(option.room.code,read.roomInformation);
              details.set(option.id,{...read,details:[...(previous?.details??[]),...read.details]});
            } catch(error) {
              detailIssues.push(issue('DETAIL_READ_FAILED',option.id,executionFailure(error,'details').error.message));
              const card=page.locator('.x-window:visible').filter({hasText:'Room Type Information'});
              if(await card.count())await page.keyboard.press('Escape');
            }
          }
        },clock);
        searchCount+=source.searchCount;
        await saveEvidence(directory,`${prefix}-source.json`,{endpoint:'/api/internalBooking/hotelAvail/inquiryForGrid',windows:source.windows.map(projectWindow),resolvedContext:source.resolvedContext});
        let roomFacts=[];
        if(room.required?.bedTypes||room.preferred?.bedTypes)roomFacts=await readRoomFacts(page,request.propertyCode);
        entry={source,details,roomFacts,detailIssues,sourceEvidence:`${prefix}-source.json`,gridShotPrefix:prefix};cache.set(signature,entry);
      }
      if(!entry.roomFacts.length&&(room.required?.bedTypes||room.preferred?.bedTypes))entry.roomFacts=await readRoomFacts(page,request.propertyCode);
      const {source,details,roomFacts,detailIssues}=entry;
      await saveEvidence(directory,`${prefix}-criteria.json`,source.windows.map(w=>w.criteria));
      // A cache hit can refer to an earlier page. Copy the first group's grid
      // bytes instead of screenshotting whatever is on screen now.
      if(!reusedSource&&source.windows.at(-1)?.calendar)await checkpoint(`${prefix}-availability-results`);
      if(reusedSource&&entry.gridShotPrefix)copiedShots.push(...await copyGroupGridShots(directory,entry.gridShotPrefix,prefix));
      const parsed=extractOptions(request,room,source.windows,source.resolvedContext);
      if(source.issues.length){parsed.issues.push(...source.issues);parsed.completeness.search='partial';}
      for(const option of parsed.options) {
        const detail=details.get(option.id),bed=roomFacts.find(r=>r.code===option.room.code)?.bed;
        reapplyBedAssessment(option,assessConstraints(room,sourceFacts(option,detail?.roomInformation??bed??'')));
        option.room.bedType=sourceFacts(option,detail?.roomInformation??bed??'').bedType??null;
        option.room.bedSource=bed??detail?.roomInformation??null;
        option.appliedContext=source.resolvedContext;
        option.conversion={propertyCurrency:option.sourceCurrency,displayCurrency:option.nightly[0]?.price.currency??null,
          convertedByPms:source.windows[0]?.criteria.convertFromPropertyCurrency===true,basis:'PMS response and displayed cents; no local FX'};
        option.stayCoverage={arrivalDate:request.arrivalDate,departureDate:request.departureDate,nights:option.nightly.length,mode:'daily_calendar'};
        option.policies={configuredPolicies:option._rate.haspolicies,cancellation:null,payment:null,dateChanges:null,
          status:detail?'not_shown':'not_inspected'};
        if(request.details==='full') {
          if(!detail) {
            // Unread leftover of the time budget; kept in evidence, excluded from pricing.
            option.details=unreadDetails();
          } else {
            const complete=detail.details.length===stayDates(request).length&&!detail.rowInformation?.rateInfoControlPresent&&option._rate.ispkg!==true;
            option.details={status:complete?'complete':'partial',nightly:detail.details,
              room:{status:'complete',text:detail.roomInformation??null},
              rate:{status:!detail.rowInformation?.rateInfoControlPresent?'not_shown':'not_inspected',label:option.rate.label,
                reason:detail.rowInformation?.rateInfoControlPresent?'Additional information control requires inspection.':'No Rate Plan Information control exposed on inspected native row.'},
              meal:{status:'not_shown',label:option.board,configured:option._rate.ismealplan,reason:'Native meal label shown; no separate detail view exposed.'},
              package:{status:option._rate.ispkg!==true?'not_shown':'not_inspected',configured:option._rate.ispkg},
              policy:{status:!detail.rowInformation?.rateInfoControlPresent?'not_shown':'not_inspected',configured:option._rate.haspolicies,exactText:null},
              inlineEvidence:detail.rowInformation??null};
            if(!complete)option.issues.push(issue('DETAIL_COVERAGE_PARTIAL',option.id,'Full mode requires every requested night and inspection of any extra information/package controls.','Inspect unresolved extra PMS information before promising terms.'));
          }
        }
        option.evidence=[entry.sourceEvidence,`${prefix}-criteria.json`];
        delete option._rate;delete option._nativeRoom;delete option.observations;
      }
      // Assess all examined rows before applying output limits or hiding alternatives.
      // Restricted rows drop out of options unless asked for; a group closed on named nights keeps those nights for staff.
      const restrictedNights=restrictedNightsOf(parsed.options);
      const visible=orderOptions(parsed.options).filter(o=>(request.search.includeAlternatives||o.matchStatus!=='alternative')&&
        (request.search.includeRestricted||o.availability!=='restricted'));
      const {options,truncated,matchingRowsUnseen}=limitOptions(visible,request.maxOptionsPerGroup);
      const groupIssues=[...parsed.issues,...detailIssues,...parsed.options.flatMap(o=>o.issues.filter(i=>i.code==='DETAIL_COVERAGE_PARTIAL'))];
      if(truncated&&hiddenRowsMatter(visible,request.maxOptionsPerGroup))groupIssues.push(issue('OPTION_LIMIT',room.id,'Returned options truncated.','Narrow native room/rate codes or increase maxOptionsPerGroup.'));
      const searchComplete=matchingRowsUnseen?false:parsed.completeness.search==='complete';
      const grouped=groupOutcomeFromOptions(parsed.options,{details:request.details,searchComplete});
      const completeness={...parsed.completeness,returnedOptions:options.length,detailOptions:[...details.keys()].length,
        search:matchingRowsUnseen?'truncated':parsed.completeness.search,requiredFacts:grouped.requiredFacts==='partial'?'partial':parsed.completeness.requiredFacts,matchingRowsUnseen};
      let outcome=grouped.outcome;
      if(completeness.search!=='complete'||completeness.requiredFacts!=='complete')outcome='partial';
      groups.push({id:room.id,request:room,requestedOccupancy:room,outcome,options,applied:source.windows.map(w=>w.criteria),
        resolvedContext:source.resolvedContext,sourceReused:reusedSource,productFilterMode:source.productFilterMode,completeness,issues:groupIssues,
        ...(restrictedNights.length?{restrictedNights}:{})});
      await saveEvidence(directory,`${prefix}.json`,groups.at(-1));
      event(`${prefix}-${outcome}`);
    } catch(error) {
      await saveEvidence(directory,`${prefix}-failure.json`,executionFailure(error,error.phase??'search'));
      const input=/^(AMBIGUOUS_REFERENCE|REFERENCE_NOT_FOUND)/.test(error.message);
      const unsupported=/^(REQUESTED_CURRENCY_NOT_CONFIGURED|UNSUPPORTED_GROUP_SALES_STRATEGY|UNSUPPORTED_SALES_STRATEGY)/.test(error.message);
      const item=issue(input?'CONTEXT_INPUT_GAP':unsupported?error.message:'SEARCH_EXECUTION_FAILED',room.id,
        input?'Exact native reference did not resolve uniquely.':unsupported?error.message:'Browser or source failed; completed groups are retained.');
      groups.push({id:room.id,request:room,outcome:input?'input_gap':unsupported?'partial':'execution_failure',options:[],
        completeness:{search:'partial',requiredFacts:'partial'},issues:[item]});
      issues.push(item);fatal=!input&&!unsupported;break;
    }
  }
  // A contextual/currency call ends with a source-verified public reset, using a
  // distinct applied signature. No context may silently leak into a later call.
  let publicReset;
  try {
    if(request.rateContext||request.requestedCurrency) {
      const publicRequest={...request,rateContext:undefined,requestedCurrency:undefined,search:{salesStrategy:'BAR',includeRestricted:false},details:'summary'};
      const publicRoom={...request.rooms[0],required:undefined,preferred:undefined};
      publicReset=await searchCalendar(page,publicRequest,publicRoom,undefined,undefined,clock);
      searchCount+=publicReset.searchCount;
      await saveEvidence(directory,'public-reset.json',publicReset.windows.map(projectWindow));
    }
    await clock.time('criteriaReset',()=>resetPublicControls(page));
  } catch {fatal=true;issues.push(issue('PUBLIC_RESET_FAILED','rateContext','Public reset could not be verified.'));}
  const allocation=composeAllocation(groups,request.propertyCode);
  const aggregate=aggregateOutcome({inputIssues:issues.filter(i=>i.code==='CONTEXT_INPUT_GAP'),fatal,groups,allocation});
  return {schemaVersion:2,...aggregate,observedAt:new Date().toISOString(),sourceScreen:'Hotel Availability',requested:request,
    groups,allocation,issues,searchCompleteness:{status:groups.every(g=>g.completeness.search==='complete')?'complete':'partial',searchCount,distinctSignatures:cache.size},
    publicReset:publicReset?{status:'verified',evidence:'public-reset.json'}:{status:'controls_reset'},
    limitations:['Displayed-rate sums are not PMS payable totals.','No hold, booking or price lock.',
      'Joint allocation uses proven property/building/room-type identity only; sequential occupancy searches are not an atomic hold.'],
    screenshots:copiedShots};
}

export async function fetchQuote({requestPath,outputDir,env=process.env,video=false,onCaptured}) {
  process.umask(0o077);
  const root=resolve(fileURLToPath(new URL('../../../../',import.meta.url)),'.private/playwright-quote');
  const outputRoot=resolve(outputDir??root);
  if (outputRoot!==root && !outputRoot.startsWith(root+'/')) throw new Error('OUTPUT_MUST_BE_PRIVATE_PLAYWRIGHT_QUOTE_DIRECTORY');
  const directory=join(outputRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  await mkdir(directory,{recursive:true,mode:0o700});
  let browser,context,page,secret,propertyRegistration,phase='input',result,auditReport;
  const audit=await createAudit(directory,{video});
  const started=Date.now();
  const clock=createPhaseClock();
  const event=(next)=>{phase=next;process.stderr.write(JSON.stringify(audit.event(next))+'\n');};
  try {
    event('input');
    const input=JSON.parse(await readFile(requestPath,'utf8'));
    const normalized=normalizeQuoteRequest(input);
    if(!normalized.ok) result=resultEnvelope({outcome:'input_gap',gaps:normalized.issues.map(i=>i.path),issues:normalized.issues,requested:input,
      allocation:{status:'not_selected',reason:'Caller input is invalid; no allocation was checked.',pools:[]},
      searchCompleteness:{status:'not_started',searchCount:0}});
    else {
      const request=normalized.request;
      if(!lookupActiveProperty(request.propertyCode)) throw new Error('PROPERTY_UNKNOWN');
      await saveEvidence(directory,'request.json',request);
      event('configuration');
      const url=new URL(env.HMS_STAGEHAND_CDP_URL);
      if(!['http:','ws:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search) throw new Error('PRIVATE_CDP_REQUIRED');
      if(env.HMS_STAGEHAND_BROWSER_OWNERSHIP!=='borrowed') throw new Error('ATTACH_ONLY_REQUIRES_borrowed_OWNERSHIP');
      if(env.HMS_PROPERTY_TRANSPORT_ID!==undefined)
        propertyRegistration=getHmsPropertyRegistration(env.HMS_PROPERTY_TRANSPORT_ID);
      secret=await clock.time('secret',()=>readSecret(env));
      if(secret.expectedPropertyCode!==request.propertyCode) throw new Error('ACCOUNT_PROPERTY_MISMATCH');
      event('attach');
      await clock.time('cdp',async()=>{
        // Trace only our isolated context, never the borrowed owner's tabs.
        // Lease creates the only page; attachBorrowedSession's blank page is unused.
        const attached=await attachBorrowedSession({
          href:url.href,
          env,
          connectOverCDP:(href,opts)=>playwright().chromium.connectOverCDP(href,opts),
          newContext:(nextBrowser,options,nextEnv)=>newBorrowedContext(nextBrowser,options,nextEnv),
        });
        browser=attached.browser;
        context=attached.context;
        await attached.page.close().catch(()=>{});
      });
      result=await withReadCliPage({propertyCode:request.propertyCode,secret,context,browser,env},async({page:leased})=>{
        page=leased;
        page.setDefaultTimeout?.(20000);
        event('login'); await clock.time('login',()=>Promise.resolve());
        event('audit_start'); await audit.start(page,[secret.password,secret.username,secret.loginUrl]);
        await audit.checkpoint('login-complete');
        event('hotel_availability'); await clock.time('nav',()=>openHotelAvailability(page));
        await audit.checkpoint('hotel-availability');
        if(propertyRegistration)
          await installRegisteredAvailabilityReadOnlyGuard(context,propertyRegistration.transportId,new URL(secret.loginUrl).origin);
        const next=await runInPage(page,request,directory,event,audit.checkpoint,clock,env);
        event(`result_${next.outcome}`);
        if(onCaptured&&quoteTraceAsyncEnabled(env)) {
          const provisional=provisionalQuoteCapture({result:{...next,phaseMs:{...clock.ms}},audit,directory,started});
          if(provisional){await saveEvidence(directory,'result.provisional.json',provisional);onCaptured(provisional);}
        }
        return next;
      });
    }
  } catch(error) {
    result=executionFailure(error,phase,secret);
    if(page && phase!=='login' && !await page.locator('input[type="password"]:visible').count().catch(()=>1))
      await audit.checkpoint('failure').catch(()=>{});
  } finally {
    // Flush recording and trace while our page is still alive. Capture failure
    // cannot prevent closing our context or detaching CDP.
    try {auditReport=await clock.time('traceFinish',()=>audit.finish());}
    catch {auditReport={status:'incomplete',errors:['AUDIT_FINALIZATION_FAILED']};}
    try { if(context) await context.close(); }
    catch { result={...result,outcome:'execution_failure',cleanupError:'OWNED_CONTEXT_CLOSE_FAILED'}; }
    // Pinned Playwright connectOverCDP closes its transport, not remote Chromium.
    // Verified in coreBundle _connectOverCDPImpl and against the retained live tab.
    try { if(browser) await browser.close(); }
    catch { result={...result,outcome:'execution_failure',cleanupError:'CDP_DETACH_FAILED'}; }
  }
  result=applyQuoteScreenshotContract({...result,audit:auditReport,elapsedMs:Date.now()-started,evidenceDirectory:directory,phaseMs:{...clock.ms}});
  audit.event('phase_timings',{phaseMs:result.phaseMs});
  event('run_finished');
  await saveEvidence(directory,'result.json',result);
  await saveEvidence(directory,'summary.txt',summarize(result));
  return result;
}

const QUOTE_GRID_SHOTS = ['criteria-applied', 'availability-results'];

export function quoteGridShotPaths(groupNumber) {
  return QUOTE_GRID_SHOTS.map((name) => `screenshots/group-${groupNumber}-${name}.png`);
}

/** Copy both grid shots onto a later same-signature group. Missing source files are skipped. */
export async function copyGroupGridShots(directory, fromPrefix, toPrefix) {
  const copied = [];
  for (const name of QUOTE_GRID_SHOTS) {
    const rel = `screenshots/${toPrefix}-${name}.png`;
    try {
      await copyFile(join(directory, 'screenshots', `${fromPrefix}-${name}.png`), join(directory, rel));
      copied.push(rel);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return copied;
}

function listedScreenshotPaths(result) {
  const paths = [];
  const items = [...(result?.screenshots ?? []), ...(result?.audit?.screenshots ?? [])];
  for (const item of items) {
    const path = typeof item === 'string' ? item : item?.path;
    if (typeof path === 'string' && path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** outcome quote requires both grid shots listed for every occupancy group. */
export function applyQuoteScreenshotContract(result) {
  const screenshots = listedScreenshotPaths(result);
  const next = { ...result, screenshots };
  if (next.outcome !== 'quote') return next;
  const groupCount = Math.max(Array.isArray(next.groups) ? next.groups.length : 0, 1);
  const missing = [];
  for (let groupNumber = 1; groupNumber <= groupCount; groupNumber++) {
    for (const path of quoteGridShotPaths(groupNumber)) {
      if (!screenshots.includes(path)) missing.push(path);
    }
  }
  if (!missing.length) return next;
  return {
    ...next,
    outcome: 'partial',
    issues: [...(next.issues ?? []), {
      code: 'QUOTE_SCREENSHOT_MISSING',
      path: 'screenshots',
      reason: `outcome quote requires ${missing.join(', ')}.`,
      action: 'A run without screenshots/group-N-availability-results.png is not a quote. screenshots/group-N-criteria-applied.png is required too.',
    }],
  };
}

export function resultEnvelope(partial={}) {
  return {
    schemaVersion:2,
    groups:[],
    allocation:{status:'unknown',reason:'No selected allocation was checked.',pools:[]},
    searchCompleteness:{status:'partial',searchCount:0},
    issues:[],
    ...partial,
  };
}

export function executionFailure(error,phase,secret) {
  let message=String(error.message);
  for(const value of [secret?.password,secret?.username,secret?.loginUrl]) if(value) message=message.replaceAll(value,'[withheld]');
  message=message.replace(/\b(?:https?|wss?):\/\/[^\s]+/g,'[url]');
  return resultEnvelope({
    outcome:'execution_failure',
    phase,
    error:{name:error.name,message},
    issues:[issue('EXECUTION_FAILURE',phase??'run',message,'Retry after restoring the authenticated Hotel Availability session.')],
    allocation:{status:'unknown',reason:'Execution failed before a selected allocation could be checked.',pools:[]},
  });
}

export function summarize(result) {
  const lines=[`Hotel Availability: ${result.outcome}`];
  const groups=result.groups??[];
  const hasSpecial=g=>(g.issues??[]).some(i=>i.code==='NO_SPECIAL_RATES');
  const resultHas=(result.issues??[]).some(i=>i.code==='NO_SPECIAL_RATES');
  const allGroups=groups.length>0&&groups.every(hasSpecial);
  if(resultHas||allGroups)lines.push('No special rates for this party. Returned public BAR is not a contracted rate.');
  for(const group of groups) {
    if(hasSpecial(group)&&!allGroups&&!resultHas)lines.push(`${group.id}: no special rates; returned public BAR is not a contracted rate.`);
    for(const option of group.options??[]) {
      lines.push(`${option.room.code} — ${option.room.label}; ${option.rate.code} — ${option.rate.label}; ${option.board??'board not shown'}; ${option.matchStatus??'unassessed'}; eligibility ${option.eligibility??'unknown'}; ${option.availability??'unknown'}`);
      for(const night of option.nightly??[]) lines.push(`${night.date}: ${night.price.currency} ${night.price.amount} per room/night; inventory ${night.inventory}`);
      if(option.calculated?.ok)lines.push(`Displayed-nightly sum: ${option.calculated.perRoom.currency} ${option.calculated.perRoom.amount} per room; ${option.calculated.forQuantity.amount} for this group's quantity. Not an official payable total.`);
      if(option.details)lines.push(`Details: ${option.details.status}.`);
    }
  }
  lines.push('Observation only, not a booking or hold. PMS payable totals and tax inclusion not established; alternatives are not added together.');
  if(result.allocation)lines.push(`Allocation: ${result.allocation.status}.`);
  if(result.error) lines.push(`${result.phase}: ${result.error.name}: ${result.error.message}`);
  if(result.audit) lines.push(`Audit: ${result.audit.status}; video: ${result.audit.video?.status??'unknown'}. Capture begins after login; private artifacts may contain hotel/customer data.`);
  return lines.join('\n')+'\n';
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.includes('--help')) console.log('node fetch-quote.mjs --request <private.json> --output <.private/playwright-quote/runs> [--video]\nRequires HMS_STAGEHAND_CDP_URL, HMS_STAGEHAND_BROWSER_OWNERSHIP=borrowed, HMS_PROPERTY_TRANSPORT_ID or HMS_QUOTE_SECRET_PATH or HMS_READ_SECRET_ARN and AWS_REGION. Video requires the pinned Playwright FFmpeg installation on this controller.');
  else {
    const requestPath=args[args.indexOf('--request')+1];
    const outputDir=args[args.indexOf('--output')+1];
    if(!args.includes('--request')||!args.includes('--output')||!requestPath||!outputDir) {console.error('Required: --request <path> --output <path>');process.exitCode=2;}
    else fetchQuote({requestPath,outputDir,video:args.includes('--video')}).then(result=>{console.log(summarize(result));console.log(`Evidence: ${result.evidenceDirectory}`);process.exitCode=['quote','no_match','unavailable'].includes(result.outcome)&&result.audit.status==='complete'?0:2;}).catch(error=>{console.error(error.message);process.exitCode=2;});
  }
}
