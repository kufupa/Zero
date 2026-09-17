#!/usr/bin/env node
// Native Playwright quote workflow. Development exports have no import side effects.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const exec = promisify(execFile);

export function playwright() {
  if (require('playwright/package.json').version !== '1.63.0') throw new Error('PLAYWRIGHT_VERSION_MISMATCH');
  return require('playwright');
}

export async function readSecret(env = process.env) {
  let raw;
  try {
    if (env.HMS_QUOTE_SECRET_PATH) raw = await readFile(env.HMS_QUOTE_SECRET_PATH, 'utf8');
    else if (env.HMS_READ_SECRET_ARN) raw = (await exec('aws', ['secretsmanager', 'get-secret-value',
      '--secret-id', env.HMS_READ_SECRET_ARN, '--region', env.AWS_REGION ?? 'af-south-1',
      '--query', 'SecretString', '--output', 'text'], { timeout: 20000, maxBuffer: 1000000 })).stdout;
    else throw new Error('missing configuration');
    const secret = JSON.parse(raw);
    for (const key of ['loginUrl', 'username', 'password', 'expectedTenant', 'expectedPropertyCode', 'expectedPropertyName']) {
      if (typeof secret[key] !== 'string' || !secret[key]) throw new Error('missing field');
    }
    return secret;
  } catch { throw new Error('PMS_CREDENTIAL_CONFIGURATION'); }
}

export async function login(page, secret) {
  const deadline = Date.now() + 120000;
  const budget = () => Math.max(1, deadline - Date.now());
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: budget() });
  await page.locator('input[name="userid"], input[name="username"]').fill(secret.username, { timeout: budget() });
  const password = page.locator('input[name="password"]');
  await password.fill(secret.password, { timeout: budget() });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  if (await submit.count()) await submit.click({ timeout: budget() });
  else await password.press('Enter', { timeout: budget() });
  while (Date.now() < deadline) {
    try {
      const ready = await page.evaluate(({ expectedTenant, expectedPropertyCode, expectedPropertyName }) => {
        const html = document.documentElement.outerHTML;
        const tenant = document.documentElement.dataset.tenant ??
          /"tenantid"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ?? new URL(location.href).searchParams.get('tenant');
        const property = document.documentElement.dataset.propertyCode ?? /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
        const visible = (el) => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        return ![...document.querySelectorAll('input[type="password"], .x-mask, .x-mask-msg, .x-loadmask, [aria-busy="true"]')].some(visible) &&
          tenant === expectedTenant && property === expectedPropertyCode && (document.body?.innerText ?? '').includes(expectedPropertyName);
      }, { expectedTenant: secret.expectedTenant, expectedPropertyCode: secret.expectedPropertyCode,
        expectedPropertyName: secret.expectedPropertyName });
      if (ready) return;
    } catch (error) {
      if (!/Execution context was destroyed|navigation|Cannot find context/i.test(error.message)) throw error;
    }
    await delay(250);
  }
  throw new Error('AUTHENTICATED_SHELL_TIMEOUT');
}

export async function openHotelAvailability(page) {
  await page.locator('a.app-menu-trigger:visible').click();
  for (const name of ['Front Desk', 'Availability', 'Hotel Availability']) {
    await page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) }).click();
  }
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
  await page.locator('[role="option"]:visible').filter({ hasText: new RegExp(`^${label}$`) }).click();
}

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
  const gaps = [];
  if (!request || typeof request !== 'object') return ['request'];
  for (const key of ['arrivalDate','departureDate']) {
    const v=request[key];
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v) gaps.push(key);
  }
  if (!gaps.length && request.departureDate <= request.arrivalDate) gaps.push('departureDate must follow arrivalDate');
  if (typeof request.propertyCode !== 'string' || !/^[A-Z0-9_-]+$/.test(request.propertyCode)) gaps.push('propertyCode');
  if (!Array.isArray(request.rooms) || !request.rooms.length || request.rooms.length>8) gaps.push('rooms (1-8 occupancy groups supported)');
  else request.rooms.forEach((r,i) => {
    if (!r || !Number.isInteger(r.quantity) || r.quantity < 1) gaps.push(`rooms[${i}].quantity`);
    if (!r || !Number.isInteger(r.adults) || r.adults < 1) gaps.push(`rooms[${i}].adults`);
    if (!r || !Number.isInteger(r.children) || r.children < 0) gaps.push(`rooms[${i}].children`);
    if (!Array.isArray(r?.childAges) || r.childAges.length !== r.children || r.childAges.some(a=>!Number.isInteger(a)||a<0||a>99)) gaps.push(`rooms[${i}].childAges`);
  });
  for (const key of ['roomCode','rateCode']) if (request[key] !== undefined && (typeof request[key]!=='string' || !/^[A-Z0-9_-]+$/.test(request[key]))) gaps.push(key);
  if (request.preferences !== undefined && (!request.preferences || typeof request.preferences!=='object' || Array.isArray(request.preferences) ||
    Object.values(request.preferences).some(value=>typeof value!=='string'))) gaps.push('preferences (text values required)');
  return gaps;
}

