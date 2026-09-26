import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as capture from './audit.mjs';
const { zipSync, unzipSync } = createRequire(new URL('../../package.json', import.meta.url))('fflate');

async function fixture(t, options={}) {
  assert.equal(typeof capture.createAudit, 'function', 'private audit capture is implemented');
  const directory=await mkdtemp(join(tmpdir(),'quote-audit-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const audit=await capture.createAudit(directory,options);
  return {directory,audit};
}

// The remote browser boundary is replaced; files, hashing and the bounded
// credential sanitizer are real. A separate live probe verifies playable video.
function browserPage({badTrace=false,badVideo=false}={}) {
  const page=new EventEmitter();
  let videoPath;
  const trace=zipSync({
    'trace.trace':Buffer.from(JSON.stringify({type:'log',message:'secret-password cookie-value booking-value'})+'\n'),
    'trace.network':Buffer.from(JSON.stringify({type:'resource-snapshot',snapshot:{request:{
      url:'https://hotel.invalid/grid?token=private-token',headers:[{name:'Cookie',value:'sid=cookie-value'}],
      postData:{text:'booking-value'}}}})+'\n'),
    'trace.stacks':Buffer.from('{}'),
    'screencast/page@1234-1789688535557.jpeg':Buffer.from([255,216,255,224,1,2,3,4]),
  });
  page.context=()=>({storageState:async()=>({cookies:[{value:'cookie-value'}],origins:[]}),
    tracing:{start:async()=>{},stop:async({path})=>writeFile(path,badTrace?Buffer.from('invalid zip'):trace)}});
  page.screencast={start:async({path})=>{if(badVideo) throw new Error('secret-password');videoPath=path;},
    stop:async()=>{await writeFile(videoPath,Buffer.from('video bytes'));}};
  page.locator=()=>({count:async()=>0});
  page.screenshot=async({path})=>writeFile(path,Buffer.from('checkpoint bytes'));
  return page;
}

test('pre-auth runs retain events and explicitly mark recording not started',async t=>{
  const {directory,audit}=await fixture(t,{video:true});
  audit.event('input');
  await assert.rejects(audit.checkpoint('login-complete'),/AUDIT_NOT_STARTED/);
  const result=await audit.finish();
  assert.equal(result.status,'not_started');
  assert.equal(result.video.requested,true);
  assert.equal(result.video.status,'not_started');
  const events=(await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e=>e.phase==='input'));
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
  assert.equal((await stat(directory)).mode&0o777,0o700);
});

test('authenticated capture saves named checkpoints and a sanitized trace with real hashes',async t=>{
  const {directory,audit}=await fixture(t,{secrets:['secret-password']});
  const page=browserPage();
  await audit.start(page);
  page.emit('request',{postDataJSON:()=>({bookingSessionID:'booking-value'})});
  await audit.checkpoint('login-complete');
  await assert.rejects(audit.checkpoint('../escape'),/INVALID_CHECKPOINT_NAME/);
  const result=await audit.finish();
  assert.equal(result.status,'complete');
  assert.equal(result.video.status,'disabled');
  const trace=await readFile(join(directory,'trace.zip'));
  const entries=unzipSync(trace);
  for(const bytes of Object.values(entries)) for(const secret of ['secret-password','cookie-value','booking-value','private-token'])
    assert.equal(Buffer.from(bytes).includes(Buffer.from(secret)),false);
  assert.ok(entries['screencast/page@1234-1789688535557.jpeg']);
  assert.equal(result.trace.sha256,createHash('sha256').update(trace).digest('hex'));
  assert.equal(result.screenshots[0].path,'screenshots/login-complete.png');
  for(const name of ['trace.zip','events.jsonl','screenshots/login-complete.png']) assert.equal((await stat(join(directory,name))).mode&0o777,0o600);
  await assert.rejects(stat(join(directory,'.trace-raw.zip')),{code:'ENOENT'});
  await assert.rejects(stat(join(directory,'video.webm')),{code:'ENOENT'});
});

test('video is opt-in and finalized into the same private bundle',async t=>{
  const {directory,audit}=await fixture(t,{video:true});
  await audit.start(browserPage());
  const result=await audit.finish();
  assert.equal(result.status,'complete');
  assert.equal(result.video.status,'complete');
  assert.equal(result.video.path,'video.webm');
  assert.equal(result.video.bytes,(await stat(join(directory,'video.webm'))).size);
});

test('failed trace sanitization deletes the raw archive and reports incomplete capture',async t=>{
  const {directory,audit}=await fixture(t);
  await audit.start(browserPage({badTrace:true}));
  const result=await audit.finish();
  assert.equal(result.status,'incomplete');
  assert.ok(result.errors.includes('TRACE_CAPTURE_FAILED'));
  await assert.rejects(stat(join(directory,'.trace-raw.zip')),{code:'ENOENT'});
  await assert.rejects(stat(join(directory,'trace.zip')),{code:'ENOENT'});
});

test('video startup failure still finalizes the trace and never leaks the browser error',async t=>{
  const {audit}=await fixture(t,{video:true});
  await assert.rejects(audit.start(browserPage({badVideo:true})),/VIDEO_START_FAILED/);
  const result=await audit.finish();
  assert.equal(result.status,'incomplete');
  assert.equal(result.trace.status,'complete');
  assert.equal(result.video.status,'failed');
  assert.equal(JSON.stringify(result).includes('secret-password'),false);
});

test('a returned login screen makes missing checkpoints explicit in the audit status',async t=>{
  const {audit}=await fixture(t);
  const page=browserPage();
  await audit.start(page);
  page.locator=()=>({count:async()=>1});
  await assert.rejects(audit.checkpoint('failure'),/CHECKPOINT_RETURNED_TO_LOGIN/);
  const result=await audit.finish();
  assert.equal(result.status,'incomplete');
  assert.ok(result.errors.includes('CHECKPOINT_RETURNED_TO_LOGIN'));
});

test('video registers its full-size frames before trace subscribes to the shared screencast',async t=>{
  const {audit}=await fixture(t,{video:true});
  const page=browserPage();
  const context=page.context();
  page.context=()=>context;
  let hasVideoSize=false;
  const startVideo=page.screencast.start;
  page.screencast.start=async options=>{await startVideo(options);hasVideoSize=options.size.width===1280;};
  context.tracing.start=async()=>{assert.equal(hasVideoSize,true,'the first screencast subscriber determines all frame dimensions');};
  await audit.start(page);
  assert.equal((await audit.finish()).status,'complete');
});
