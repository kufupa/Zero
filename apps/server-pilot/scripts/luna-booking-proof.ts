/**
 * U9 live booking proofs. VPS-only, scoped Cloud credential lease. Writes gitignored .private/luna-mvp/proofs/.
 * Stdout: ids, outcomes, codes. No names, bodies, or addresses.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { analyseQuoteSelection } from '../src/ai/quote-workflow-llm.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import { createAzureLunaModel, LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { requestFromQuotedRoom } from '../src/ai/booking-draft.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import { resolvePropertyScope, propertySwitchSchema } from '../src/hms/property-registry.js';
import { fetchQuote } from '../tooling/hms-cloud/fetch-quote.mjs';
import { mapPaneStayToCloudCreateInput } from '../src/ai/pane-create-cloud-input.js';
import type { PaneStay } from '../src/ai/pane-stay-save.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const CENSUS_ROWS = path.join(REPO_ROOT, '.private/luna-mvp/census/rows.jsonl');
const CORPUS_A = path.join(REPO_ROOT, '../centurion-dashboard-tools/.private/reservationist-backtest/corpus/messages.jsonl');
const PROOF_ROOT = path.join(REPO_ROOT, '.private/luna-mvp/proofs');
const PARTY_OUT_ROOT = path.join(REPO_ROOT, '.private/hms-cloud/luna-parties');
const QUOTE_OUT_ROOT = path.join(REPO_ROOT, '.private/hms-cloud/luna-quotes');

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

async function proveOne(row: CensusRow, scope: { propertyCode: string; transportId: string }): Promise<Record<string, unknown>> {
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
        ? { ...scope, kind: 'bookingAgency', query: { bookingAgencyName: party.name } }
        : { ...scope, kind: 'organization', query: { organizationName: party.name } },
    ),
    { mode: 0o600 },
  );
  const lookupOut = path.join(PARTY_OUT_ROOT, `luna-mvp-${row.id.slice(0, 8)}`);
  await mkdir(lookupOut, { recursive: true, mode: 0o700 });
  const partyNative = await import('../tooling/hms-cloud/party-lookup.mjs' as string) as {
    lookupParty(options: { requestPath: string; outputDir: string; transportId: string }): Promise<{
      outcome?: string; candidates?: Array<{ nativeId?: string; displayName?: string }>;
    }>;
  };
  const lookupResult = await partyNative.lookupParty({ requestPath: lookupReq, outputDir: lookupOut, transportId: scope.transportId });
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
      propertyCode: scope.propertyCode,
      arrivalDate: proofArrival,
      departureDate: proofDeparture,
      rooms: [
        {
          id: 'group-1',
          quantity: group?.rooms ?? 1,
          adults: group?.adultsPerRoom ?? 1,
          children: (group?.childAges ?? []).length,
          childAges: group?.childAges ?? [],
        },
      ],
      rateContext:
        kind === 'bookingAgency' ? { bookingAgency: contextRef } : { organization: contextRef },
      search: { includeRestricted: false, includeAlternatives: true },
    }),
    { mode: 0o600 },
  );
  const quoteOut = path.join(QUOTE_OUT_ROOT, `luna-mvp-${row.id.slice(0, 8)}-${Date.now()}`);
  await mkdir(quoteOut, { recursive: true, mode: 0o700 });
  const quoteCapture = await fetchQuote({ requestPath: quoteReq, ...scope, outputDir: quoteOut });
  type QuoteOption = { room?: { code?: string }; rate?: { code?: string }; roomCode?: string; rateCode?: string };
  const quoteJson = JSON.parse(await readFile(path.join(quoteCapture.evidenceDirectory, 'result.json'), 'utf8')) as {
    outcome?: string; propertyCode?: string; audit?: { status?: string }; groups?: Array<{ options?: QuoteOption[] }>;
  };
  if (quoteJson.propertyCode !== scope.propertyCode || quoteJson.audit?.status !== 'complete') throw new Error('quote_capture_incomplete');
  await copyFile(path.join(quoteCapture.evidenceDirectory, 'result.json'), path.join(dest, 'quote-result.json'));
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
    party: party.kind === 'agency' ? { kind: 'bookingAgency', name: party.name } : { kind: 'organization', name: party.name },
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

  const preparedStay = { ...request, propertyCode: scope.propertyCode, childAges: group?.childAges ?? [],
    reservationNote: `Unsaved proof for census ${row.id}`, confirmationSendMail: false,
    ...(kind === 'bookingAgency' ? { bookingAgency: { nativeId, name: displayName ?? party.name } } : { organization: { nativeId, name: displayName ?? party.name } }),
  } as PaneStay;
  const mapped = mapPaneStayToCloudCreateInput(preparedStay, 'prepare', undefined, { allowRealGuest: true });
  if (mapped.outcome !== 'ok') {
    summary.outcome = 'create_input_gap'; summary.create_issue = mapped.reason;
  } else {
    const native = await import('../tooling/hms-cloud/create-reservation.mjs' as string) as {
      createReservation(input: Record<string, unknown>, options: { transportId: string; allowRealGuest: boolean; expectedGuest: { firstName: string; lastName: string }; capturePrepareScreenshot: boolean }): Promise<{ outcome: string; issue?: string; missing?: unknown[]; screenshots?: Record<string, string> }>;
    };
    const prepared = await native.createReservation(mapped.input, { transportId: scope.transportId, allowRealGuest: true,
      expectedGuest: { firstName: preparedStay.firstName, lastName: preparedStay.lastName }, capturePrepareScreenshot: true });
    await writeFile(path.join(dest, 'result.json'), JSON.stringify(prepared, null, 2), { mode: 0o600 });
    summary.create_outcome = prepared.outcome; summary.create_issue = prepared.issue; summary.blankRequired = prepared.missing ?? [];
    const filled = prepared.screenshots?.filled;
    if (filled) await copyFile(filled, path.join(dest, 'filled.png'));
    summary.outcome = prepared.outcome;
  }
  await writeFile(path.join(dest, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  const propertyCode = argv[argv.indexOf('--property') + 1];
  const transportId = argv[argv.indexOf('--transport') + 1];
  if (!argv.includes('--property') || !argv.includes('--transport')) throw new Error('explicit_property_and_transport_required');
  const selected = resolvePropertyScope({ transportId, ...(propertyCode === 'HRCEN' ? {} : { propertySwitch: propertySwitchSchema.parse(propertyCode) }) });
  if (selected.propertyCode !== propertyCode) throw new Error('property_transport_mismatch');
  const scope = { propertyCode: selected.propertyCode, transportId };
  const ids = parseIds(argv);
  if (!ids.length) {
    process.stderr.write('Usage: luna-booking-proof.ts --property <code> --transport <id> --ids <id,id>\n');
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
    const summary = await proveOne(row, scope);
    process.stdout.write(
      `${summary.id} outcome=${summary.outcome} party=${summary.party_outcome ?? ''} room=${summary.room_code ?? ''} rate=${summary.rate_code ?? ''} blank=${JSON.stringify(summary.blankRequired ?? [])}\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'proof_failed'}\n`);
  process.exitCode = 2;
});
