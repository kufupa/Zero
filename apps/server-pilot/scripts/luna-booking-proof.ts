/**
 * U9 live booking proofs. VPS-only, DB-free. Writes gitignored .private/luna-mvp/proofs/.
 * Stdout: ids, outcomes, codes. No names, bodies, or addresses.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { analyseQuoteSelection } from '../src/ai/quote-workflow-llm.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import { createAzureLunaModel, LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { requestFromQuotedRoom } from '../src/ai/booking-draft.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TOOLING = path.join(REPO_ROOT, 'apps/server-pilot/tooling/playwright-quote');
const CENSUS_ROWS = path.join(REPO_ROOT, '.private/luna-mvp/census/rows.jsonl');
const CORPUS_A = path.join(REPO_ROOT, '../centurion-dashboard-tools/.private/reservationist-backtest/corpus/messages.jsonl');
const PROOF_ROOT = path.join(REPO_ROOT, '.private/luna-mvp/proofs');
const CREATE_PROOF = path.join(REPO_ROOT, '.private/create-screen/proof');
const PARTY_OUT_ROOT = path.join(REPO_ROOT, '.private/pms-pipeline/party-lookup/out');
const QUOTE_OUT_ROOT = path.join(REPO_ROOT, '.private/playwright-quote');

/** U4 mining is all-null. Lab-only labelled defaults for schema-valid stop-before fills. */
const LAB_DEFAULTS = {
  track: 'BAR',
  sourceOfBusiness: 'Travel Agent',
  guaranteeType: 'Guaranteed By Agent',
} as const;

type CensusRow = {
  id: string;
  corpus: 'A' | 'B';
  analysis?: LunaAnalysis;
};

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as T);
  }
  return rows;
}

function parseIds(argv: string[]): string[] {
  const idx = argv.indexOf('--ids');
  const raw = idx >= 0 ? argv[idx + 1] : '';
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function runNode(script: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: {
        ...process.env,
        HMS_STAGEHAND_CDP_URL: process.env.HMS_STAGEHAND_CDP_URL ?? 'http://127.0.0.1:19223',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
        HMS_READ_SECRET_ARN: process.env.HMS_READ_SECRET_ARN ?? 'nava-zero/server-pilot/infor-hms-read',
        AWS_REGION: process.env.AWS_REGION ?? 'af-south-1',
        LAB_CANCEL_CONFIRMATION: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 2, stdout, stderr }));
  });
}

async function loadSelection(id: string): Promise<SyncedQuoteSelection | null> {
  try {
    const rows = await readJsonl<{
      id: string;
      subject?: string | null;
      textBody?: string | null;
      htmlBody?: string | null;
    }>(CORPUS_A);
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    const text = (row.textBody ?? '').trim();
    return {
      subject: row.subject ?? '',
      bodyText: text,
      preceding: [],
      attachments: [],
    };
  } catch {
    return null;
  }
}

