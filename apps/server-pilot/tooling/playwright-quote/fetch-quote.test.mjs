import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as quote from './fetch-quote.mjs';
import { composeAllocation } from './quote-contract.mjs';
const { validateRequest, stayDates, displayDate } = quote;
const request = {propertyCode:'HRCEN',arrivalDate:'2026-09-24',departureDate:'2026-09-27',rooms:[{quantity:2,adults:1,children:0,childAges:[]}]};
test('input-gap invocation has durable events and explicit capture status without browser access',async t=>{
  const result=await quote.fetchQuote({requestPath:new URL('./examples/missing-age.json',import.meta.url),env:{},video:true});
  t.after(()=>rm(result.evidenceDirectory,{recursive:true,force:true}));
  assert.equal(result.outcome,'input_gap');
  assert.equal(result.schemaVersion,2);
  assert.deepEqual(result.groups,[]);
  assert.equal(result.allocation.status,'not_selected');
  assert.equal(result.searchCompleteness.status,'not_started');
  assert.ok(Array.isArray(result.issues)&&result.issues.length);
  assert.equal(result.audit?.status,'not_started');
  assert.equal(result.audit.video.requested,true);
  const events=(await readFile(join(result.evidenceDirectory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).phase,'run_finished');
});
test('validates real adult request and exclusive departure',()=>{
  assert.deepEqual(validateRequest(request),[]);
  assert.deepEqual(stayDates(request),['2026-09-24','2026-09-25','2026-09-26']);
  assert.equal(displayDate(request.arrivalDate),'24-SEP-2026');
});
test('invalid and reversed dates are input gaps',()=>{
  for(const arrivalDate of ['2026-02-30','not a date',null,'2026-09-28']) assert.ok(validateRequest({...request,arrivalDate}).length);
});
test('missing child ages cannot reach a browser',()=>{
  assert.ok(validateRequest({...request,rooms:[{quantity:1,adults:1,children:1,childAges:[]}]}).some(x=>x.endsWith('childAges')));
  assert.deepEqual(validateRequest({...request,rooms:[{quantity:1,adults:1,children:1,childAges:[12]}]}),[]);
});
test('stale child ages in adult requests are input gaps',()=>{
  assert.ok(validateRequest({...request,rooms:[{quantity:1,adults:1,children:0,childAges:[12]}]}).length);
});
test('price normalization preserves decimal, currency and per-room nightly basis',()=>{
  assert.deepEqual(quote.normalizePrice('R1,780.50','ZAR'),{displayed:'R1,780.50',amount:'1780.50',currency:'ZAR',basis:'per_room_per_night'});
  assert.equal(quote.normalizePrice('1780,50','ZAR'),null);
  assert.equal(quote.normalizePrice('R1,780.00',null),null);
  assert.equal(quote.normalizePrice('R1,780.00','USD'),null);
});
test('unsupported totals are never invented',()=>{
  assert.deepEqual(quote.unknownTotals(),{wholeStay:null,allRooms:null,taxInclusive:null});
});
test('ambiguous applied stay or occupancy fails, never becomes unavailable',()=>{
  const applied={propertyCodes:'HRCEN',startDate:'2026-09-24T00:00:00',adultCount:1,childCount:0,salesStrategy:'BAR',lengthOfStay:'DY',shopByDay:false,
    roomTypeCodes:'',ratePlanCodes:'',groupID:'',organizationID:'',travelAgencyID:'',convertFromPropertyCurrency:false,currency:null};
  assert.doesNotThrow(()=>quote.assertApplied(request,request.rooms[0],applied));
  for(const delta of [{startDate:null},{adultCount:2},{childAges:[12]},{shopByDay:true},{groupID:'stale'}])
    assert.throws(()=>quote.assertApplied(request,request.rooms[0],{...applied,...delta}));
});
test('criteria evidence excludes session tokens',()=>{
  assert.deepEqual(quote.projectCriteria({adultCount:1,bookingSessionID:'private-token',password:'private'}),{adultCount:1});
});
test('import has no CLI, browser or credential side effects',()=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('./fetch-quote.mjs',import.meta.url).href)}); console.log('import only');`],
    {encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),'import only');
  assert.equal(child.stderr,'');
});
test('skipped availability-results cannot be outcome quote',()=>{
  const group={id:'group-1',outcome:'quote'};
  const criteria='screenshots/group-1-criteria-applied.png';
  const grid='screenshots/group-1-availability-results.png';
  const skipped=quote.applyQuoteScreenshotContract({outcome:'quote',groups:[group],issues:[],screenshots:[criteria]});
  assert.notEqual(skipped.outcome,'quote');
  assert.equal(skipped.screenshots.includes(grid),false);
  assert.equal(skipped.issues.at(-1).code,'QUOTE_SCREENSHOT_MISSING');
  const skippedCriteria=quote.applyQuoteScreenshotContract({
    outcome:'quote',groups:[group],audit:{screenshots:[{path:grid,bytes:1,sha256:'abc'}]},
  });
  assert.notEqual(skippedCriteria.outcome,'quote');
  assert.deepEqual(skippedCriteria.screenshots,[grid]);
  const listed=quote.applyQuoteScreenshotContract({outcome:'quote',groups:[group],screenshots:[criteria,grid]});
  assert.equal(listed.outcome,'quote');
  assert.deepEqual(listed.screenshots,[criteria,grid]);
});
test('cache hit copies availability-results bytes onto the later group',async()=>{
  const {mkdtemp,writeFile,readFile:readBytes,rm,mkdir}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const dir=await mkdtemp(join(tmpdir(),'quote-cache-'));
  await mkdir(join(dir,'screenshots'));
  const bytes=Buffer.from('grid-png-bytes');
  await writeFile(join(dir,'screenshots','group-1-criteria-applied.png'),bytes);
  await writeFile(join(dir,'screenshots','group-1-availability-results.png'),bytes);
  const copied=await quote.copyGroupGridShots(dir,'group-1','group-2');
  assert.ok(copied.includes('screenshots/group-2-availability-results.png'));
  assert.deepEqual(await readBytes(join(dir,'screenshots','group-2-availability-results.png')),bytes);
  const result=quote.applyQuoteScreenshotContract({
    outcome:'quote',
    groups:[{id:'a'},{id:'b'}],
    screenshots:[
      'screenshots/group-1-criteria-applied.png',
      'screenshots/group-1-availability-results.png',
      ...copied,
    ],
  });
  assert.equal(result.outcome,'quote');
  await rm(dir,{recursive:true,force:true});
});
test('timeout and returned-login errors are execution failures, not unavailability',()=>{
  const timeout=new Error('waiting timed out'); timeout.name='TimeoutError';
  for(const error of [timeout,new Error('SESSION_RETURNED_TO_LOGIN')]) {
    const result=quote.executionFailure(error,'search');
    assert.equal(result.outcome,'execution_failure');
    assert.equal(result.schemaVersion,2);
    assert.deepEqual(result.groups,[]);
    assert.equal(result.allocation.status,'unknown');
    assert.equal(result.searchCompleteness.status,'partial');
    assert.equal(result.issues[0].code,'EXECUTION_FAILURE');
    assert.equal(result.error.name,error.name);
    assert.equal(result.error.message,error.message);
    assert.equal(result.phase,'search');
  }
});
test('cold-login readiness tolerates an absent document body during navigation',async()=>{
  let reads=0;
  const secret={loginUrl:'https://example.invalid',username:'user',password:'secret',expectedTenant:'tenant',expectedPropertyCode:'HRCEN',expectedPropertyName:'Hotel'};
  const control={fill:async()=>{},press:async()=>{},count:async()=>1,click:async()=>{}};
  const page={goto:async()=>{},locator:()=>control,getByRole:()=>control,evaluate:async(fn,arg)=>{
    reads++;
    return vm.runInNewContext(`(${fn.toString()})(arg)`,{arg,document:{documentElement:{outerHTML:'',dataset:{tenant:'tenant',propertyCode:'HRCEN'}},
      querySelectorAll:()=>[],body:reads===1?null:{innerText:'Hotel'}}});
  }};
  await quote.login(page,secret);
  assert.equal(reads,2);
});

function selectionFixture() {
  const column={value:1780,israteavailable:true,restricted:false,combClosed:false,combClosedToArrival:false,combClosedToDeparture:false,
    combMinLOSToArrival:0,combMinLOSToDeparture:0,combMaxLOSToArrival:null,combMinLOSToThrough:null,combMaxLOSToThrough:null};
  const columns=Object.fromEntries([1,2,3,4].map(n=>[`col${n}`,{...column}]));
  const rate={code:'BAR',desc:'Best Available Rate',currency:'ZAR',restricted:false,columns};
  const room={code:'STQN',desc:'Standard Queen',children:[rate],columns:Object.fromEntries([1,2,3,4].map(n=>[`col${n}`,{value:3}]))};
  return {data:{datesList:['09/24/2026','09/25/2026','09/26/2026','09/27/2026'],children:[{isprop:true,issummary:false,code:'HRCEN',children:[room]}]},
    calendar:{headers:['24-SEP-2026Thursday','25-SEP-2026Friday','26-SEP-2026Saturday','27-SEP-2026Sunday'],
      options:[{room:{code:'STQN',inventory:['3','3','3','3']},rate:'BAR: Best Available Rate',board:'Bed & Breakfast R',prices:['R1,780.00','R1,780.00','R1,780.00','R1,780.00']}]},rate};
}
test('selection requires source-matched prices for every requested night',()=>{
  const f=selectionFixture();
  assert.equal(quote.selectOption(request,request.rooms[0],f.data,f.calendar).available,true);
  f.calendar.options[0].prices[1]='R999.00';
  assert.throws(()=>quote.selectOption(request,request.rooms[0],f.data,f.calendar),/SOURCE_MISMATCH/);
});
test('a missing night, unknown currency or hidden source row cannot become a quote',()=>{
  for(const mutate of [f=>f.data.datesList.splice(1,1),f=>{f.rate.currency=null;},f=>{f.calendar.options=[];}]) {
    const f=selectionFixture();mutate(f);
    assert.throws(()=>quote.selectOption(request,request.rooms[0],f.data,f.calendar));
  }
});
test('departure restrictions are checked even though departure is not a charged night',()=>{
  const f=selectionFixture(); f.rate.columns.col4.combClosedToDeparture=true;
  assert.equal(quote.selectOption(request,request.rooms[0],f.data,f.calendar).available,false);
  delete f.rate.columns.col4;
  assert.throws(()=>quote.selectOption(request,request.rooms[0],f.data,f.calendar),/DEPARTURE_RESTRICTION/);
});
test('adult application clears children and checks that stale age controls disappeared',async()=>{
  const actions=[];
  const page={locator:selector=>({click:async()=>actions.push(['click',selector]),fill:async value=>actions.push(['fill',selector,value]),
    press:async key=>actions.push(['press',selector,key]),count:async()=>0})};
  await quote.applyGuests(page,{adults:1,children:0,childAges:[]});
  assert.ok(actions.some(x=>x[0]==='fill'&&x[1].includes('children')&&x[2]==='0'));
  const stale={locator:selector=>({...page.locator(selector),count:async()=>1})};
  await assert.rejects(quote.applyGuests(stale,{adults:1,children:0,childAges:[]}),/CHILD_AGE_CONTROL_COUNT_MISMATCH/);
});
test('invalid preferences and non-string native codes are rejected before browser interaction',()=>{
  for(const delta of [{preferences:{room:123}},{preferences:[]},{roomCode:123},{rateCode:123}])
    assert.ok(quote.validateRequest({...request,...delta}).length);
});

// Compact projection of the 2026-09-18 Hotel Availability response. No guest,
// organization or session data; identities/amounts below are sanitized.
function multipleSource() {
  const f=selectionFixture();
  const room=f.data.children[0].children[0];
  const column={restricted:false,israteavailable:true,combClosed:false,combClosedToArrival:false,
    combClosedToDeparture:false,combMinLOSToArrival:0,combMinLOSToDeparture:0,
    combMaxLOSToArrival:null,combMinLOSToThrough:null,combMaxLOSToThrough:null,value:1780};
  f.rate.columns=Object.fromEntries([1,2,3,4].map(n=>[`col${n}`,{...column}]));
  Object.assign(f.rate,{isNegotiatedRate:false,minLOS:null,maxLOS:null,minLeadTime:null,maxLeadTime:null,haspolicies:true});
  room.buildingCode='MAIN';
  const second=structuredClone(room); second.code='STWN'; second.desc='Standard Twin';
  f.data.children[0].currency='ZAR';
  f.data.children[0].children.push(second);
  const visible=structuredClone(f.calendar.options[0]);visible.room.code='STWN';
  f.calendar.options.push(visible);
  return f;
}
test('multiple source rows survive extraction without a Standard/first-row winner',()=>{
  const f=multipleSource();
  const result=quote.extractOptions?.(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.equal(result?.options.length,2);
  assert.equal(result.completeness.search,'complete');
  assert.deepEqual(result.options.map(x=>x.room.code).sort(),['STQN','STWN']);
});
test('a hidden or malformed option is isolated while valid source options survive',()=>{
  for(const mutate of [f=>f.calendar.options.pop(),f=>{f.data.children[0].children[1].children[0].columns.col2.value=999;}]) {
    const f=multipleSource();mutate(f);
    const result=quote.extractOptions?.(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
    assert.equal(result?.options.filter(x=>x.nightly.length===3).length,1);
    assert.equal(result.completeness.search,'partial');
    assert.ok(result.issues.length);
  }
});
test('on-screen rate label may differ from native desc; binding uses room and rate code',()=>{
  // Live 2026-09-26: NCOR2B native desc "Negotiated Contracted  Rate 2", grid "Negiotiated rate".
  const f=multipleSource();
  f.calendar.options[1].rate='BAR: Grid-only label';
  const result=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.equal(result.completeness.search,'complete');
  const twin=result.options.find(o=>o.room.code==='STWN');
  assert.equal(twin.nightly.length,3);
  assert.deepEqual(twin.rate,{code:'BAR',label:'Grid-only label',nativeLabel:'Best Available Rate'});
  assert.deepEqual(result.options.find(o=>o.room.code==='STQN').rate,{code:'BAR',label:'Best Available Rate'});
  f.calendar.options.push(structuredClone(f.calendar.options[1]));
  const ambiguous=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.ok(ambiguous.issues.some(i=>i.code==='RATE_NOT_BOUND_TO_VISIBLE_GRID'&&i.path.endsWith(':STWN:BAR')));
});
test('return limit hides only non-matching rows without claiming unseen matches',()=>{
  const rows=['match','match','unresolved','alternative'].map((matchStatus,i)=>({id:i,matchStatus}));
  assert.deepEqual(quote.limitOptions(rows,2),{options:rows.slice(0,2),truncated:true,matchingRowsUnseen:false});
  assert.equal(quote.limitOptions(rows,1).matchingRowsUnseen,true);
  assert.deepEqual(quote.limitOptions(rows,4),{options:rows,truncated:false,matchingRowsUnseen:false});
});
test('null calendars and changed headers are partial, never sold out',()=>{
  const f=multipleSource();f.calendar.headers[1]='26-SEP-2026Saturday';
  for(const window of [{data:null,calendar:null},{data:f.data,calendar:f.calendar}]) {
    const result=quote.extractOptions?.(request,request.rooms[0],[window]);
    assert.equal(result?.completeness.search,'partial');
    assert.ok(result.issues.length);
  }
});
test('wrong requested currency cannot certify nightly offers',()=>{
  const f=multipleSource();
  const result=quote.extractOptions?.({...request,requestedCurrency:'USD'},request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.equal(result?.completeness.search,'partial');
  assert.equal(result.options.filter(x=>x.eligibility==='verified').length,0);
});
test('overlapping date windows are deduplicated and conflicting observations stay partial',()=>{
  const f=multipleSource();const a={data:f.data,calendar:f.calendar};
  const same=quote.extractOptions?.(request,request.rooms[0],[a,structuredClone(a)]);
  assert.equal(same?.options[0].nightly.length,3);
  assert.equal(same.completeness.search,'partial'); // repeated page is stale, not new coverage
  const changed=structuredClone(a);changed.data.children[0].children[0].children[0].columns.col2.value=999;
  const conflict=quote.extractOptions?.(request,request.rooms[0],[a,changed]);
  assert.equal(conflict?.completeness.search,'partial');
});
test('restricted and non-public rates remain information, never eligible quotes',()=>{
  const f=multipleSource();
  f.rate.restricted=true;
  f.data.children[0].children[1].children[0].code='CORP';
  f.calendar.options[1].rate='CORP: Best Available Rate';
  const result=quote.extractOptions?.(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.equal(result?.options.length,2);
  assert.equal(result.options.find(x=>x.rate.code==='BAR').availability,'restricted');
  assert.notEqual(result.options.find(x=>x.rate.code==='CORP').eligibility,'verified');
});
test('applied context binds resolved native IDs; mismatches and stale public reset fail',()=>{
  const scoped={...request,rateContext:{organization:{code:'1'},agency:{code:'123'},group:{code:'456'}}};
  const resolved={organization:{id:'1'},agency:{id:'23'},group:{id:'56'}};
  const criteria={propertyCodes:'HRCEN',startDate:'2026-09-24T00:00:00',adultCount:1,childCount:0,
    salesStrategy:null,lengthOfStay:'DY',shopByDay:false,roomTypeCodes:'',ratePlanCodes:'',groupID:'56',organizationID:'1',travelAgencyID:'23',
    convertFromPropertyCurrency:false,currency:null};
  assert.doesNotThrow(()=>quote.assertApplied(scoped,scoped.rooms[0],criteria,{resolvedContext:resolved}));
  assert.throws(()=>quote.assertApplied(scoped,scoped.rooms[0],{...criteria,organizationID:'other'},{resolvedContext:resolved}));
  assert.throws(()=>quote.assertApplied(request,request.rooms[0],{...criteria,salesStrategy:'BAR'}));
  assert.doesNotThrow(()=>quote.assertApplied(request,request.rooms[0],{...criteria,salesStrategy:'BAR',groupID:'',organizationID:'',travelAgencyID:''}));
  assert.throws(()=>quote.assertApplied({...scoped,search:{salesStrategy:'BAR'}},scoped.rooms[0],criteria,{resolvedContext:resolved}),/UNSUPPORTED_GROUP_SALES_STRATEGY/);
});
test('currency application is source-bound rather than local FX',()=>{
  const criteria={propertyCodes:'HRCEN',startDate:'2026-09-24T00:00:00',adultCount:1,childCount:0,
    salesStrategy:'BAR',lengthOfStay:'DY',shopByDay:false,roomTypeCodes:'',ratePlanCodes:'',groupID:'',organizationID:'',travelAgencyID:'',
    convertFromPropertyCurrency:true,currency:'USD'};
  assert.doesNotThrow(()=>quote.assertApplied({...request,requestedCurrency:'USD'},request.rooms[0],criteria));
  assert.throws(()=>quote.assertApplied({...request,requestedCurrency:'USD'},request.rooms[0],{...criteria,currency:'ZAR'}));
});
test('bed matching uses exact room information, never misleading Twin room name',()=>{
  const facts=quote.sourceFacts?.({room:{code:'STWN',label:'Standard Twin'},rate:{code:'BAR'},board:'Bed & Breakfast R'},'Standard Twin\nTwo Double Beds\nSleeps 4');
  assert.equal(facts?.bedType,'double');
  assert.equal(facts.boardBase,'breakfast');
  assert.equal(quote.sourceFacts({room:{code:'EXKNG',label:'Executive King'},rate:{code:'BAR'}},'King Bed').bedType,'king');
  assert.equal(quote.sourceFacts({room:{code:'STWN',label:'Standard Twin'},rate:{code:'BAR'},board:'invented breakfast'},'').bedType,undefined);
});
test('source projection keeps pricing identity but excludes unrelated session fields',()=>{
  const f=multipleSource();f.data.bookingSessionID='secret';f.rate.billingprofilesratekey='not-needed';
  const projected=quote.projectWindow?.({criteria:{adultCount:1,bookingSessionID:'secret'},data:f.data,calendar:f.calendar});
  assert.equal(projected?.data.children[0].children[0].children[0].columns.col1.value,1780);
  assert.equal(JSON.stringify(projected).includes('secret'),false);
  assert.equal(JSON.stringify(projected).includes('not-needed'),false);
});
test('picker references require unique exact normalized names or native codes',()=>{
  const rows=[{id:'17',code:'12345',name:'Example Company'},{id:'18',code:'12346',name:'Example Company Extra'}];
  assert.equal(quote.matchReference?.({name:' example  company '},rows)?.id,'17');
  assert.equal(quote.matchReference({code:'12346'},rows).id,'18');
  assert.equal(quote.matchReference({nativeId:'18'},rows).id,'18');
  assert.throws(()=>quote.matchReference({name:'Example'},rows),/REFERENCE_NOT_FOUND/);
  assert.throws(()=>quote.matchReference({name:'Example Company'},[...rows,{...rows[0],id:'19'}]),/AMBIGUOUS_REFERENCE/);
  assert.throws(()=>quote.matchReference({nativeId:'17'},[...rows,{...rows[0],code:'99999'}]),/AMBIGUOUS_REFERENCE/);
});
test('picker filters only use fields the live HMS pickers expose',()=>{
  assert.deepEqual(quote.pickerFilter('organization',{nativeId:'49'}),{name:'ff_companyid',value:'49'});
  assert.deepEqual(quote.pickerFilter('agency',{nativeId:'290',name:'CWT JNB'}),{name:'ff_travelagencyname',value:'CWT JNB'});
  assert.deepEqual(quote.pickerFilter('agency',{code:'77218175'}),{name:'ff_iatanumber',value:'77218175'});
  assert.deepEqual(quote.pickerFilter('group',{name:'Conference'}),{name:'ff_groupsname',value:'Conference'});
  assert.throws(()=>quote.pickerFilter('agency',{nativeId:'290'}),/REFERENCE_FILTER_MISSING/);
});
test('search signatures share quantity/preferences only, never occupancy/context/currency/filter changes',()=>{
  const a=quote.searchSignature?.(request,request.rooms[0]);
  assert.equal(typeof a,'string');
  assert.equal(a,quote.searchSignature(request,{...request.rooms[0],quantity:3,preferred:{bedTypes:['king']}}));
  assert.notEqual(a,quote.searchSignature(request,{...request.rooms[0],adults:2}));
  assert.notEqual(a,quote.searchSignature({...request,requestedCurrency:'USD'},request.rooms[0]));
  assert.notEqual(a,quote.searchSignature({...request,rateContext:{organization:{code:'1'}}},request.rooms[0]));
  assert.notEqual(a,quote.searchSignature(request,{...request.rooms[0],required:{roomCodes:['STQN']}}));
});
test('PMS FX source precision is verified against rounded displayed cents, never locally converted',()=>{
  const f=multipleSource();
  for(const room of f.data.children[0].children) {
    room.children[0].currency='USD';
    for(const column of Object.values(room.children[0].columns))column.value=103.2679;
  }
  for(const row of f.calendar.options)row.prices.fill('$103.27');
  const result=quote.extractOptions({...request,requestedCurrency:'USD'},request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.equal(result.completeness.search,'complete');
  assert.equal(result.options[0].nightly[0].price.amount,'103.27');
  assert.equal(result.options[0].nightly[0].sourceAmount,'103.2679');
});
test('date paging merges a genuine overlap and covers departure exactly once',()=>{
  const f=multipleSource();
  const slice=(from,to)=>{
    const out=structuredClone({data:f.data,calendar:f.calendar});
    out.data.datesList=out.data.datesList.slice(from,to);out.calendar.headers=out.calendar.headers.slice(from,to);
    const columns=c=>Object.fromEntries(Object.values(c).slice(from,to).map((v,i)=>[`col${i+1}`,v]));
    for(const room of out.data.children[0].children){room.columns=columns(room.columns);for(const rate of room.children)rate.columns=columns(rate.columns);}
    for(const row of out.calendar.options){row.prices=row.prices.slice(from,to);row.room.inventory=row.room.inventory.slice(from,to);}
    return out;
  };
  const result=quote.extractOptions(request,request.rooms[0],[slice(0,2),slice(1,4)]);
  assert.equal(result.completeness.search,'complete');
  assert.deepEqual(result.options[0].nightly.map(n=>n.date),stayDates(request));
  assert.equal(result.options[0].departure.combClosedToDeparture,false);
});
test('summary opens no detail panels; full requires at most five narrowed identities',()=>{
  assert.deepEqual(quote.detailCandidates?.('summary',[{id:'a'}]),[]);
  assert.equal(quote.detailCandidates('full',[{id:'a'},{id:'b'}]).length,2);
  assert.deepEqual(quote.detailCandidates('full',Array.from({length:6},(_,i)=>({id:String(i)}))),[]);
});
test('driver validation consumes contract date limits and v2 constraints',()=>{
  assert.ok(quote.validateRequest({...request,departureDate:'2026-11-10'}).length);
  assert.ok(quote.validateRequest({schemaVersion:2,...request,rooms:[{...request.rooms[0],id:'a',required:{bedTypes:['invented']}}]}).length);
});
test('duplicate native identities and changed contextual eligibility cannot merge into a verified offer',()=>{
  const f=multipleSource();const first={data:f.data,calendar:f.calendar};
  const duplicate=structuredClone(first);duplicate.data.children[0].children.push(structuredClone(duplicate.data.children[0].children[0]));
  const duplicateResult=quote.extractOptions(request,request.rooms[0],[duplicate]);
  assert.ok(duplicateResult.issues.some(i=>i.code==='AMBIGUOUS_NATIVE_ID'));
  const changed=structuredClone(first);changed.data.children[0].children[0].children[0].isNegotiatedRate=true;
  const result=quote.extractOptions(request,request.rooms[0],[first,changed]);
  assert.ok(result.issues.some(i=>i.code==='RATE_IDENTITY_CHANGED'));
});
test('legacy development selector no longer chooses a hidden winner from multiple offers',()=>{
  const f=multipleSource();
  assert.throws(()=>quote.selectOption(request,request.rooms[0],f.data,f.calendar),/EXPLICIT_OPTION_SELECTION_REQUIRED/);
});
test('negotiated eligibility requires every applied context ID, not merely a returned rate',()=>{
  const f=multipleSource();
  for(const room of f.data.children[0].children){room.children[0].code='BWS2B';room.children[0].isNegotiatedRate=true;}
  for(const row of f.calendar.options)row.rate='BWS2B: Best Available Rate';
  const scoped={...request,rateContext:{agency:{name:'Example Agency'},organization:{code:'1'}}};
  const resolved={agency:{id:'23'},organization:{id:'1'}};
  const criteria={travelAgencyID:'23',organizationID:'1'};
  const matched=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],resolved);
  assert.equal(matched.options[0].eligibility,'verified');
  assert.equal(matched.options[0].rateScope,'contextual');
  const mismatch=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria:{...criteria,organizationID:''}}],resolved);
  assert.equal(mismatch.options[0].eligibility,'conditional');
  assert.equal(mismatch.options[0].matchStatus,'unresolved');
});
test('bound party with no negotiated rates returns public BAR and flags no special rates',()=>{
  const f=multipleSource();
  const scoped={...request,rateContext:{agency:{name:'CWT JNB'}}};
  const resolved={agency:{id:'290'}};
  const criteria={travelAgencyID:'290'};
  const result=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],resolved);
  assert.equal(result.completeness.search,'complete');
  assert.equal(result.completeness.requiredFacts,'complete');
  assert.ok(result.issues.some(i=>i.code==='NO_SPECIAL_RATES'));
  for(const option of result.options) {
    assert.equal(option.rateScope,'public');
    assert.equal(option.matchStatus,'match');
    assert.equal(option.eligibility,'verified');
    assert.equal(option.conditions.find(c=>c.field==='rateContext')?.status,'unsatisfied');
  }
  f.data.children[0].children[0].children[0].isNegotiatedRate=true;
  f.data.children[0].children[0].children[0].code='BCO1B';
  f.calendar.options[0].rate='BCO1B: Negotiated Contracted  Best Available Rate';
  const mixed=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],resolved);
  assert.equal(mixed.issues.some(i=>i.code==='NO_SPECIAL_RATES'),false);
  assert.equal(mixed.options.find(o=>o.rate.code==='BAR').matchStatus,'unresolved');
  assert.equal(mixed.options.find(o=>o.rate.code==='BCO1B').matchStatus,'match');
  const bar=mixed.options.find(o=>o.rate.code==='BAR');
  assert.equal(quote.reapplyBedAssessment(bar,{matchStatus:'match',conditions:[]}).matchStatus,'unresolved');
});
test('filtered rate or room search cannot claim the party has no special rates',()=>{
  const f=multipleSource();
  const scoped={...request,rateContext:{agency:{name:'CWT JNB'}},rateCode:'BAR'};
  const resolved={agency:{id:'290'}};
  const criteria={travelAgencyID:'290'};
  const filtered=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],resolved);
  assert.equal(filtered.issues.some(i=>i.code==='NO_SPECIAL_RATES'),false);
  assert.equal(filtered.options.every(o=>o.matchStatus==='unresolved'),true);
});
test('summary states BAR is not a contracted rate when no special rates',()=>{
  const text=quote.summarize({
    outcome:'quote',
    groups:[{options:[]}],
    issues:[{code:'NO_SPECIAL_RATES',path:'rateContext',reason:'No special/negotiated rates for this party. Public BAR is returned.',action:'Tell the guest this is BAR, not a contracted rate.'}],
  });
  assert.match(text,/Hotel Availability: quote/);
  assert.match(text,/no special rates/i);
  assert.match(text,/not a contracted rate/i);
});
test('empty grid cannot claim no special rates',()=>{
  const f=multipleSource();
  f.data.children[0].children=[];
  f.calendar.options=[];
  const scoped={...request,rateContext:{agency:{name:'CWT JNB'}}};
  const result=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria:{travelAgencyID:'290'}}],{agency:{id:'290'}});
  assert.equal(result.issues.some(i=>i.code==='NO_SPECIAL_RATES'),false);
});
test('summary does not treat one group no-special as party-wide',()=>{
  const text=quote.summarize({
    outcome:'quote',
    groups:[
      {id:'group-1',issues:[{code:'NO_SPECIAL_RATES'}],options:[]},
      {id:'group-2',issues:[],options:[]},
    ],
  });
  assert.equal(/No special rates for this party/.test(text),false);
  assert.match(text,/group-1: no special rates/);
});
test('LOS restrictions and unexplained limited-night settings cannot become eligible availability',()=>{
  const f=multipleSource();f.rate.minLOS=4;
  assert.equal(quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]).options[0].availability,'restricted');
  f.rate.minLOS=null;f.rate.maxNights=2;
  assert.equal(quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]).options[0].availability,'unknown');
});
test('configured picker choices accept exact native code or label only',()=>{
  const choices=[{value:'CON',display:'Negotiated Contracted'},{value:'BAR',display:'BAR'}];
  assert.deepEqual(quote.configuredChoice?.(choices,'CON'),choices[0]);
  assert.deepEqual(quote.configuredChoice(choices,'Negotiated Contracted'),choices[0]);
  assert.equal(quote.configuredChoice(choices,'.*'),null);
});
test('restriction-only source rows remain conditional information',()=>{
  const f=multipleSource();for(const room of f.data.children[0].children)room.children[0].restricted=true;
  const result=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.ok(result.options.every(o=>o.availability==='restricted'&&o.eligibility==='conditional'));
});
test('group searches respect PMS-locked restricted visibility; other searches inspect the full grid',()=>{
  assert.equal(quote.nativeRestrictedVisibility?.(request),true);
  assert.equal(quote.nativeRestrictedVisibility({...request,rateContext:{group:{code:'123'}}}),false);
});
test('selected multi-group allocation uses proven building/room pools from extracted options',()=>{
  const f=multipleSource();
  const parsed=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  const groups=[
    {id:'a',request:{quantity:2,required:{roomCodes:['STQN'],rateCodes:['BAR']}},options:parsed.options},
    {id:'b',request:{quantity:2,required:{roomCodes:['STQN'],rateCodes:['BAR']}},options:parsed.options},
  ];
  const allocation=composeAllocation(groups,'HRCEN');
  assert.equal(parsed.options.find(o=>o.room.code==='STQN').room.buildingCode,'MAIN');
  assert.equal(allocation.status,'insufficient');
  assert.equal(allocation.pools[0].id,'HRCEN:MAIN:STQN');
  assert.equal(allocation.pools[0].nights[0].demand,4);
  assert.equal(allocation.pools[0].nights[0].supply,3);
});
