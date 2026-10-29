import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as quote from './fetch-quote.mjs';
import { barWalkInSource, multipleSource, selectionFixture } from './fetch-quote-fixtures.mjs';
import { composeAllocation, restrictedNightsOf } from './quote-contract.mjs';
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
test('registry strategy labels map to their observed Hotel Availability values',()=>{
  const cases=[['Airline Crews','AIR'],['Domestic Leisure','DOML'],['Negoticated Contracted','CON']];
  for(const [label,value] of cases){
    const scoped={...request,propertyCode:'HRDAV',search:{salesStrategy:label}};
    const criteria={propertyCodes:'HRDAV',startDate:'2026-09-24T00:00:00',adultCount:1,childCount:0,salesStrategy:value,lengthOfStay:'DY',shopByDay:false,
      roomTypeCodes:'',ratePlanCodes:'',groupID:'',organizationID:'',travelAgencyID:'',convertFromPropertyCurrency:false,currency:null};
    assert.doesNotThrow(()=>quote.assertApplied(scoped,scoped.rooms[0],criteria));
    assert.throws(()=>quote.assertApplied(scoped,scoped.rooms[0],{...criteria,salesStrategy:'BAR'}));
  }
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
test('BAR grid Walk-in Rate stays in options with existing BAR rows',()=>{
  // G9 HRDAV 2026-11-08→12 STKNG: HMS BAR grid showed WAL Walk-in Rate 4680×4 that Nava omitted.
  const stay={propertyCode:'HRDAV',arrivalDate:'2026-11-08',departureDate:'2026-11-12',
    rooms:[{quantity:1,adults:1,children:0,childAges:[],required:{roomCodes:['STKNG'],boardBases:['breakfast']}}]};
  const amounts={BAR:'4680.00',BLRB:'4220.00',BARDIS:'3744.00',WAL:'4680.00'};
  for (const includeNativeWal of [false, true]) {
    const f=barWalkInSource({includeNativeWal});
    const result=quote.extractOptions(stay,stay.rooms[0],[{data:f.data,calendar:f.calendar}]);
    const codes=result.options.filter(o=>o.nightly.length===4).map(o=>o.rate.code).sort();
    assert.deepEqual(codes,['BAR','BARDIS','BLRB','WAL']);
    for (const [code,amount] of Object.entries(amounts)) {
      const option=result.options.find(o=>o.rate.code===code);
      assert.equal(option.room.code,'STKNG');
      assert.deepEqual(option.nightly.map(n=>n.price.amount),Array(4).fill(amount));
    }
    const wal=result.options.find(o=>o.rate.code==='WAL');
    assert.equal(wal.rate.label,'Walk-in Rate');
    assert.equal(wal.board,'Bed & Breakfast NR');
    assert.equal(wal.matchStatus,'match');
    assert.equal(result.options.filter(o=>o.rate.code==='WAL').length,1);
    if (!includeNativeWal) assert.notEqual(wal.availability,'available');
  }
});
test('return limit hides only quote-eligible matches without claiming unseen matches',()=>{
  const rows=[
    {id:0,matchStatus:'match',eligibility:'verified',availability:'available'},
    {id:1,matchStatus:'match',eligibility:'verified',availability:'available'},
    {id:2,matchStatus:'match',eligibility:'conditional',availability:'restricted'},
    {id:3,matchStatus:'unresolved'},
  ];
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
  assert.equal(quote.sourceFacts({room:{code:'STKNG',label:'Standard King'},rate:{code:'WAL'},board:'Bed & Breakfast NR'},'').boardBase,'breakfast');
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
test('summary opens no detail panels; full reads every identity',()=>{
  assert.deepEqual(quote.detailCandidates?.('summary',[{id:'a'}]),[]);
  assert.equal(quote.detailCandidates('full',[{id:'a'},{id:'b'}]).length,2);
  assert.equal(quote.detailCandidates('full',Array.from({length:17},(_,i)=>({id:String(i)}))).length,17);
});
test('full-mode 17-row wholesale window stays quote with unread leftover details',()=>{
  assert.equal(quote.detailReadBudgetMs({}),90_000);
  assert.equal(quote.detailReadBudgetMs({QUOTE_DETAIL_BUDGET_MS:'15000'}),15_000);
  const wsPlans=['BWS1B','BWS2B','BWS3B','NG139B','NGD73B','NGD77B','NGD90B','NGDS1B','NGDS2B','NGDS8B','NGDTSB','WSF1B','WSF2B','WSF3B','WSG5B','WSG5DB','BWS4B'];
  const open={israteavailable:true,restricted:false,combClosed:false,combClosedToArrival:false,combClosedToDeparture:false,combMinLOSToArrival:0,combMinLOSToDeparture:0,combMaxLOSToArrival:null,combMaxLOSToDeparture:null,combMinLOSToThrough:null,combMaxLOSToThrough:null};
  const columns=Object.fromEntries([1,2].map(n=>[`col${n}`,{...open,value:2500}]));
  const stay={propertyCode:'HRDAV',arrivalDate:'2027-02-16',departureDate:'2027-02-17',details:'full',rooms:[{quantity:1,adults:1,children:0,childAges:[]}],search:{salesStrategy:'Wholesale'},rateContext:{agency:{name:'Example Agency'}}};
  const data={datesList:['02/16/2027','02/17/2027'],children:[{isprop:true,issummary:false,code:'HRDAV',currency:'ZAR',children:[{code:'STKNG',desc:'Standard King',buildingCode:null,children:wsPlans.map(code=>({code,desc:`Wholesale ${code}`,currency:'ZAR',isNegotiatedRate:code==='BWS4B',restricted:false,minLOS:null,maxLOS:null,minLeadTime:null,maxLeadTime:null,haspolicies:true,columns})),columns:Object.fromEntries([1,2].map(n=>[`col${n}`,{value:84}]))}]}]};
  const calendar={headers:['16-FEB-2027Tuesday','17-FEB-2027Wednesday'],options:wsPlans.map(code=>({room:{code:'STKNG',inventory:['84','84']},rate:`${code}: Wholesale ${code}`,board:'Bed & Breakfast NR',prices:['R2,500.00','R2,500.00']}))};
  const result=quote.extractOptions(stay,stay.rooms[0],[{data,calendar,criteria:{salesStrategy:'WS',travelAgencyID:'23'}}],{agency:{id:'23'}});
  assert.equal(result.options.length,17);
  const nights=quote.stayDates(stay);
  for(const [index,option] of result.options.entries()) {
    option.details=index<3?{status:'complete',nightly:nights.map(date=>({date}))}:quote.unreadDetails();
  }
  const grouped=quote.groupOutcomeFromOptions(result.options,{details:'full',searchComplete:true});
  assert.equal(grouped.outcome,'quote');
  assert.equal(grouped.requiredFacts,'complete');
  assert.equal(grouped.eligible.length,3);
  assert.equal(result.options.filter(o=>o.details.status==='not_read').length,14);
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
test('Centurion government rates stay conditional without guest entitlement, regardless of search or party',()=>{
  const f=multipleSource();
  const rate=f.data.children[0].children[0].children[0];
  rate.code='NGOVDB';rate.desc='Local Government Rate Dinner';
  f.calendar.options[0].rate='NGOVDB: Local Government Rate Dinner';
  for(const [strategy,criteria,resolved,rateContext] of [
    ['Government',{salesStrategy:'GOV'},{},undefined],
    ['BAR',{salesStrategy:'BAR'},{},undefined],
    ['Government',{salesStrategy:'GOV',travelAgencyID:'23'},{agency:{id:'23'}},{agency:{name:'Example Agency'}}],
  ]){
    const scoped={...request,search:{salesStrategy:strategy},...(rateContext?{rateContext}:{})};
    const result=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],resolved);
    const government=result.options.find(option=>option.rate.code==='NGOVDB');
    assert.equal(government?.eligibility,'conditional');
    assert.ok(government?.conditions.some(condition=>condition.field==='governmentEligibility'&&condition.status==='unknown'));
    quote.reapplyBedAssessment(government,{matchStatus:'match',conditions:[]});
    assert.ok(government.conditions.some(condition=>condition.field==='governmentEligibility'&&condition.status==='unknown'));
    assert.equal(quote.pricedEligibleOptions([government]).length,0);
    assert.equal(result.options.find(option=>option.rate.code==='BAR')?.eligibility,'verified');
  }
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
  assert.equal(mixed.options.find(o=>o.rate.code==='BAR').matchStatus,'match');
  assert.equal(mixed.options.find(o=>o.rate.code==='BCO1B').matchStatus,'match');
  const bar=mixed.options.find(o=>o.rate.code==='BAR');
  assert.equal(quote.reapplyBedAssessment(bar,{matchStatus:'match',conditions:[]}).matchStatus,'match');
});
test('filtered rate or room search cannot claim the party has no special rates',()=>{
  const f=multipleSource();
  const scoped={...request,rateContext:{agency:{name:'CWT JNB'}},rateCode:'BAR'};
  const resolved={agency:{id:'290'}};
  const criteria={travelAgencyID:'290'};
  const filtered=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],resolved);
  assert.equal(filtered.issues.some(i=>i.code==='NO_SPECIAL_RATES'),false);
  assert.equal(filtered.options.every(o=>o.matchStatus==='match'&&o.conditions.find(c=>c.field==='rateContext')?.kind==='preferred'),true);
});
test('a verified party keeps its public row bookable; an unverified party still keeps public BAR bookable',()=>{
  const f=multipleSource();
  const scoped={...request,rateContext:{agency:{name:'CWT JNB'}}};
  const criteria={travelAgencyID:'290'};
  const verified=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],{agency:{id:'290'}});
  assert.ok(verified.options.length>0&&verified.options.every(o=>o.rateScope==='public'));
  assert.ok(verified.issues.some(i=>i.code==='NO_SPECIAL_RATES'));
  assert.match(verified.issues.find(i=>i.code==='NO_SPECIAL_RATES').action,/not a contracted rate/i);
  assert.equal(verified.issues.some(i=>i.code==='PARTY_RATES_NOT_CHECKED'),false);
  for(const o of verified.options){
    assert.equal(o.matchStatus,'match');
    const cond=o.conditions.find(c=>c.field==='rateContext');
    assert.equal(cond.kind,'preferred');
    assert.match(cond.reason,/public BAR is returned/i);
  }
  const unverified=quote.extractOptions(scoped,request.rooms[0],[{data:f.data,calendar:f.calendar,criteria}],{});
  assert.ok(unverified.options.length>0&&unverified.options.every(o=>o.rateScope==='public'));
  assert.ok(unverified.issues.some(i=>i.code==='PARTY_RATES_NOT_CHECKED'));
  assert.match(unverified.issues.find(i=>i.code==='PARTY_RATES_NOT_CHECKED').reason,/Party rates were not checked; public BAR shown/);
  assert.equal(unverified.completeness.search,'complete');
  assert.equal(unverified.completeness.requiredFacts,'complete');
  assert.equal(unverified.issues.some(i=>i.code==='NO_SPECIAL_RATES'),false);
  for(const o of unverified.options){
    assert.equal(o.matchStatus,'match');
    assert.equal(o.eligibility,'verified');
    assert.equal(o.rateScope,'public');
    const cond=o.conditions.find(c=>c.field==='rateContext');
    assert.equal(cond.kind,'preferred');
    assert.match(cond.reason,/public rate for this party/i);
    assert.match(cond.reason,/contract rate/i);
  }
  assert.equal(quote.reapplyBedAssessment(unverified.options[0],{matchStatus:'match',conditions:[]}).matchStatus,'match');
});
test('two-group public BAR/PROMO rows verify and compose; unbound WS stays conditional',()=>{
  const open={israteavailable:true,restricted:false,combClosed:false,combClosedToArrival:false,combClosedToDeparture:false,combMinLOSToArrival:0,combMinLOSToDeparture:0,combMaxLOSToArrival:null,combMaxLOSToDeparture:null,combMinLOSToThrough:null,combMaxLOSToThrough:null};
  const columns=Object.fromEntries([1,2].map(n=>[`col${n}`,{...open,value:2500}]));
  const windowFor=(room,rates,strategy)=>({
    data:{datesList:['02/07/2027','02/08/2027'],children:[{isprop:true,issummary:false,code:'HRDAV',currency:'ZAR',children:[{code:room,desc:room,buildingCode:null,children:rates.map(r=>({code:r.code,desc:r.desc,currency:'ZAR',isNegotiatedRate:false,restricted:false,minLOS:null,maxLOS:null,minLeadTime:null,maxLeadTime:null,haspolicies:true,columns})),columns:Object.fromEntries([1,2].map(n=>[`col${n}`,{value:84}]))}]}]},
    calendar:{headers:['07-FEB-2027Sunday','08-FEB-2027Monday'],options:rates.map(r=>({room:{code:room,inventory:['84','84']},rate:`${r.code}: ${r.desc}`,board:'Bed & Breakfast NR',prices:['R2,500.00','R2,500.00']}))},
    criteria:{salesStrategy:strategy},
  });
  const barPromo=[{code:'BAR',desc:'Best Available Rate'},{code:'PMO1B',desc:'Promotion Breakfast'}];
  const mixed=[{code:'BAR',desc:'Best Available Rate'},{code:'BWS1B',desc:'Wholesale Best Available Rate 1'}];
  const groups=[{id:'g1',room:'STKNG'},{id:'g2',room:'STWN'}];
  const wholesale={propertyCode:'HRDAV',arrivalDate:'2027-02-07',departureDate:'2027-02-08',details:'summary',rooms:groups.map(g=>({id:g.id,quantity:g.id==='g1'?1:2,adults:g.id==='g1'?2:1,children:0,childAges:[]})),search:{salesStrategy:'Wholesale'},rateContext:{agency:{name:'Example Agency'}}};
  for(const group of groups){
    const result=quote.extractOptions(wholesale,wholesale.rooms.find(r=>r.id===group.id),[{...windowFor(group.room,mixed,'WS')}],{});
    const bar=result.options.find(o=>o.rate.code==='BAR');
    const ws=result.options.find(o=>o.rate.code==='BWS1B');
    assert.equal(bar.rateScope,'public');
    assert.equal(bar.eligibility,'verified');
    assert.equal(bar.matchStatus,'match');
    assert.equal(ws.rateScope,'contextual');
    assert.equal(ws.eligibility,'conditional');
    assert.equal(ws.matchStatus,'unresolved');
    const grouped=quote.groupOutcomeFromOptions(result.options,{details:'summary',searchComplete:true});
    assert.equal(grouped.outcome,'quote');
    assert.equal(grouped.requiredFacts,'complete');
    assert.ok(grouped.eligible.some(o=>o.rate.code==='BAR'));
    assert.equal(grouped.eligible.some(o=>o.rate.code==='BWS1B'),false);
  }
  const promotions={...wholesale,search:{salesStrategy:'Promotions'},rateContext:undefined};
  const promo=quote.extractOptions(promotions,promotions.rooms[0],[windowFor('STKNG',barPromo,'PROMO')]);
  assert.equal(promo.options.find(o=>o.rate.code==='BAR').rateScope,'public');
  assert.equal(promo.options.find(o=>o.rate.code==='BAR').eligibility,'verified');
  assert.equal(promo.options.find(o=>o.rate.code==='PMO1B').rateScope,'public');
  assert.equal(promo.options.find(o=>o.rate.code==='PMO1B').eligibility,'verified');
  const negotiatedPromo={...promotions};
  const negotiatedWindow=windowFor('STKNG',[{code:'PMO1B',desc:'Promotion Breakfast'}],'PROMO');
  negotiatedWindow.data.children[0].children[0].children[0].isNegotiatedRate=true;
  const negotiated=quote.extractOptions(negotiatedPromo,negotiatedPromo.rooms[0],[negotiatedWindow]);
  assert.equal(negotiated.options.find(o=>o.rate.code==='PMO1B').rateScope,'contextual');
  assert.equal(negotiated.options.find(o=>o.rate.code==='PMO1B').eligibility,'conditional');
  const contracted={...wholesale,search:{salesStrategy:'Negoticated Contracted'},rateContext:undefined};
  const nc=quote.extractOptions(contracted,contracted.rooms[0],[windowFor('STKNG',[{code:'PMO1B',desc:'Promotion Breakfast'}],'NC')]);
  assert.equal(nc.options.find(o=>o.rate.code==='PMO1B').rateScope,'unknown');
  assert.equal(nc.options.find(o=>o.rate.code==='PMO1B').eligibility,'conditional');
  const air=quote.extractOptions({...wholesale,search:{salesStrategy:'Airline Crews'},rateContext:undefined},wholesale.rooms[0],[windowFor('STKNG',[{code:'PMO1B',desc:'Promotion Breakfast'}],'AIR')]);
  assert.equal(air.options.find(o=>o.rate.code==='PMO1B').rateScope,'unknown');
  const preset=quote.extractOptions({...wholesale,search:{salesStrategy:'Preset'},rateContext:undefined},wholesale.rooms[0],[windowFor('STKNG',[{code:'PMO1B',desc:'Promotion Breakfast'}],'PRESET')]);
  assert.equal(preset.options.find(o=>o.rate.code==='PMO1B').rateScope,'unknown');
  const doml=quote.extractOptions({...wholesale,search:{salesStrategy:'Domestic Leisure'},rateContext:undefined},wholesale.rooms[0],[windowFor('STKNG',[{code:'PMO1B',desc:'Promotion Breakfast'}],'DOML')]);
  assert.equal(doml.options.find(o=>o.rate.code==='PMO1B').rateScope,'unknown');
  const barShop={...wholesale,search:{salesStrategy:'BAR'},rateContext:{organization:{name:'Example Company'}}};
  const crossed=quote.extractOptions(barShop,barShop.rooms[0],[{...windowFor('STKNG',mixed,'BAR'),criteria:{salesStrategy:'BAR',organizationID:'1'}}],{organization:{id:'1'}});
  assert.equal(crossed.options.find(o=>o.rate.code==='BAR').eligibility,'verified');
  assert.equal(crossed.options.find(o=>o.rate.code==='BWS1B').eligibility,'conditional');
  assert.equal(crossed.options.find(o=>o.rate.code==='BWS1B').matchStatus,'unresolved');
});
test('WS contract rows without a verified agency stay conditional',()=>{
  const open={israteavailable:true,restricted:false,combClosed:false,combClosedToArrival:false,combClosedToDeparture:false,combMinLOSToArrival:0,combMinLOSToDeparture:0,combMaxLOSToArrival:null,combMaxLOSToDeparture:null,combMinLOSToThrough:null,combMaxLOSToThrough:null};
  const columns=Object.fromEntries([1,2].map(n=>[`col${n}`,{...open,value:2500}]));
  const stay={propertyCode:'HRDAV',arrivalDate:'2027-02-07',departureDate:'2027-02-08',details:'summary',rooms:[{id:'g1',quantity:1,adults:2,children:0,childAges:[]}],search:{salesStrategy:'Wholesale'},rateContext:{agency:{name:'Example Agency'}}};
  const result=quote.extractOptions(stay,stay.rooms[0],[{
    data:{datesList:['02/07/2027','02/08/2027'],children:[{isprop:true,issummary:false,code:'HRDAV',currency:'ZAR',children:[{code:'STKNG',desc:'STKNG',buildingCode:null,children:[{code:'BWS1B',desc:'Wholesale Best Available Rate 1',currency:'ZAR',isNegotiatedRate:false,restricted:false,minLOS:null,maxLOS:null,minLeadTime:null,maxLeadTime:null,haspolicies:true,columns}],columns:Object.fromEntries([1,2].map(n=>[`col${n}`,{value:84}]))}]}]},
    calendar:{headers:['07-FEB-2027Sunday','08-FEB-2027Monday'],options:[{room:{code:'STKNG',inventory:['84','84']},rate:'BWS1B: Wholesale Best Available Rate 1',board:'Bed & Breakfast NR',prices:['R2,500.00','R2,500.00']}]},
    criteria:{salesStrategy:'WS'},
  }],{});
  const ws=result.options.find(o=>o.rate.code==='BWS1B');
  assert.equal(ws.rateScope,'contextual');
  assert.equal(ws.eligibility,'conditional');
  assert.equal(ws.matchStatus,'unresolved');
  const grouped=quote.groupOutcomeFromOptions(result.options,{details:'summary',searchComplete:true});
  assert.equal(grouped.eligible.some(o=>o.rate.code==='BWS1B'),false);
});
test('OPTION_LIMIT counts only a cut row that is not an alternative',()=>{
  const rows=[{id:0,matchStatus:'match'},{id:1,matchStatus:'alternative'},{id:2,matchStatus:'alternative'}];
  assert.equal(quote.hiddenRowsMatter(rows,1),false);
  assert.equal(quote.hiddenRowsMatter(rows,0),true);
  assert.equal(quote.hiddenRowsMatter([{matchStatus:'match'},{matchStatus:'unresolved'}],1),true);
});
test('a 200-option cap truncates a further matching row',()=>{
  const rows=Array.from({length:201},(_,id)=>({id,matchStatus:'match',eligibility:'verified',availability:'available'}));
  const limited=quote.limitOptions(rows,200);
  assert.equal(limited.options.length,200);
  assert.equal(limited.truncated,true);
  assert.equal(limited.matchingRowsUnseen,true);
  assert.equal(quote.hiddenRowsMatter(rows,200),true);
});
test('summary states BAR is not a contracted rate when no special rates',()=>{
  const text=quote.summarize({
    outcome:'quote',
    groups:[{id:'group-1',options:[],issues:[{code:'NO_SPECIAL_RATES',path:'rateContext',reason:'No special/negotiated rates for this party. Public BAR is returned.',action:'Tell the guest this is BAR, not a contracted rate.'}]}],
  });
  assert.match(text,/Hotel Availability: quote/);
  assert.match(text,/no special rates/i);
  assert.match(text,/not a contracted rate/i);
});
test('summary states party rates were not checked when the party never verified',()=>{
  const text=quote.summarize({
    outcome:'quote',
    groups:[{id:'group-1',options:[],issues:[{code:'PARTY_RATES_NOT_CHECKED',path:'rateContext',reason:'Party rates were not checked; public BAR shown.'}]}],
  });
  assert.match(text,/Hotel Availability: quote/);
  assert.match(text,/Party rates were not checked; public BAR shown/);
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
test('incomplete later page cannot claim no special rates',()=>{
  const f=multipleSource();
  const scoped={...request,rateContext:{agency:{name:'CWT JNB'}}};
  const result=quote.extractOptions(scoped,request.rooms[0],[
    {data:f.data,calendar:f.calendar,criteria:{travelAgencyID:'290'}},
    {data:null,calendar:null,criteria:{travelAgencyID:'290'}},
  ],{agency:{id:'290'}});
  assert.equal(result.issues.some(i=>i.code==='NO_SPECIAL_RATES'),false);
  assert.equal(result.completeness.search,'partial');
});
test('LOS restrictions include reasons and unexplained limited-night settings stay unknown',()=>{
  const f=multipleSource();f.rate.minLOS=4;
  let option=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]).options[0];
  assert.equal(option.availability,'restricted');
  assert.equal(option.availabilityReason,'Rate minimum stay requires 4 nights; requested stay is 3 nights.');
  f.rate.minLOS=null;f.rate.maxLOS=2;
  option=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]).options[0];
  assert.equal(option.availability,'restricted');
  assert.equal(option.availabilityReason,'Rate maximum stay allows 2 nights; requested stay is 3 nights.');
  f.rate.maxLOS=null;f.rate.maxNights=2;
  assert.equal(quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]).options[0].availability,'unknown');
});
test('departure maximum-LOS restriction survives native projection',()=>{
  const f=multipleSource();
  f.rate.columns.col4.combMaxLOSToDeparture=2;
  const projected=quote.projectWindow({data:f.data,calendar:f.calendar,criteria:{}});
  const option=quote.extractOptions(request,request.rooms[0],[projected]).options[0];
  assert.equal(option.availability,'restricted');
  assert.equal(option.availabilityReason,'Departure maximum stay allows 2 nights; requested stay is 3 nights.');
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
test('a night HMS closes to sale on every matching row is named for each room type, while the rows stay restricted',()=>{
  const f=multipleSource();
  for(const room of f.data.children[0].children) room.children[0].columns.col2.restricted=true;
  const result=quote.extractOptions(request,request.rooms[0],[{data:f.data,calendar:f.calendar}]);
  assert.ok(result.options.every(o=>o.availability==='restricted'&&o.eligibility==='conditional'));
  assert.deepEqual(restrictedNightsOf(result.options),[
    {roomCode:'STQN',roomLabel:'Standard Queen',date:'2026-09-25'},
    {roomCode:'STWN',roomLabel:'Standard Twin',date:'2026-09-25'},
  ]);
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

// A fake Hotel Availability menu. Hotel Availability appears from Availability click `revealOnClick` on,
// or from the start when alreadyVisible. Infinity never reveals it.
function hotelMenuPage({revealOnClick=2,alreadyVisible=false,dateField='startdate'}={}){
  const log=[];let availabilityClicks=0;
  const visibleNames=()=>['Front Desk','Availability',...(alreadyVisible||availabilityClicks>=revealOnClick?['Hotel Availability']:[])];
  const treeNode=(matchers)=>{
    const matching=()=>visibleNames().filter(name=>matchers.every(re=>re.test(name)));
    return{
      filter:({hasText})=>treeNode([...matchers,hasText]),
      count:async()=>matching().length,
      click:async()=>{const[name]=matching();if(!name)throw new Error('TimeoutError: node is not visible');log.push(name);if(name==='Availability')availabilityClicks+=1;},
      waitFor:async()=>{if(!matching().length)throw new Error('TimeoutError: waitFor');},
    };
  };
  const page={
    locator(selector){
      if(selector==='a.app-menu-trigger:visible')return{click:async()=>{log.push('menu');}};
      if(selector==='span.x-tree-node-text:visible')return treeNode([]);
      if(selector==='input[name="startdate"]:visible, input[name="dates"]:visible')return{first:()=>({waitFor:async()=>{
        if(!dateField)throw new Error('TimeoutError: no visible date field');
        log.push(dateField);
      }})};
      throw new Error(`unexpected selector ${selector}`);
    },
    getByRole:(role,{name})=>({waitFor:async()=>{log.push(`${role}:${name}`);}}),
  };
  return{page,log,availabilityClicks:()=>availabilityClicks};
}
test('Hotel Availability menu ignores a first Availability click that does not reveal the child',async()=>{
  const menu=hotelMenuPage({revealOnClick:2});
  await quote.openHotelAvailability(menu.page);
  assert.deepEqual(menu.log,['menu','Front Desk','Availability','Availability','Hotel Availability','startdate','heading:Hotel Availability']);
});
test('Hotel Availability menu does not click Availability when the child is already visible',async()=>{
  const menu=hotelMenuPage({alreadyVisible:true});
  await quote.openHotelAvailability(menu.page);
  assert.deepEqual(menu.log,['menu','Front Desk','Hotel Availability','startdate','heading:Hotel Availability']);
  assert.equal(menu.availabilityClicks(),0);
});
test('Hotel Availability menu accepts the visible cloud date range',async()=>{
  const menu=hotelMenuPage({alreadyVisible:true,dateField:'dates'});
  await quote.openHotelAvailability(menu.page);
  assert.deepEqual(menu.log,['menu','Front Desk','Hotel Availability','dates','heading:Hotel Availability']);
});
test('Hotel Availability menu rejects a screen without a visible date control',async()=>{
  const menu=hotelMenuPage({alreadyVisible:true,dateField:null});
  await assert.rejects(quote.openHotelAvailability(menu.page),/no visible date field/);
});
test('Hotel Availability menu stops after four Availability clicks and fails when the child never appears',async()=>{
  const menu=hotelMenuPage({revealOnClick:Infinity});
  await assert.rejects(quote.openHotelAvailability(menu.page),/TimeoutError/);
  assert.equal(menu.availabilityClicks(),4);
});
test('HRDAV wholesale BWS1B with a verified agency is contextual and verified',()=>{
  // Codes/labels from HRDAV observedStrategyRatePlans.WS (wholesale-shop.png, docs/research/2026-10-25-hrdav-dom-read.md). Amounts are fixture, not live prices.
  const open={israteavailable:true,restricted:false,combClosed:false,combClosedToArrival:false,combClosedToDeparture:false,combMinLOSToArrival:0,combMinLOSToDeparture:0,combMaxLOSToArrival:null,combMaxLOSToDeparture:null,combMinLOSToThrough:null,combMaxLOSToThrough:null};
  const columns=Object.fromEntries([1,2].map(n=>[`col${n}`,{...open,value:2500}]));
  const stay={propertyCode:'HRDAV',arrivalDate:'2027-02-16',departureDate:'2027-02-17',rooms:[{quantity:1,adults:1,children:0,childAges:[]}],search:{salesStrategy:'Wholesale'},rateContext:{agency:{name:'Example Agency'}}};
  const data={datesList:['02/16/2027','02/17/2027'],children:[{isprop:true,issummary:false,code:'HRDAV',currency:'ZAR',children:[{code:'STKNG',desc:'Standard King',buildingCode:null,children:[{code:'BWS1B',desc:'Wholesale Best Available Rate 1',currency:'ZAR',isNegotiatedRate:false,restricted:false,minLOS:null,maxLOS:null,minLeadTime:null,maxLeadTime:null,haspolicies:true,columns}],columns:Object.fromEntries([1,2].map(n=>[`col${n}`,{value:84}]))}]}]};
  const calendar={headers:['16-FEB-2027Tuesday','17-FEB-2027Wednesday'],options:[{room:{code:'STKNG',inventory:['84','84']},rate:'BWS1B: Wholesale Best Available Rate 1',board:'Bed & Breakfast NR',prices:['R2,500.00','R2,500.00']}]};
  const result=quote.extractOptions(stay,stay.rooms[0],[{data,calendar,criteria:{salesStrategy:'WS',travelAgencyID:'23'}}],{agency:{id:'23'}});
  const option=result.options.find(o=>o.rate.code==='BWS1B');
  assert.equal(option.rateScope,'contextual');
  assert.equal(option.eligibility,'verified');
  assert.equal(option.matchStatus,'match');
});