async function latestResultJson(root: string): Promise<string | null> {
  const found: Array<{ path: string; mtime: number }> = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'result.json') {
        found.push({ path: full, mtime: (await stat(full)).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path ?? null;
}

async function copyProofArtifacts(dest: string): Promise<string[]> {
  const copied: string[] = [];
  for (const name of ['filled.png', 'result.json', 'observe.json']) {
    const src = path.join(CREATE_PROOF, name);
    try {
      await copyFile(src, path.join(dest, name));
      copied.push(name);
    } catch {
      // optional observe.json
    }
  }
  return copied;
}

async function proveOne(row: CensusRow): Promise<Record<string, unknown>> {
  const dest = path.join(PROOF_ROOT, row.id);
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const summary: Record<string, unknown> = {
    id: row.id,
    corpus: row.corpus,
    date_shifted: false,
    lab_defaults: 'lab_labelled_defaults',
  };

  const selection = await loadSelection(row.id);
  let analysis = row.analysis;
  if (selection && process.env.AZURE_FOUNDRY_API_KEY && process.env.AZURE_OPENAI_BASE_URL) {
    const adapter = new LunaModelAdapter({
      model: createAzureLunaModel(),
      reasoningEffort: 'medium',
      routeId: 'azure_quote',
      modelId: 'gpt-6-luna',
      protocol: 'azure-openai-responses',
    });
    const started = Date.now();
    const result = await analyseQuoteSelection({ selection, adapter, enabled: true });
    summary.luna_source = result.source;
    summary.luna_ms = Date.now() - started;
    if (result.source === 'luna' && result.analysis) analysis = result.analysis;
  } else {
    summary.luna_source = 'census_reuse';
  }
  if (!analysis) {
    summary.outcome = 'no_analysis';
    await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  }
  summary.workflow = analysis.workflow;
  const group = analysis.groups[0];
  const arrival = group?.arrival;
  const departure = group?.departure;
  if (!arrival || !departure) {
    summary.outcome = 'missing_dates';
    await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  }
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() + 3);
  const arrivalDate = new Date(`${arrival}T00:00:00Z`);
  const departureDate = new Date(`${departure}T00:00:00Z`);
  let proofArrival = arrival;
  let proofDeparture = departure;
  if (arrivalDate < cutoff) {
    const years = 2027 - arrivalDate.getUTCFullYear();
    const shiftedArrival = new Date(arrivalDate);
    shiftedArrival.setUTCFullYear(arrivalDate.getUTCFullYear() + years);
    const shiftedDeparture = new Date(departureDate);
    shiftedDeparture.setUTCFullYear(departureDate.getUTCFullYear() + years);
    proofArrival = shiftedArrival.toISOString().slice(0, 10);
    proofDeparture = shiftedDeparture.toISOString().slice(0, 10);
    summary.date_shifted = true;
    summary.shifted_arrival = proofArrival;
    summary.shifted_departure = proofDeparture;
  }

  const party = analysis.party;
  const kind = party.kind === 'agency' ? 'bookingAgency' : party.kind === 'organization' || party.kind === 'government' ? 'organization' : null;
  summary.party_kind = party.kind;
  if (!kind || !party.name) {
    summary.outcome = 'no_party';
    await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  }
  const lookupReq = path.join(dest, 'party-request.json');
  await writeFile(
    lookupReq,
    JSON.stringify(
      kind === 'bookingAgency'
        ? { kind: 'bookingAgency', query: { bookingAgencyName: party.name } }
        : { kind: 'organization', query: { organizationName: party.name } },
    ),
    { mode: 0o600 },
  );
  const lookupOut = path.join(PARTY_OUT_ROOT, `luna-mvp-${row.id.slice(0, 8)}`);
  await mkdir(lookupOut, { recursive: true, mode: 0o700 });
  const lookup = await runNode(
    path.join(TOOLING, 'party-lookup.mjs'),
    ['--request', lookupReq, '--output', lookupOut],
    TOOLING,
  );
  let lookupResult: {
    outcome?: string;
    candidates?: Array<{ nativeId?: string; displayName?: string }>;
  } = {};
  try {
    lookupResult = JSON.parse(lookup.stdout.trim().split('\n').at(-1) ?? '{}') as typeof lookupResult;
  } catch {
    lookupResult = { outcome: 'parse_error' };
  }
  summary.party_outcome = lookupResult.outcome;
  if (lookupResult.outcome !== 'resolved' || !lookupResult.candidates?.[0]?.nativeId) {
    summary.outcome = 'party_unresolved';
    await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  }
  const nativeId = String(lookupResult.candidates[0].nativeId);
  const displayName = lookupResult.candidates[0].displayName?.trim();
  summary.party_native_id = nativeId;
  // Agency picker has no ID filter: schema requires nativeId + HMS displayName.
  const contextRef = displayName ? { nativeId, name: displayName } : { nativeId };

  const quoteReq = path.join(dest, 'quote-request.json');
  await writeFile(
    quoteReq,
    JSON.stringify({
      schemaVersion: 2,
      propertyCode: 'HRCEN',
      arrivalDate: proofArrival,
      departureDate: proofDeparture,
      rooms: [
        {
          id: 'group-1',
          quantity: group?.rooms ?? 1,
          adults: group?.adultsPerRoom ?? 1,
          children: 0,
          childAges: [],
        },
      ],
      rateContext:
        kind === 'bookingAgency' ? { agency: contextRef } : { organization: contextRef },
      search: { includeRestricted: false, includeAlternatives: true },
    }),
    { mode: 0o600 },
  );
  const quoteOut = path.join(QUOTE_OUT_ROOT, `luna-mvp-${row.id.slice(0, 8)}-${Date.now()}`);
  await mkdir(quoteOut, { recursive: true, mode: 0o700 });
  const quoteStarted = Date.now();
  const quoted = await runNode(
    path.join(TOOLING, 'fetch-quote.mjs'),
    ['--request', quoteReq, '--output', quoteOut],
    TOOLING,
  );
  summary.quote_exit = quoted.code;
  type QuoteOption = {
    room?: { code?: string };
    rate?: { code?: string };
    roomCode?: string;
    rateCode?: string;
  };
  let quoteJson: { outcome?: string; groups?: Array<{ options?: QuoteOption[] }> } = {};
  const latestQuote = quoted.code === 0 ? await latestResultJson(quoteOut) : null;
  if (latestQuote) {
    const quoteStat = await stat(latestQuote);
    if (quoteStat.mtimeMs >= quoteStarted - 1000) {
      quoteJson = JSON.parse(await readFile(latestQuote, 'utf8')) as typeof quoteJson;
      await copyFile(latestQuote, path.join(dest, 'quote-result.json'));
    }
  }
  summary.quote_outcome = quoteJson.outcome;
  const option = quoteJson.groups?.[0]?.options?.find((row) => {
    const room = row.room?.code ?? row.roomCode;
    const rate = row.rate?.code ?? row.rateCode;
    return Boolean(room && rate);
  });
  const roomCode = option?.room?.code ?? option?.roomCode;
  const rateCode = option?.rate?.code ?? option?.rateCode;
  if (!option || !roomCode || !rateCode) {
    summary.outcome = 'no_quote_option';
    await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  }
  summary.room_code = roomCode;
  summary.rate_code = rateCode;

  const guestName = analysis.groups[0]?.guestNames?.[0] ?? null;
  const built = requestFromQuotedRoom({
    arrival: proofArrival,
    departure: proofDeparture,
    adults: group?.adultsPerRoom ?? 1,
    childAges: group?.childAges ?? [],
    roomCode,
    rateCode,
    party: party.kind === 'agency' ? { kind: 'agency', name: party.name } : { kind: 'organization', name: party.name },
    guestName,
    defaults: { ...LAB_DEFAULTS },
    roomIndex: 1,
  });
  const request = {
    ...built.request,
    firstName: typeof built.request.firstName === 'string' ? built.request.firstName : 'Lab',
    lastName: typeof built.request.lastName === 'string' ? built.request.lastName : 'Proof',
  };
  const requestPath = path.join(dest, 'request.json');
  await writeFile(requestPath, JSON.stringify(request, null, 2), { mode: 0o600 });

  const createStarted = Date.now();
  const created = await runNode(
    path.join(TOOLING, 'create-lab-stay.mjs'),
    ['--request', requestPath, '--stop-before', 'availability'],
    TOOLING,
  );
  summary.create_exit = created.code;
  summary.create_stdout = created.stdout.trim().split('\n').at(-1) ?? '';
  const createOk = (summary.create_stdout as string).includes('stopped_before_availability');
  let copied: string[] = [];
  if (createOk) {
    const createResultPath = path.join(CREATE_PROOF, 'result.json');
    try {
      const createStat = await stat(createResultPath);
      if (createStat.mtimeMs >= createStarted - 1000) {
        copied = await copyProofArtifacts(dest);
      }
    } catch {
      copied = [];
    }
  }
  summary.copied = copied;
  try {
    const createResult = JSON.parse(await readFile(path.join(dest, 'result.json'), 'utf8')) as {
      outcome?: string;
      blankRequired?: string[];
    };
    summary.create_outcome = createResult.outcome;
    summary.blankRequired = createResult.blankRequired ?? [];
  } catch {
    summary.create_outcome = createOk ? 'missing_result' : 'create_failed';
  }
  summary.outcome = createOk ? (summary.create_outcome ?? 'stopped_before_availability') : 'create_failed';
  await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}

async function main() {
  const ids = parseIds(process.argv.slice(2));
  if (!ids.length) {
    process.stderr.write('Usage: luna-booking-proof.ts --ids <id,id>\n');
    process.exitCode = 2;
    return;
  }
  const rows = await readJsonl<CensusRow>(CENSUS_ROWS);
  const wanted = ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is CensusRow => Boolean(row));
  if (wanted.length !== ids.length) {
    process.stderr.write('census_id_missing\n');
    process.exitCode = 2;
    return;
  }
  await mkdir(PROOF_ROOT, { recursive: true, mode: 0o700 });
  for (const row of wanted) {
    const summary = await proveOne(row);
    process.stdout.write(
      `${summary.id} outcome=${summary.outcome} party=${summary.party_outcome ?? ''} room=${summary.room_code ?? ''} rate=${summary.rate_code ?? ''} blank=${JSON.stringify(summary.blankRequired ?? [])}\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'proof_failed'}\n`);
  process.exitCode = 2;
});
