import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as quote from './fetch-quote.mjs';
const { validateRequest, stayDates, displayDate } = quote;
const request = {propertyCode:'HRCEN',arrivalDate:'2026-09-24',departureDate:'2026-09-27',rooms:[{quantity:2,adults:1,children:0,childAges:[]}]};
test('input-gap invocation has durable events and explicit capture status without browser access',async t=>{
  const result=await quote.fetchQuote({requestPath:new URL('./examples/missing-age.json',import.meta.url),env:{},video:true});
  t.after(()=>rm(result.evidenceDirectory,{recursive:true,force:true}));
  assert.equal(result.outcome,'input_gap');
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
test('timeout and returned-login errors are execution failures, not unavailability',()=>{
  const timeout=new Error('waiting timed out'); timeout.name='TimeoutError';
  for(const error of [timeout,new Error('SESSION_RETURNED_TO_LOGIN')]) {
    const result=quote.executionFailure(error,'search');
    assert.equal(result.outcome,'execution_failure');
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
  const column={value:1780,israteavailable:true,restricted:false,combClosedToDeparture:false};
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
