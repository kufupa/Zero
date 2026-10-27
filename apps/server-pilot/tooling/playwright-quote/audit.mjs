// Private browser audit capture. Call start only after verified authentication.
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectHmsStorageStateSecretValues, sanitizePlaywrightTraceFile } from '../../src/hms/trace-privacy.ts';
import { canWritePlaywrightTraceAtUsage, readDiskUsedPercent } from '../../src/ops/playwright-quote-purge.ts';

export async function createAudit(directory, {video=false,trace='failure',secrets=[],diskUsage=readDiskUsedPercent}={}) {
  await mkdir(directory,{recursive:true,mode:0o700});
  await chmod(directory,0o700);
  await mkdir(join(directory,'screenshots'),{mode:0o700});
  const traceMode=trace===false?'disabled':trace===true?'always':'failure';
  const secretValues=new Set(secrets.filter(Boolean));
  const started=Date.now();
  let sequence=0,page,context,tracing=false,recording=false,finished=false,runFailed=false;
  const report={status:'not_started',captureBoundary:'after_verified_login',
    trace:{status:'not_started'},video:{requested:video,status:video?'not_started':'disabled'},screenshots:[],errors:[]};
  // Optional fields (for example phaseMs) are spread first, so the fixed keys always win.
  const event=(phase,fields={})=>{
    if(!/^[a-z0-9_-]+$/.test(phase)) throw new Error('INVALID_AUDIT_PHASE');
    if(phase==='result_execution_failure'||phase==='result_partial'||phase==='checkpoint_failure') runFailed=true;
    const entry={...fields,sequence:++sequence,at:new Date().toISOString(),elapsedMs:Date.now()-started,phase};
    appendFileSync(join(directory,'events.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});
    return entry;
  };
  event('audit_created');
  const fail=(code)=>{runFailed=true;report.errors.push(code);event(code.toLowerCase());};
  const diskAdmission=async()=>{
    let usedPercent=null;
    try {usedPercent=await diskUsage();} catch { /* Refuse trace writes when disk status is unknown. */ }
    return {usedPercent,allowed:canWritePlaywrightTraceAtUsage(usedPercent)};
  };
  const artifact=async(path)=>{
    const bytes=await readFile(join(directory,path));
    if(!bytes.length) throw new Error('EMPTY_ARTIFACT');
    await chmod(join(directory,path),0o600);
    return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  };
  const collectStorage=async()=>{
    for(const value of collectHmsStorageStateSecretValues(await context.storageState())) secretValues.add(value);
  };
  // HMS puts this credential in otherwise-business request JSON. Never persist
  // the raw request; retain the value only in the trace sanitizer's scan set.
  const collectRequest=(request)=>{
    try {
      const value=request.postDataJSON()?.bookingSessionID;
      if(typeof value==='string' && value) secretValues.add(value);
    } catch { /* Non-JSON requests do not carry this HMS field. */ }
  };
  return {
    event,
    async start(ownedPage, sensitiveValues=[]) {
      if(page || finished) throw new Error('AUDIT_ALREADY_STARTED');
      page=ownedPage;context=page.context();
      for(const value of sensitiveValues.filter(Boolean)) secretValues.add(value);
      if(await page.locator('input[type="password"]:visible').count()) throw new Error('AUDIT_REQUIRES_AUTHENTICATED_PAGE');
      await collectStorage();
      page.on('request',collectRequest);
      report.startedAt=new Date().toISOString();
      if(video) {
        try {
          // Playwright 1.63 encodes received frames on the controller (VPS),
          // including when the browser itself is borrowed over remote CDP.
          await page.screencast.start({path:join(directory,'video.webm'),size:{width:1280,height:720}});
          recording=true;
        } catch {report.video.status='failed';fail('VIDEO_START_FAILED');}
      }
      if (traceMode !== 'disabled') {
        const disk = await diskAdmission();
        if (!disk.allowed) {
          report.trace.status = disk.usedPercent === null ? 'refused_disk_usage_unavailable' : 'refused_disk_limit';
        } else {
          // The first screencast subscriber fixes frame dimensions for all clients.
          // Starting trace first would downscale even a 1280px video to 800px.
          try {
            await context.tracing.start({screenshots:true,snapshots:true,sources:false});
            tracing=true;
          } catch {report.trace.status='failed';fail('TRACE_START_FAILED');throw new Error('TRACE_START_FAILED');}
        }
      } else {
        report.trace.status='disabled';
      }
      if(report.video.status==='failed') throw new Error('VIDEO_START_FAILED');
      event('capture_started');
    },
    async checkpoint(name) {
      if(!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('INVALID_CHECKPOINT_NAME');
      if(!page || finished) throw new Error('AUDIT_NOT_STARTED');
      if(await page.locator('input[type="password"]:visible').count()) {
        fail('CHECKPOINT_RETURNED_TO_LOGIN');throw new Error('CHECKPOINT_RETURNED_TO_LOGIN');
      }
      try {
        const path=`screenshots/${name}.png`;
        await page.screenshot({path:join(directory,path),fullPage:true,timeout:10000});
        report.screenshots.push(await artifact(path));
        event(`checkpoint_${name}`);
      } catch {fail('CHECKPOINT_FAILED');throw new Error('CHECKPOINT_FAILED');}
    },
    // Read-only view for a provisional capture: no trace stop, sanitize or hash yet.
    snapshot() {
      const stableTraceStatuses=['disabled','not_written_success','refused_disk_limit','refused_disk_usage_unavailable'];
      return structuredClone({...report,status:'pending',
        trace:stableTraceStatuses.includes(report.trace.status)?report.trace:{status:'pending'}});
    },
    async finish() {
      if(finished) return report;
      finished=true;
      if(recording) {
        try {await page.screencast.stop();report.video={requested:true,status:'complete',...await artifact('video.webm')};}
        catch {report.video.status='failed';fail('VIDEO_CAPTURE_FAILED');}
      }
      const rawPath=join(directory,'.trace-raw.zip');
      if(tracing) {
        const shouldWrite=traceMode==='always'||runFailed;
        if(!shouldWrite) {
          try {await context.tracing.stop();report.trace.status='not_written_success';}
          catch {report.trace.status='failed';fail('TRACE_CAPTURE_FAILED');}
        } else {
          const disk=await diskAdmission();
          if(!disk.allowed) {
            try {await context.tracing.stop();} catch {report.trace.status='failed';fail('TRACE_CAPTURE_FAILED');}
            if(report.trace.status!=='failed')
              report.trace.status=disk.usedPercent===null?'refused_disk_usage_unavailable':'refused_disk_limit';
          } else {
            try {
              await collectStorage();
              await context.tracing.stop({path:rawPath});
              await chmod(rawPath,0o600);
              const receipt=await sanitizePlaywrightTraceFile(rawPath,join(directory,'trace.zip'),[...secretValues]);
              report.trace={status:'complete',...await artifact('trace.zip'),sanitizerVersion:receipt.sanitizerVersion};
            } catch {
              report.trace.status='failed';fail('TRACE_CAPTURE_FAILED');
              await rm(join(directory,'trace.zip'),{force:true});
            } finally {
              // Delete only this invocation's known temporary raw archive.
              await rm(rawPath,{force:true});
            }
          }
        }
      }
      page?.off('request',collectRequest);
      secretValues.clear();
      report.endedAt=new Date().toISOString();
      report.status=report.errors.length?'incomplete':report.startedAt?'complete':'not_started';
      event(`capture_${report.status}`);
      return report;
    },
  };
}
