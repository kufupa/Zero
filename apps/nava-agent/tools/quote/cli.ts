import { readFile } from 'node:fs/promises';
import { quote } from './index.js';

// Input is a private JSON file derived from a real selected message. Never print it or raw capture.
async function main() {
  const path=process.argv[2];
  if(!path || process.argv.length!==3) {process.stderr.write('Usage: tsx apps/nava-agent/tools/quote/cli.ts PRIVATE_REQUEST.json\n');process.exitCode=2;return;}
  let input:unknown;
  try {input=JSON.parse(await readFile(path,'utf8'));} catch {process.stderr.write('Unable to read request JSON.\n');process.exitCode=2;return;}
  const result=await quote(input,{sessionId:'direct-cli',mode:'live'});
  const data=result.data;
  if(!data || typeof data!=='object' || !('searches' in data) || !Array.isArray(data.searches)) {
    process.stdout.write(JSON.stringify({ok:result.ok,error:result.error})+'\n');
  } else {
    const captures=data.searches.map((entry:unknown)=>{
      if(!entry || typeof entry!=='object' || !('native_result' in entry) || !entry.native_result || typeof entry.native_result!=='object') return {outcome:'unknown'};
      const native=entry.native_result;
      const outcome='outcome' in native ? native.outcome : null;
      const audit='audit' in native && native.audit && typeof native.audit==='object' && 'status' in native.audit ? native.audit.status : null;
      return {outcome,audit};
    });
    const rows='display_rows' in data && Array.isArray(data.display_rows) ? data.display_rows : [];
    process.stdout.write(JSON.stringify({ok:result.ok,error:result.error,captures,nightly_price_rows:rows.filter((row:unknown)=>row && typeof row==='object' && 'kind' in row && row.kind==='money' && 'unit' in row && row.unit==='night').length})+'\n');
  }
  if(!result.ok) process.exitCode=1;
}
void main();
