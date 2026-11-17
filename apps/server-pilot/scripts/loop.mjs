import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
delete process.env.DATABASE_URL;
delete process.env.TEST_DATABASE_URL;
delete process.env.VITEST_ALLOW_PILOT_RDS;
const [{ createAzureExtractionAdapter }, { classifyWorkflowMailTriage },
  { classifyReservationWorkflowV2Source, runReservationWorkflowV2Prefill }, { staffQuoteSourceHash },
  { canonicalSourceBodyText }, { mailSourceTriageOutput }] = await Promise.all([
  import('../src/ai/extraction/extract.ts'), import('../src/ai/workflows/mail-triage.ts'),
  import('../src/ai/reservation-workflow-v2-prefill.ts'), import('../src/ai/staff-quote-workflow.ts'),
  import('../src/ai/mail-source.ts'), import('../src/ai/triage.ts'),
]);
const exec = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
let transferBucket;
function rememberBucket(uri) {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\//.exec(uri);
  if (!match) throw Error('Invalid storage location');
  transferBucket = match[1];
}
const workflows = new Set(['quote', 'create', 'amend', 'cancel', 'filing', 'triage']);
const usage = 'Usage: pnpm --dir apps/server-pilot loop <quote|create|amend|cancel|filing|triage> [--emails N | --ids a,b,c | --since 30d] [--parallel K] [--json out.json]';
function argumentsFor(args) {
  if (args.includes('--help') || args.includes('-h')) return null;
  const [workflow, ...rest] = args;
  if (!workflows.has(workflow)) throw Error(usage);
  const options = { workflow, emails: 10, parallel: 1, json: 'loop-results.json' };
  let selection = false;
  while (rest.length) {
    const name = rest.shift(), value = rest.shift();
    if (!value || !['--emails', '--ids', '--since', '--parallel', '--json'].includes(name)) throw Error(usage);
    if (['--emails', '--ids', '--since'].includes(name)) {
      if (selection) throw Error('Choose one of --emails, --ids, or --since');
      selection = true;
    }
    if (name === '--emails' || name === '--parallel') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || (name === '--parallel' && Number(value) > 8)) throw Error(`Invalid ${name}`);
      options[name.slice(2)] = Number(value);
    } else if (name === '--ids') {
      options.ids = value.split(',').filter(Boolean);
      if (!options.ids.length || options.ids.some(id => !/^[a-z0-9-]+$/i.test(id))) throw Error('Invalid message IDs');
    } else if (name === '--since') {
      if (!/^\d+d$/.test(value) || Number(value.slice(0, -1)) < 1 || Number(value.slice(0, -1)) > 31) throw Error('Use --since with 1–31 days, e.g. 30d');
      options.since = Number(value.slice(0, -1));
    } else options.json = value;
  }
  return options;
}
const sleep = ms => new Promise(done => setTimeout(done, ms));
function errorReason(error, stage) {
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
  return message && !/password|secret|api.?key|token|bearer|authorization/i.test(message)
    ? message.slice(0, 300) : `${stage} failed${error?.name && error.name !== 'Error' ? ` (${error.name})` : ''}`;
}
const addresses = list => (list ?? []).map(value => typeof value === 'string' ? value : value?.email).filter(value => typeof value === 'string' && value.trim());
const body = row => canonicalSourceBodyText({ textBody: row.textBody, htmlBody: row.htmlBody });
const instant = row => row.eventAt ?? row.receivedAt ?? row.sentAt ?? row.createdAt;
async function lines(path, visit) {
  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of stream) if (line.trim()) visit(JSON.parse(line));
}
export async function corpus(options) {
  const live = !process.env.LOOP_CORPUS;
  const path = process.env.LOOP_CORPUS ?? await liveCorpus(options);
  const candidates = [], byThread = new Map();
  let latest = null;
  try { await lines(path, row => {
    if (!row.id || !row.threadId || row.transportId !== 'transport-centurion') return;
    if (instant(row) && (!latest || instant(row) > latest)) latest = instant(row);
    const thread = byThread.get(row.threadId) ?? [];
    thread.push(row); byThread.set(row.threadId, thread);
    if (row.businessDirection !== 'inbound') return;
    if (options.ids && !options.ids.includes(row.id)) return;
    if (options.since && (!Number.isFinite(Date.parse(instant(row))) || Date.parse(instant(row)) < Date.now() - options.since * 86_400_000)) return;
    candidates.push(row);
  }); } finally { if (live) await rm(dirname(path), { recursive: true, force: true }); }
  candidates.sort((a, b) => Date.parse(instant(b)) - Date.parse(instant(a)));
  if (options.ids) {
    const missing = options.ids.filter(id => !candidates.some(row => row.id === id));
    if (missing.length) throw Error(`Message IDs absent from corpus: ${missing.join(', ')}`);
  }
  const defaultHints = '/home/orca/.local/share/zero/orch/eval/high-merged-20261116-21da-cap6-complete-2319/checkpoints.jsonl';
  const hints = process.env.LOOP_CLASSIFICATIONS ?? (await access(defaultHints).then(() => defaultHints, () => null));
  if (!options.ids && !options.since && options.workflow !== 'triage' && hints) {
    const relevant = new Set();
    await lines(hints, row => {
      if (row.kind === 'classification' && row.result?.tasks?.some(task => task.workflow === options.workflow)) relevant.add(row.messageId);
    });
    candidates.sort((a, b) => Number(relevant.has(b.id)) - Number(relevant.has(a.id)) || Date.parse(instant(b)) - Date.parse(instant(a)));
  }
  return { path: live ? 'live Centurion corpus' : path, latest, candidates, byThread };
}
async function model(runtimeEnv) {
  const env = { ...process.env, ...runtimeEnv };
  env.EXTRACTION_REASONING_EFFORT = env.EXTRACTION_REASONING_EFFORT?.trim() || 'high';
  if (!env.AZURE_OPENAI_BASE_URL || !env.AZURE_FOUNDRY_API_KEY) {
    const { stdout } = await exec('aws', ['secretsmanager', 'get-secret-value', '--region', 'af-south-1',
      '--secret-id', 'nava-zero/server-pilot/azure-luna', '--query', 'SecretString', '--output', 'text']);
    const secret = JSON.parse(stdout);
    env.AZURE_OPENAI_BASE_URL = secret.AZURE_OPENAI_BASE_URL;
    env.AZURE_FOUNDRY_API_KEY = secret.AZURE_FOUNDRY_API_KEY;
  }
  const adapter = createAzureExtractionAdapter(env);
  if (!adapter) throw Error('Azure extraction configuration is unavailable');
  const simpleSynthesisAdapter = env.PREFILL_SIMPLE_SYNTHESIS?.trim() === 'on'
    ? createAzureExtractionAdapter({ ...env, EXTRACTION_REASONING_EFFORT: 'medium' }) : null;
  return { adapter, simpleSynthesisAdapter, env };
}
export async function sendSsm(commands, timeout = 600) {
  const params = JSON.stringify({ commands, executionTimeout: [String(timeout)] });
  const instance = process.env.LOOP_HMS_INSTANCE_ID ?? 'i-008f737974a9ba9b3';
  const base = ['--region', 'af-south-1'];
  const sent = await exec('aws', ['ssm', 'send-command', ...base, '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
    '--parameters', params, '--query', 'Command.CommandId', '--output', 'text'], { maxBuffer: 2_000_000 });
  const commandId = sent.stdout.trim();
  const deadline = Date.now() + (timeout + 60) * 1000;
  while (true) {
    if (Date.now() >= deadline) throw Error('HMS command did not complete');
    await sleep(15000);
    let result;
    try {
      const call = await exec('aws', ['ssm', 'get-command-invocation', ...base, '--command-id', commandId, '--instance-id', instance, '--output', 'json'], { maxBuffer: 2_000_000 });
      result = JSON.parse(call.stdout);
    } catch (error) {
      if (String(error?.stderr ?? '').includes('InvocationDoesNotExist')) continue;
      throw Error('Could not read HMS command status');
    }
    if (['Pending', 'InProgress', 'Delayed'].includes(result.Status)) continue;
    if (result.Status !== 'Success') throw Error(`HMS command ${result.Status}: ${(result.StandardErrorContent ?? '').slice(-500)}`);
    return result.StandardOutputContent;
  }
}
const python = source => `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(source).toString('base64')}"))'`;
async function liveCorpus(options) {
  const id = randomUUID(), remote = `/home/ubuntu/stage/private/loop-corpus-${id}`;
  const end = new Date(), start = new Date(end.getTime() - (options.since ?? 30) * 86_400_000);
  const script = `import { createThreadCorpusPostgresReader } from './src/ops/centurion-thread-corpus-postgres-reader.ts';
import { createDb } from './src/db/client.ts';
import { writeFile } from 'node:fs/promises'; import { gzipSync } from 'node:zlib'; import { execFileSync } from 'node:child_process';
const ids=${JSON.stringify(options.ids ?? [])}; let start=${JSON.stringify(start.toISOString())};
let threads=new Set();
if(ids.length){ const {conn}=createDb(process.env.DATABASE_URL); try {
 const rows=await conn.begin('isolation level repeatable read read only',sql=>sql.unsafe("select thread_id, min(least(coalesce(received_at,created_at),coalesce(sent_at,created_at),created_at)) as oldest from message where transport_id = 'transport-centurion' and thread_id in (select thread_id from message where transport_id = 'transport-centurion' and id = any($1)) group by thread_id",[ids]));
 threads=new Set(rows.map(row=>row.thread_id));
 for(const row of rows) if(row.oldest){const prior=new Date(new Date(row.oldest).getTime()-86400000).toISOString(); if(prior<start)start=prior;}
}finally{await conn.end();} }
const reader=createThreadCorpusPostgresReader({databaseUrl:process.env.DATABASE_URL,transportIds:['transport-centurion']});
try { const end=${JSON.stringify(end.toISOString())}; const selected=new Map();
while(start<end){const next=new Date(Math.min(Date.parse(end),Date.parse(start)+30*86400000)).toISOString();
 const snapshot=await reader.readCenturionSnapshot({startInclusive:start,endExclusive:next});
 for(const row of snapshot.messages) if(!ids.length||threads.has(row.threadId))selected.set(row.id,row);
 start=next; }
const rows=[...selected.values()];
const file=${JSON.stringify(remote + '/corpus.gz')}; await writeFile(file,gzipSync(Buffer.from(rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n')),{mode:0o600});
if(!process.env.S3_BUCKET)throw Error('mail_storage_unavailable'); const uri='s3://'+process.env.S3_BUCKET+'/ops-dumps/loop-corpus/${id}.gz';
execFileSync('aws',['s3','cp',file,uri,'--region','af-south-1','--sse','AES256','--only-show-errors']); console.log('LOOP_CORPUS '+uri);
} finally {await reader.close()}`;
  const launcher = `import os,json,subprocess,sys\nfrom pathlib import Path\nb='/home/ubuntu/.nvm/versions/node/v22.23.1/bin/'\np=[x['pid'] for x in json.loads(subprocess.check_output([b+'pm2','jlist'])) if x.get('name')=='http' and x.get('pm2_env',{}).get('status')=='online'][0]\ne=dict(x.decode().split('=',1) for x in Path('/proc',str(p),'environ').read_bytes().split(b'\\0') if b'=' in x)\nfor k in ['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_OPTIONS','TEST_DATABASE_URL','VITEST_ALLOW_PILOT_RDS']: e.pop(k,None)\ne['PATH']=b+':/usr/local/bin:/usr/bin:/bin'\np=subprocess.run([b+'node','--import','tsx','--input-type=module','-e',${JSON.stringify(script)}],cwd='/home/ubuntu/repos/zero/apps/server-pilot',env=e,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nprint(p.stdout,end='')\nif p.returncode:\n if e.get('S3_BUCKET'): subprocess.run(['aws','s3','rm','s3://'+e['S3_BUCKET']+'/ops-dumps/loop-corpus/${id}.gz','--region','af-south-1','--only-show-errors'],env=e,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n print(p.stderr[-1000:],file=sys.stderr);sys.exit(p.returncode)`;
  let uri, directory, remoteFinished = false;
  try {
    const output = await sendSsm([`install -d -m 700 -o ubuntu -g ubuntu ${remote}`, `sudo -u ubuntu ${python(launcher)}`], 600);
    remoteFinished = true;
    uri = output.split('\n').find(line => line.startsWith('LOOP_CORPUS '))?.slice(12);
    if (!uri?.startsWith('s3://') || !uri.endsWith(`/loop-corpus/${id}.gz`)) throw Error('Live corpus export failed');
    rememberBucket(uri);
    directory = await mkdtemp(join(tmpdir(), 'nava-loop-'));
    const compressed = join(directory, 'corpus.gz'), path = join(directory, 'messages.jsonl');
    await exec('aws', ['s3', 'cp', uri, compressed, '--region', 'af-south-1', '--only-show-errors']);
    const { gunzipSync } = await import('node:zlib');
    await writeFile(path, gunzipSync(await readFile(compressed)), { mode: 0o600 });
    return path;
  } catch (error) {
    if (error instanceof Error && /^HMS command (Failed|Cancelled|TimedOut):/.test(error.message)) remoteFinished = true;
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (uri) await exec('aws', ['s3', 'rm', uri, '--region', 'af-south-1', '--only-show-errors']).catch(() => {});
    if (remoteFinished) await sendSsm([`sudo -u ubuntu rm -rf ${remote}`], 60).catch(() => {});
  }
}
export async function runtimeConfig() {
  const id = randomUUID(), remote = `/home/ubuntu/stage/private/loop-config-${id}`;
  const script = `import fcntl,json,os,subprocess,tarfile\nfrom pathlib import Path\nb='/home/ubuntu/.nvm/versions/node/v22.23.1/bin/'\nr=Path(${JSON.stringify(remote)})\nwith open('/home/ubuntu/.nava-deploy.lock','a') as lock:\n fcntl.flock(lock,fcntl.LOCK_SH)\n p=[x['pid'] for x in json.loads(subprocess.check_output([b+'pm2','jlist'])) if x.get('name')=='http' and x.get('pm2_env',{}).get('status')=='online'][0]\n e=dict(x.decode().split('=',1) for x in Path('/proc',str(p),'environ').read_bytes().split(b'\\0') if b'=' in x)\n files={'HMS_NATIVE_CATALOG_PATH':'catalog.json','HMS_MEMORY_PMS_PATH':'pms.json','HMS_MEMORY_OUTBOUND_PATH':'outbound.jsonl','HMS_MEMORY_OBSERVATIONS_PATH':'observations.jsonl','PARTY_INDEX_PATH':'party-index.json'}\n e.setdefault('PARTY_INDEX_PATH','/home/ubuntu/repos/zero/.private/pms-pipeline/party-index/party-index.json')\n settings={k:e[k] for k in ['HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRCEN','EXTRACTION_REASONING_EFFORT','EXTRACTION_VISION','PREFILL_SIMPLE_SYNTHESIS'] if e.get(k)}\n config={'settings':settings,'files':{k:v for k,v in files.items() if e.get(k) and Path(e[k]).is_file()}}\n if 'HMS_NATIVE_CATALOG_PATH' not in config['files']: raise RuntimeError('catalog_unavailable')\n (r/'config.json').write_text(json.dumps(config))\n with tarfile.open(r/'config.tar.gz','w:gz',dereference=True) as tar:\n  tar.add(r/'config.json',arcname='config.json')\n  for k,v in config['files'].items(): tar.add(e[k],arcname=v)\n  memory=Path(e.get('HMS_MEMORY_DATA_DIR','/nonexistent'))/'HRCEN'\n  if memory.is_dir():\n   for f in memory.iterdir():\n    if f.is_file(): tar.add(f,arcname='HRCEN/'+f.name)\n if not e.get('S3_BUCKET'): raise RuntimeError('mail_storage_unavailable')\n uri='s3://'+e['S3_BUCKET']+'/ops-dumps/loop-config/${id}.tar.gz'\n subprocess.run(['aws','s3','cp',str(r/'config.tar.gz'),uri,'--region','af-south-1','--sse','AES256','--only-show-errors'],check=True)\n print('LOOP_CONFIG '+uri)`;
  let uri = transferBucket ? `s3://${transferBucket}/ops-dumps/loop-config/${id}.tar.gz` : null;
  let directory, remoteFinished = false;
  try {
    const output = await sendSsm([`install -d -m 700 -o ubuntu -g ubuntu ${remote}`, `sudo -u ubuntu ${python(script)}`], 600);
    remoteFinished = true;
    uri = output.split('\n').find(line => line.startsWith('LOOP_CONFIG '))?.slice(12);
    if (!uri?.startsWith('s3://') || !uri.endsWith(`/loop-config/${id}.tar.gz`)) throw Error('Runtime configuration export failed');
    rememberBucket(uri);
    directory = await mkdtemp(join(tmpdir(), 'nava-loop-config-'));
    const archive = join(directory, 'config.tar.gz');
    await exec('aws', ['s3', 'cp', uri, archive, '--region', 'af-south-1', '--only-show-errors']);
    await exec('tar', ['-xzf', archive, '-C', directory]);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    const env = { ...config.settings, HMS_MEMORY_DATA_DIR: directory };
    for (const [key, file] of Object.entries(config.files)) env[key] = join(directory, file);
    return { directory, env };
  } catch (error) {
    if (error instanceof Error && /^HMS command (Failed|Cancelled|TimedOut):/.test(error.message)) remoteFinished = true;
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  finally {
    if (uri) await exec('aws', ['s3', 'rm', uri, '--region', 'af-south-1', '--only-show-errors']).catch(() => {});
    if (remoteFinished) await sendSsm([`sudo -u ubuntu rm -rf ${remote}`], 60).catch(() => {});
  }
}
export async function native(payload, directory) {
  const id = randomUUID();
  const remote = `/home/ubuntu/stage/private/loop-${id}`;
  if (!transferBucket) {
    const script = `import json,subprocess\nfrom pathlib import Path\nb='/home/ubuntu/.nvm/versions/node/v22.23.1/bin/'\np=[x['pid'] for x in json.loads(subprocess.check_output([b+'pm2','jlist'])) if x.get('name')=='http' and x.get('pm2_env',{}).get('status')=='online'][0]\ne=dict(x.decode().split('=',1) for x in Path('/proc',str(p),'environ').read_bytes().split(b'\\0') if b'=' in x)\nprint('LOOP_BUCKET '+e['S3_BUCKET'])`;
    const output = await sendSsm([`sudo -u ubuntu ${python(script)}`], 60);
    const bucket = output.trim().split('\n').find(line => line.startsWith('LOOP_BUCKET '))?.slice(12);
    if (!bucket) throw Error('Mail storage unavailable');
    rememberBucket(`s3://${bucket}/`);
  }
  const runner = await readFile(join(root, 'loop-native.mjs'));
  const launcher = await readFile(join(root, 'loop-native-launch.py'));
  const pack = gzipSync(Buffer.from(JSON.stringify({ runner: runner.toString('base64'), launcher: launcher.toString('base64'), input: { ...payload, fastTransfer: true } })));
  const temp = await mkdtemp(join(tmpdir(), 'nava-loop-input-'));
  const uri = `s3://${transferBucket}/ops-dumps/loop-input/${id}.gz`;
  let remoteFinished = false, info;
  try {
  const local = join(temp, 'payload.gz');
  await writeFile(local, pack, { mode: 0o600 });
  await exec('aws', ['s3', 'cp', local, uri, '--region', 'af-south-1', '--sse', 'AES256', '--only-show-errors']);
  const install = `import base64,gzip,json,os\np=${JSON.stringify(remote)}\nx=json.loads(gzip.decompress(open(p+'/payload.gz','rb').read()))\nfor n in ('runner','launcher'):\n open(p+'/'+n+('.mjs' if n=='runner' else '.py'),'wb').write(base64.b64decode(x[n]))\nopen(p+'/input.json','w').write(json.dumps(x['input']))\nos.chmod(p+'/input.json',0o600)`;
  const output = await sendSsm([`install -d -m 700 -o ubuntu -g ubuntu ${remote}`,
    `sudo -u ubuntu aws s3 cp ${uri} ${remote}/payload.gz --region af-south-1 --only-show-errors`,
    `sudo -u ubuntu ${python(install)}`, `sudo -u ubuntu python3 ${remote}/launcher.py ${remote}`], 3600);
  remoteFinished = true;
  const marker = output.trim().split('\n').find(line => line.startsWith('LOOP_OUTPUT '));
  if (!marker) throw Error('HMS runner did not return an output');
  info = JSON.parse(marker.slice(12));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of info.files ?? []) {
    if (!(file.name === 'native.json' || /^[a-zA-Z0-9_-]+\.(?:cover\.json|quote\.pdf|quote\.xlsx)$/.test(file.name)) ||
      !Number.isSafeInteger(file.size) || file.size < 0) throw Error('Invalid HMS output file');
    if (file.uri !== `s3://${transferBucket}/ops-dumps/loop-files/loop-${id}/${file.name}`) throw Error('Invalid HMS output location');
    await exec('aws', ['s3', 'cp', file.uri, join(directory, file.name), '--region', 'af-south-1', '--only-show-errors']);
  }
  const result = JSON.parse(await readFile(join(directory, 'native.json'), 'utf8'));
  return { ...result, runtimeSha: info.runtimeSha, files: (info.files ?? []).filter(file => file.name !== 'native.json').map(file => join(directory, file.name)) };
  } catch (error) {
    if (error instanceof Error && /^HMS command Failed:.*LOOP_ERROR /s.test(error.message)) remoteFinished = true;
    throw error;
  } finally {
    if (remoteFinished) {
      await exec('aws', ['s3', 'rm', uri, '--region', 'af-south-1', '--only-show-errors']).catch(() => {});
      await exec('aws', ['s3', 'rm', `s3://${transferBucket}/ops-dumps/loop-files/loop-${id}/`, '--recursive',
        '--region', 'af-south-1', '--only-show-errors']).catch(() => {});
      await sendSsm([`sudo -u ubuntu rm -rf ${remote}`], 60).catch(() => {});
    }
    await rm(temp, { recursive: true, force: true });
  }
}
async function extractEmail(row, thread, options, adapters, outputDir) {
  const timings = {}, started = performance.now();
  const source = { propertyId: 'HRCEN', threadId: row.threadId, messageId: row.id,
    sourceHash: staffQuoteSourceHash({ id: row.id, subject: row.subject ?? null, textBody: row.textBody ?? null, htmlBody: row.htmlBody ?? null }),
    arrivedAt: row.receivedAt ?? instant(row) };
  const result = { id: row.id, subject: row.subject, source: { from: addresses(row.from), receivedAt: source.arrivedAt,
    body: body(row), attachments: row.attachmentDescriptors ?? [] }, startedAt: new Date().toISOString(),
    timings, status: 'FAIL', reason: '', hms: null, extracted: null };
  let stageName = 'source', at = performance.now();
  try {
    const sourceDir = join(outputDir, row.id, 'source');
    let loaded;
    try { loaded = await native({ selectionOnly: true, workflow: options.workflow, propertyCode: 'HRCEN',
      transport: { id: 'transport-centurion' }, source, messages: thread }, sourceDir); }
    finally { await rm(sourceDir, { recursive: true, force: true }); }
    const restore = value => {
      if (Array.isArray(value)) return value.map(restore);
      if (value && typeof value === 'object') return typeof value.loopBytes === 'string' ?
        new Uint8Array(Buffer.from(value.loopBytes, 'base64')) : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restore(entry)]));
      return value;
    };
    const selected = restore(loaded.selection);
    Object.assign(source, loaded.source);
    result.source.body = selected.bodyText;
    result.source.from = selected.fromAddress ? [selected.fromAddress] : [];
    result.source.attachments = loaded.attachmentSnapshot.filter(file => file.messageId === row.id);
    result.source.arrivedAt = source.arrivedAt;
    timings.source = (performance.now() - at) / 1000;
    stageName = 'triage'; at = performance.now();
    const gate = classifyReservationWorkflowV2Source({ fromAddress: selected.fromAddress, subject: selected.subject,
      bodyText: selected.bodyText, mailboxAddress: loaded.mailboxAddress,
      hasAttachments: loaded.hasPersistedNonInlineAttachment || selected.attachments.some(item => !item.isInline)
        ? true : loaded.attachmentEvidenceUnknown ? undefined : false });
    if (gate.skippedReason) {
      result.triage = { output: mailSourceTriageOutput(gate.classification), skippedReason: gate.skippedReason };
      timings.triage = (performance.now() - at) / 1000;
      result.status = options.workflow === 'triage' ? 'PASS' : 'NEEDS-STAFF';
      result.reason = `Source excluded: ${gate.skippedReason}`;
      return { result };
    }
    if (thread.some(item => !item.createdAt || !Number.isFinite(Date.parse(item.createdAt)))) throw Error('Triage message creation time unavailable');
    const triageMessages = thread.map(item => ({
      id: item.id, from: addresses(item.from)[0] ?? '', subject: item.subject ?? '', body: body(item),
      direction: item.businessDirection === 'outbound' ? 'outbound' : 'inbound', createdAt: new Date(item.createdAt),
      receivedAt: item.receivedAt ? new Date(item.receivedAt) : null, sentAt: item.sentAt ? new Date(item.sentAt) : null,
      to: addresses(item.to), cc: addresses(item.cc), bcc: addresses(item.bcc),
      messageIdHeader: item.messageId ?? null, inReplyTo: item.inReplyTo ?? null, references: item.references ?? [],
    }));
    try {
      result.triage = await classifyWorkflowMailTriage({ transportId: 'transport-centurion', threadId: row.threadId,
        triggerMessageId: row.id, mailboxAddress: loaded.mailboxAddress, subject: selected.subject,
        from: selected.fromAddress, body: selected.bodyText, messages: triageMessages, asOf: source.arrivedAt,
        modelId: 'gpt-6-luna', promptVersion: 'triage-v6' }, adapters.adapter);
    } catch (error) {
      if (options.workflow === 'triage') throw error;
      result.triage = { error: errorReason(error, 'triage') };
    }
    timings.triage = (performance.now() - at) / 1000;
    if (options.workflow === 'triage') {
      const classification = result.triage.output;
      result.status = classification.abstainReason || classification.humanAction === 'review_required' || classification.automationState === 'unknown'
        ? 'NEEDS-STAFF' : 'PASS';
      result.reason = classification.abstainReason ?? (result.status === 'NEEDS-STAFF' ? 'Triage requires staff review' : '');
      return { result };
    }
    stageName = 'extraction'; at = performance.now();
    const prefillLookups = [];
    const readCandidate = async candidate => {
      const directory = join(outputDir, row.id, 'candidate-' + randomUUID());
      try {
        const read = await native({ workflow: options.workflow, propertyCode: 'HRCEN',
          transport: { id: 'transport-centurion' }, source, messages: thread, candidate, participants: selected.participants,
          attachmentSnapshot: loaded.attachmentSnapshot }, directory);
        prefillLookups.push(...read.stages);
        return read.candidate;
      } finally { await rm(directory, { recursive: true, force: true }); }
    };
    const prefill = await runReservationWorkflowV2Prefill({ adapter: adapters.adapter, simpleSynthesisAdapter: adapters.simpleSynthesisAdapter,
      transportId: 'transport-centurion',
      propertyCode: 'HRCEN', source, selection: selected, mailboxAddress: loaded.mailboxAddress, env: adapters.env,
      attachmentEvidenceUnknown: loaded.attachmentEvidenceUnknown, contextAttachmentEvidenceUnknown: loaded.contextAttachmentEvidenceUnknown,
      hasPersistedNonInlineAttachment: loaded.hasPersistedNonInlineAttachment, currentAttachmentGaps: loaded.currentAttachmentGaps,
      contextAttachmentGaps: loaded.contextAttachmentGaps, readCandidate, signal: AbortSignal.timeout(1800000) });
    timings.extraction = (performance.now() - at) / 1000;
    result.extracted = { ...prefill, lookups: prefillLookups };
    if (!prefill.proposal.content.requests.some(request => request.kind === options.workflow)) {
      const failure = prefill.errors.find(error => error.stage === 'extract' && !error.code.startsWith('guard_'));
      result.status = failure || result.triage?.error ? 'FAIL' : 'NEEDS-STAFF';
      result.reason = failure?.message ?? result.triage?.error ?? `No ${options.workflow} request extracted`; return { result };
    }
    return { result, source, prefill, thread, attachmentSnapshot: loaded.attachmentSnapshot };
  } catch (error) {
    timings[stageName] = (performance.now() - at) / 1000;
    result.reason = errorReason(error, stageName);
  }
  finally { timings.total = (performance.now() - started) / 1000; }
  return { result };
}
async function prepareEmail(entry, options, outputDir) {
  const { result, source, prefill, thread, attachmentSnapshot } = entry;
  if (!prefill) return;
  const at = performance.now();
  try {
    const transport = { id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', ownerHeaderValue: 'centurion@legacyhotels.co.za' };
    result.hms = await native({ workflow: options.workflow, propertyCode: 'HRCEN', transport, source, messages: thread, prefill,
      attachmentSnapshot }, join(outputDir, result.id));
    const stages = result.hms.stages;
    const prepared = stages.filter(stage => stage.name === 'prepare');
    const artifacts = stages.filter(stage => stage.name === 'artifacts');
    const failed = stages.find(stage => ['failed', 'partial'].includes(stage.result?.status) || stage.result?.quotes?.some(quote => quote.status === 'failed'));
    const failedLookup = stages.flatMap(stage => stage.result?.lookups ?? []).find(lookup =>
      lookup.status === 'failed' || lookup.outcome === 'execution_failure' || /(?:_failed|_error)$/.test(lookup.issue ?? ''));
    const triageNeedsStaff = result.triage?.output?.abstainReason || result.triage?.output?.humanAction === 'review_required' || result.triage?.output?.automationState === 'unknown';
    const incomplete = stages.find(stage => !['ok', 'priced', 'prepared', 'succeeded'].includes(stage.result?.status));
    const complete = prepared.length > 0 && prepared.every(stage => stage.result?.status === 'prepared') &&
      (options.workflow !== 'quote' || artifacts.length === prepared.length && artifacts.every(stage => stage.result?.status === 'succeeded'));
    const files = new Set(result.hms.files.map(path => path.split('/').at(-1)));
    const hasArtifacts = options.workflow !== 'quote' || artifacts.every(stage =>
      (stage.result?.unavailableInventory ? ['cover.json'] : ['cover.json', 'quote.pdf', 'quote.xlsx'])
        .every(file => files.has(`${stage.requestId}.${file}`)));
    const simulated = result.hms.assumptions?.length > 0;
    result.status = failed || failedLookup || complete && !hasArtifacts || result.triage?.error ? 'FAIL' : complete && prefill.status === 'ready' && !prefill.errors.length && !triageNeedsStaff && !simulated ? 'PASS' : 'NEEDS-STAFF';
    result.reason = failed?.result?.issue ?? failed?.result?.quotes?.find(quote => quote.status === 'failed')?.issue ??
      (failed?.result?.failures?.join('; ') || undefined) ??
      (failedLookup ? failedLookup.issue ?? failedLookup.outcome ?? 'Native lookup failed' : undefined) ??
      result.triage?.error ??
      (complete && !hasArtifacts ? 'Cover email, PDF or XLSX unavailable' : undefined) ??
      (complete ? prefill.errors.map(error => error.message).join('; ') || (triageNeedsStaff ? 'Triage requires staff review' : simulated ? 'Illustrative replay choices require staff review' : prefill.status === 'ready' ? '' : 'Prefill needs review') :
        incomplete?.result?.issue ?? 'Staff selection or review required');
    if (incomplete?.result?.fields?.length) result.reason += `: ${incomplete.result.fields.join(', ')}`;
    if (result.status === 'PASS' && artifacts.some(stage => stage.result?.unavailableInventory)) result.reason = 'HMS unavailable; unsent decline prepared';
    if (!hasArtifacts) result.reason ||= 'Cover email, PDF or XLSX unavailable';
  } catch (error) { result.reason = error instanceof Error ? error.message : 'Unknown error'; }
  finally { result.timings.hms = (performance.now() - at) / 1000; result.timings.total += result.timings.hms; }
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!options) { console.log(usage); return; }
  const productSha = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const dataset = await corpus(options);
  const runtime = options.workflow === 'triage' ? { env: {}, directory: null } : await runtimeConfig();
  try {
  const adapters = await model(runtime.env);
  const output = resolve(options.json), outputDir = `${output}.artifacts`;
  const rows = options.ids || options.since ? dataset.candidates : dataset.candidates.slice(0, options.emails);
  const entries = Array.from({ length: rows.length });
  let index = 0, completed = 0, lastSaved = 0, saving = Promise.resolve();
  await mkdir(dirname(output), { recursive: true });
  const saveProgress = () => {
    lastSaved = Date.now();
    const results = entries.filter(entry => entry?.result?.observedAt).map(entry => entry.result);
    const document = { workflow: options.workflow, productSha, generatedAt: new Date().toISOString(),
      corpus: dataset.path, corpusLatest: dataset.latest, totalRows: rows.length, complete: results.length === rows.length, rows: results };
    saving = saving.then(async () => {
      const temp = `${output}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(document, null, 2), { mode: 0o600 }); await rename(temp, output); }
      finally { await rm(temp, { force: true }); }
    });
    return saving;
  };
  await saveProgress();
  await Promise.all(Array.from({ length: Math.min(options.parallel, rows.length) }, async () => {
    while (index < rows.length) {
      const i = index++, row = rows[i];
      entries[i] = await extractEmail(row, dataset.byThread.get(row.threadId), options, adapters, outputDir);
      console.error(`Extracted ${i + 1}/${rows.length}: ${row.id}`);
      await prepareEmail(entries[i], options, outputDir);
      entries[i].result.observedAt = new Date().toISOString();
      completed++;
      if (completed === 1 || rows.length <= 200 || Date.now() - lastSaved >= 5000) await saveProgress();
      console.error(`Prepared ${i + 1}/${rows.length}: ${rows[i].id} ${entries[i].result.status}`);
    }
  }));
  const results = entries.map(entry => entry.result);
  await saveProgress();
  const brief = (value, limit = 180) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit);
  const claims = row => {
    const found = [];
    const visit = (value, path) => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== 'object') return;
      if ('raw' in value && 'value' in value) { found.push({ path, raw: value.raw, value: value.value }); return; }
      for (const [key, child] of Object.entries(value)) if (key !== 'sourceRefs' && key !== 'id') visit(child, path ? `${path}.${key}` : key);
    };
    visit(row.extracted?.extraction?.requests ?? [], '');
    return found;
  };
  const hmsSummary = row => (row.hms?.stages ?? []).map(stage => {
    const result = stage.result, detail = result?.quotes?.[0] ?? result?.lookups?.find(row => row.issue || row.status === 'ready') ?? result, quote = detail?.quote;
    const price = quote?.totalMinor != null ? ` ${quote.currency ?? ''} ${(quote.totalMinor / 100).toFixed(2)}` :
      result?.ratePlanAvailability ? ` ${JSON.stringify(result.ratePlanAvailability)}` : result?.price ? ` ${JSON.stringify(result.price)}` : '';
    const fee = detail?.feeState ? ` fee:${detail.feeState}${detail.penaltyText ? ` ${detail.penaltyText}` : ''}` : '';
    const document = detail?.documentName ? ` ${detail.documentName}${detail.target?.confirmation ? ` ${detail.target.confirmation}` : ''}` : '';
    return `${stage.name}:${detail?.status ?? 'unknown'}${detail?.issue ? ` (${detail.issue})` : ''}${price}${fee}${document}`;
  }).join('; ');
  console.table(results.map(row => {
    const fields = claims(row);
    return { id: row.id, subject: brief(row.subject, 65),
    extracted: brief(fields.length ? JSON.stringify(fields.map(({ path, value }) => [path, value])) : JSON.stringify(row.triage?.output ?? []), 600),
    source: brief(fields.length ? JSON.stringify(fields.map(({ path, raw }) => [path, raw])) : row.source.body, 600),
    choices: brief(JSON.stringify(row.hms?.assumptions ?? []), 600),
    hms: brief(hmsSummary(row)), status: row.status, reason: brief(row.reason),
    seconds: JSON.stringify({ ...row.timings, native: row.hms?.stages?.map(stage => [stage.name, stage.seconds]) ?? [] }) };
  }));
  console.log(`Corpus latest: ${dataset.latest}; JSON: ${output}`);
  if (results.some(row => row.status === 'FAIL')) process.exitCode = 1;
  } finally { if (runtime.directory) await rm(runtime.directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'loop failed'); process.exitCode = 1; });
}