export async function readCalendar(page) {
  return page.evaluate(() => {
    const headers = [...document.querySelectorAll('.x-column-header-text')].map(e=>e.textContent.trim()).filter(x=>/^\d\d-[A-Z]{3}-\d{4}/.test(x));
    let room = null;
    const options = [];
    for (const row of document.querySelectorAll('tr.x-grid-data-row')) {
      const cells = [...row.children];
      const roomCell = cells[0]?.matches('.rateshopping-roomtype-cell');
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

export function normalizePrice(displayed, currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const match = /^(?:R|\$|€|£)?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/.exec(displayed);
  return match ? {displayed,amount:match[1].replaceAll(',',''),currency,basis:'per_room_per_night'} : null;
}
export function unknownTotals() { return {wholeStay:null,allRooms:null,taxInclusive:null}; }

export function projectCriteria(raw) {
  const keys = ['propertyCodes','startDate','numberOfDays','lengthOfStay','adultCount','childCount','childAges',
    'salesStrategy','roomTypeCodes','ratePlanCodes','groupID','organizationID','travelAgencyID','currency',
    'convertFromPropertyCurrency','shopByDay','showRestrictedSellOptions','showExclusiveRates'];
  return Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));
}

export function assertApplied(request, room, criteria) {
  const expected = {propertyCodes:request.propertyCode,startDate:`${request.arrivalDate}T00:00:00`,
    adultCount:room.adults,childCount:room.children,salesStrategy:'BAR',lengthOfStay:'DY',shopByDay:false};
  for (const [key,value] of Object.entries(expected)) if (criteria[key] !== value) throw new Error(`APPLIED_CRITERIA_MISMATCH_${key}`);
  if (JSON.stringify(criteria.childAges ?? []) !== JSON.stringify(room.childAges)) throw new Error('APPLIED_CRITERIA_MISMATCH_childAges');
  for (const key of ['roomTypeCodes','ratePlanCodes','groupID','organizationID','travelAgencyID'])
    if (criteria[key] !== '') throw new Error(`STALE_FILTER_${key}`);
  if (criteria.convertFromPropertyCurrency !== false || criteria.currency !== null) throw new Error('UNVERIFIED_CURRENCY_CONVERSION');
}

async function expandCriteria(page) {
  if (!await page.locator('input[name="salesstrategy"]').isVisible()) {
    await page.locator('a.x-btn:visible').filter({ has: page.locator('.chevron use[href="#icon-caret-down"]') }).click();
  }
}

async function searchCalendar(page, request, room) {
  await expandCriteria(page);
  await page.locator('input[name="startdate"]').fill(displayDate(request.arrivalDate));
  await page.locator('input[name="startdate"]').press('Tab');
  await applyGuests(page, room);
  await selectSalesStrategy(page);
  for (const field of ['groupname','roomtypes','organization','rateplans','travelagency']) {
    const input=page.locator(`input[name="${field}"]`);
    if (await input.inputValue()) { await input.fill(''); await input.press('Tab'); }
  }
  if (await page.locator('input[name="propertycodes"]').inputValue() !== request.propertyCode) throw new Error('PROPERTY_MISMATCH');
  const pending = page.waitForResponse(r=>new URL(r.url()).pathname==='/api/internalBooking/hotelAvail/inquiryForGrid' && r.request().method()==='POST', {timeout:45000});
  pending.catch(()=>{});
  const [response] = await Promise.all([pending,search(page)]);
  if (!response.ok()) throw new Error(`SEARCH_HTTP_${response.status()}`);
  const criteria = projectCriteria(response.request().postDataJSON());
  assertApplied(request,room,criteria);
  if (await page.locator('input[type="password"]:visible').count()) throw new Error('SESSION_RETURNED_TO_LOGIN');
  const body = await response.json();
  if (!body.availabilitydata) {
    await page.getByText('Selected criteria is not available for these dates.',{exact:true}).waitFor({timeout:15000});
    // Preset demonstrated that an empty strategy can produce this dialog even
    // when inventory exists. Null data alone is never a genuine sold-out proof.
    return {criteria,data:null,calendar:null};
  }
  await page.locator('tr.x-grid-data-row .rateshopping-treecolumn-rateplan-cell').first().waitFor({timeout:30000});
  const calendar = await readCalendar(page);
  if (!calendar.headers[0]?.startsWith(displayDate(request.arrivalDate))) throw new Error('STALE_CALENDAR');
  return {criteria,data:body.availabilitydata,calendar};
}

function nativeDate(value) {
  const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

export function selectOption(request, room, data, calendar) {
  const property = data.children.find(x=>x.isprop && !x.issummary && x.code===request.propertyCode);
  if (!property) throw new Error('PROPERTY_RESULT_MISSING');
  const dates=stayDates(request);
  const indexes=dates.map(d=>data.datesList.map(nativeDate).indexOf(d));
  if (indexes.some(i=>i<0) || indexes.some((i,n)=>!calendar.headers[i]?.startsWith(displayDate(dates[n])))) throw new Error('REQUESTED_STAY_NOT_FULLY_DISPLAYED');
  const candidates=[];
  for (const nativeRoom of property.children ?? []) for (const rate of nativeRoom.children ?? []) {
    if (request.roomCode && nativeRoom.code!==request.roomCode || request.rateCode && rate.code!==request.rateCode) continue;
    // Do not quote negotiated/rewards-only products to an unqualified caller.
    if (!request.rateCode && !['BAR','BARRO'].includes(rate.code)) continue;
    const dom=calendar.options.find(o=>o.room.code===nativeRoom.code && o.rate===`${rate.code}: ${rate.desc}`);
    if (!dom) throw new Error('RATE_NOT_BOUND_TO_VISIBLE_GRID');
    const nightly=indexes.map((idx,n)=>{
      const column=rate.columns[`col${idx+1}`];
      const inventory=nativeRoom.columns[`col${idx+1}`]?.value;
      const price=normalizePrice(dom.prices[idx],rate.currency);
      if (!column || !Number.isInteger(inventory) || String(inventory)!==dom.room.inventory[idx] || !price || Number(price.amount)!==column.value)
        throw new Error('PRICE_OR_INVENTORY_SOURCE_MISMATCH');
      return {date:dates[n],inventory,price,restricted:column.restricted,rateAvailable:column.israteavailable,
        restrictions:{closed:column.combClosed,closedToArrival:column.combClosedToArrival,closedToDeparture:column.combClosedToDeparture,
          minStayArrival:column.combMinLOSToArrival,minStayDeparture:column.combMinLOSToDeparture,maxStayArrival:column.combMaxLOSToArrival,
          minStayThrough:column.combMinLOSToThrough,maxStayThrough:column.combMaxLOSToThrough}};
    });
    const preferredRoom = request.preferences?.room;
    const roomMatches = !preferredRoom || nativeRoom.desc.toLowerCase().includes(preferredRoom.toLowerCase());
    const boardMatches = !request.preferences?.board || (dom.board??'').toLowerCase().includes(request.preferences.board.toLowerCase());
    const departureIndex=data.datesList.map(nativeDate).indexOf(request.departureDate);
    const departureColumn=departureIndex>=0?rate.columns[`col${departureIndex+1}`]:null;
    // The departure is not a charged night, but its departure restriction must
    // still be known. Do not silently certify a stay beyond the rendered window.
    if(!departureColumn) throw new Error('DEPARTURE_RESTRICTION_NOT_DISPLAYED');
    const available=nightly.every(x=>x.inventory>=room.quantity && x.rateAvailable===true && x.restricted===false) && rate.restricted===false && departureColumn.combClosedToDeparture===false;
    candidates.push({nativeRoom,rate,dom,nightly,indexes,available,score:Number(roomMatches)*2+Number(boardMatches)});
  }
  if (!candidates.length) throw new Error('REQUESTED_PRODUCT_NOT_IN_RENDERED_RESULTS');
  candidates.sort((a,b)=>Number(b.available)-Number(a.available)||b.score-a.score||Number(a.nightly[0].price.amount)-Number(b.nightly[0].price.amount));
  return candidates[0];
}

async function readDetails(page, chosen, directory, prefix) {
  const row=rateRow(page,chosen.nativeRoom.code,chosen.rate.code);
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
    details.push({selectedDate:await selected.innerText(),room:roomLabel,rate:rateLabel,sourceText:await panel.innerText()});
  }
  await page.screenshot({path:join(directory,`${prefix}-details.png`),fullPage:true,timeout:10000});
  const roomRow=page.getByText(chosen.nativeRoom.code,{exact:true}).locator('xpath=ancestor::tr[1]');
  await roomRow.locator('.cell-info').click();
  const card=page.locator('.x-window:visible').filter({hasText:'Room Type Information'});
  await card.waitFor();
  // Wait for the actual room content, not merely the empty card shell.
  await card.getByText(chosen.nativeRoom.desc,{exact:true}).waitFor();
  const roomInformation=await card.innerText();
  await page.keyboard.press('Escape');
  await card.waitFor({state:'hidden'});
  return {details,roomInformation};
}

export async function runInPage(page, request, directory, event=()=>{}) {
  const groups=[];
  for (const [index,room] of request.rooms.entries()) {
    event(`group_${index+1}_search`);
    const source=await searchCalendar(page,request,room);
    await saveEvidence(directory,`group-${index+1}-criteria.json`,source.criteria);
    if (!source.data) {
      groups.push({outcome:'partial',applied:source.criteria,options:[],limitations:['PMS returned a null calendar. This does not prove sold-out inventory.']});
      break;
    }
    const chosen=selectOption(request,room,source.data,source.calendar);
    const sourceDetails=await readDetails(page,chosen,directory,`group-${index+1}`);
    const option={room:{code:chosen.nativeRoom.code,label:chosen.nativeRoom.desc,information:sourceDetails.roomInformation},
      rate:{code:chosen.rate.code,label:chosen.rate.desc},board:chosen.dom.board,nightly:chosen.nightly,
      stayCoverage:{arrivalDate:request.arrivalDate,departureDate:request.departureDate,nights:chosen.nightly.length,mode:'daily_calendar',details:sourceDetails.details},
      totals:unknownTotals(),policies:{status:sourceDetails.details.some(d=>/cancell?ation|payment|deposit|guarantee|refundable|date.change|bank.transfer/i.test(d.sourceText))?'see_exact_source_text':'not_shown',
        exactSourceText:sourceDetails.details.map(d=>d.sourceText),configuredPolicies:chosen.rate.haspolicies,
        inspected:'Hotel Availability rate row, Availability Details and Room Type Information',cancellation:null,dateChanges:null,payment:null},
      requestedPreferences:request.preferences??{},preferenceEvidence:{room:chosen.nativeRoom.desc,bed:sourceDetails.roomInformation,board:chosen.dom.board,
        flexibility:'not inferred; consult exactSourceText',paymentQuestion:'not inferred; consult exactSourceText'},
      preferenceAssessment:{
        room:request.preferences?.room ? (chosen.nativeRoom.desc.toLowerCase().includes(request.preferences.room.toLowerCase())?'native label matches requested text':'alternative; requested text not matched'):'not requested',
        bed:request.preferences?.bed?'native bed description provided; equivalence to requested bed not assumed':'not requested',
        board:request.preferences?.board ? ((chosen.dom.board??'').toLowerCase().includes(request.preferences.board.toLowerCase())?'native label matches requested text':'not confirmed'):'not requested',
        flexibility:'not confirmed',payment:'not confirmed'}};
    const inventoryUnavailable=chosen.nightly.some(x=>x.inventory<room.quantity);
    const outcome=chosen.available?'quote':inventoryUnavailable?'unavailable':'partial';
    groups.push({outcome,requestedOccupancy:room,applied:{...source.criteria,stayCoverage:option.stayCoverage,
      quantityCheck:{requested:room.quantity,searchQuantityField:'not present',inventorySufficientEachNight:!inventoryUnavailable}},options:[option],
      limitations:['Per-room daily calendar rates, not a PMS whole-stay/all-room total.','No inventory hold or price lock.',
        'Policy fields are not inferred; consult exactSourceText. Configured policies may exist.','One selected public-rate option; not an exhaustive rate comparison.']});
    await saveEvidence(directory,`group-${index+1}.json`,groups.at(-1));
    event(`group_${index+1}_${outcome}`);
  }
  const outcome=groups.every(g=>g.outcome==='quote')?'quote':groups.some(g=>g.outcome==='partial')?'partial':'unavailable';
  return {outcome,observedAt:new Date().toISOString(),sourceScreen:'Hotel Availability',requested:request,groups,
    limitations:request.rooms.length>1?['Sequential occupancy-group searches do not establish additive or jointly available inventory.']:[]};
}

export async function fetchQuote({requestPath,outputDir,env=process.env}) {
  process.umask(0o077);
  const root=resolve(fileURLToPath(new URL('../../../../',import.meta.url)),'.private/playwright-quote');
  const outputRoot=resolve(outputDir??root);
  if (outputRoot!==root && !outputRoot.startsWith(root+'/')) throw new Error('OUTPUT_MUST_BE_PRIVATE_PLAYWRIGHT_QUOTE_DIRECTORY');
  const directory=join(outputRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  await mkdir(directory,{recursive:true,mode:0o700});
  let browser,page,secret,phase='input',result;
  const started=Date.now();
  const event=(next)=>{phase=next;process.stderr.write(JSON.stringify({at:new Date().toISOString(),phase})+'\n');};
  try {
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    const gaps=validateRequest(request);
    if(gaps.length) result={outcome:'input_gap',gaps,requested:request};
    else {
      await saveEvidence(directory,'request.json',request);
      event('configuration');
      const url=new URL(env.HMS_STAGEHAND_CDP_URL);
      if(!['http:','ws:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search) throw new Error('PRIVATE_CDP_REQUIRED');
      if(env.HMS_STAGEHAND_BROWSER_OWNERSHIP!=='borrowed') throw new Error('ATTACH_ONLY_REQUIRES_borrowed_OWNERSHIP');
      secret=await readSecret(env);
      if(secret.expectedPropertyCode!==request.propertyCode) throw new Error('ACCOUNT_PROPERTY_MISMATCH');
      event('attach');
      browser=await playwright().chromium.connectOverCDP(url.href,{timeout:20000});
      if(browser.contexts().length!==1) throw new Error('AMBIGUOUS_BROWSER_CONTEXT');
      page=await browser.contexts()[0].newPage();
      page.setDefaultTimeout(20000);
      event('login'); await login(page,secret);
      event('hotel_availability'); await openHotelAvailability(page);
      result=await runInPage(page,request,directory,event);
    }
  } catch(error) {
    result=executionFailure(error,phase,secret);
    if(page && phase!=='login' && !await page.locator('input[type="password"]:visible').count().catch(()=>1))
      await page.screenshot({path:join(directory,'failure.png'),fullPage:true,timeout:3000}).catch(()=>{});
  } finally {
    try { if(page) await page.close({runBeforeUnload:false}); }
    catch { result={...result,outcome:'execution_failure',cleanupError:'OWNED_TAB_CLOSE_FAILED'}; }
    // Pinned Playwright connectOverCDP closes its transport, not remote Chromium.
    // Verified in coreBundle _connectOverCDPImpl and against the retained live tab.
    try { if(browser) await browser.close(); }
    catch { result={...result,outcome:'execution_failure',cleanupError:'CDP_DETACH_FAILED'}; }
  }
  result={...result,elapsedMs:Date.now()-started,evidenceDirectory:directory};
  await saveEvidence(directory,'result.json',result);
  await saveEvidence(directory,'summary.txt',summarize(result));
  return result;
}

export function executionFailure(error,phase,secret) {
  let message=String(error.message);
  for(const value of [secret?.password,secret?.username,secret?.loginUrl]) if(value) message=message.replaceAll(value,'[withheld]');
  message=message.replace(/\b(?:https?|wss?):\/\/[^\s]+/g,'[url]');
  return {outcome:'execution_failure',phase,error:{name:error.name,message}};
}

export function summarize(result) {
  const lines=[`Hotel Availability: ${result.outcome}`];
  for(const group of result.groups??[]) for(const option of group.options??[]) {
    lines.push(`${option.room.code} — ${option.room.label}; ${option.rate.code} — ${option.rate.label}; ${option.board??'board not shown'}`);
    for(const night of option.nightly) lines.push(`${night.date}: ${night.price.currency} ${night.price.amount} per room/night; inventory ${night.inventory}`);
  }
  lines.push('Observation only, not a booking or hold. Whole-stay/all-room totals and tax inclusion not established.');
  if(result.error) lines.push(`${result.phase}: ${result.error.name}: ${result.error.message}`);
  return lines.join('\n')+'\n';
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.includes('--help')) console.log('node fetch-quote.mjs --request <private.json> --output <.private/playwright-quote/runs>\nRequires HMS_STAGEHAND_CDP_URL, HMS_STAGEHAND_BROWSER_OWNERSHIP=borrowed, HMS_QUOTE_SECRET_PATH or HMS_READ_SECRET_ARN and AWS_REGION.');
  else {
    const requestPath=args[args.indexOf('--request')+1];
    const outputDir=args[args.indexOf('--output')+1];
    if(!args.includes('--request')||!args.includes('--output')||!requestPath||!outputDir) {console.error('Required: --request <path> --output <path>');process.exitCode=2;}
    else fetchQuote({requestPath,outputDir}).then(result=>{console.log(summarize(result));console.log(`Evidence: ${result.evidenceDirectory}`);process.exitCode=['quote','unavailable'].includes(result.outcome)?0:2;}).catch(error=>{console.error(error.message);process.exitCode=2;});
  }
}
