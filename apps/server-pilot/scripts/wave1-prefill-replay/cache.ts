import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReservationWorkflowV2ReadResult } from '../../src/ai/reservation-workflow-v2-prefill.js';

const DEFAULT_CATALOG = '/home/orca/.local/share/zero/research/halloween/v2-prefill-backtest-redesign-20261111/cache-catalog-v7.jsonl';
const coverageSchema = z.object({ complete: z.boolean(), notes: z.array(z.string()).default([]) });
const catalogSchema = z.object({
  kind: z.enum(['stay360_observation', 'profile_master', 'documents_observation', 'availability_observation', 'production_read']),
  path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), pointer: z.string(),
  identity: z.string(), propertyCode: z.string(), observedAt: z.string().nullable(),
  coverage: coverageSchema, observedInterval: z.tuple([z.string().nullable(), z.string().nullable()]).optional(),
  tool: z.string().optional(), argsKey: z.string().optional(),
}).passthrough();
type CatalogEntry = z.infer<typeof catalogSchema>;
type Coverage = z.infer<typeof coverageSchema>;

export type ReadRequest = {
  propertyCode: string;
  tool: string;
  args: unknown;
  sourceCutoff: string;
  coverageRequired: 'complete' | 'any';
  mode: 'historical' | 'observed';
  operation: 'read' | 'prepare' | 'write';
  fresh?: boolean;
};
export type ReadSidecar = {
  origin: 'cache' | 'live';
  observedAt: string | null;
  observedInterval?: [string | null, string | null];
  sourceCutoff: string;
  historicalValidity: 'unresolved';
  coverage: Coverage;
  payloadSha256: string | null;
  notes: string[];
};
export type MasterProfilesRead = {
  outcome: string;
  sessionVerified?: boolean;
  profiles: unknown[];
};
export type ProfileTemporal = {
  nativeId: string;
  status: 'after_cutoff' | 'existed_by_cutoff' | 'unknown';
  createdRaw: string | null;
  earliestUtc: string | null;
  latestUtc: string | null;
  observedAt: string | null;
  evidence: { path: string | null; sha256: string | null };
  note: string;
};
export type GuestSidecar = {
  sourceCutoff: string;
  profiles: ProfileTemporal[];
  excludedIds: string[];
  historicalCoverage: 'unresolved';
  rawCandidateCount: number;
  deliveredCandidateCount: number;
};
export type GuestArgs = {
  result: ReservationWorkflowV2ReadResult | null;
  propertyCode: string;
  sourceCutoff: string;
  readProfiles?: (nativeIds: string[]) => Promise<MasterProfilesRead>;
};
export type StaySidecar = { sourceCutoff: string; excludedConfirmations: string[];
  stays: Array<{ confirmation: string; status: ProfileTemporal['status']; createdRaw: string | null;
    earliestUtc: string | null; latestUtc: string | null; evidence: ReadSidecar | null }> };

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = object(value);
  if (!row) throw new Error('NON_JSON_CACHE_VALUE');
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
/** Source citations are not native query arguments. Retain every business criterion. */
export function nativeReadArgsKey(tool: string, args: unknown): string {
  const native = ['guest_candidate', 'stay_candidate', 'party_candidate', 'rate_availability'].includes(tool);
  const withoutSourceRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutSourceRefs);
    const row = object(value);
    return row ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'sourceRefs')
      .map(([key, item]) => [key, withoutSourceRefs(item)])) : value;
  };
  return digest(canonical(native ? withoutSourceRefs(args) : args));
}
function safeForStorage(value: unknown): boolean {
  if (typeof value === 'string') return !/(?:bearer\s+\S+|[?&](?:token|signature|password|key)=|:\/\/[^/\s]+@)/i.test(value);
  if (Array.isArray(value)) return value.every(safeForStorage);
  const row = object(value);
  if (!row) return value === null || ['number', 'boolean', 'string'].includes(typeof value);
  return Object.entries(row).every(([key, item]) =>
    !/(?:password|credential|secret|token|cookie|authorization|session(?:id)?|searchid|prepared(?:id|ref)|requestheaders)/i.test(key) && safeForStorage(item));
}
function readCoverage(value: unknown): Coverage {
  const result = object(value);
  const parsed = coverageSchema.safeParse(result?.coverage);
  return parsed.success ? parsed.data : { complete: false, notes: ['Reader did not return a compatible coverage declaration.'] };
}
function pointerValue(data: unknown, pointer: string): unknown {
  if (!pointer) return data;
  if (!/^\/(?:[^/~]|~[01]|\/)*$/.test(pointer)) throw new Error('INVALID_CATALOG_POINTER');
  let value = data;
  for (const part of pointer.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
    else value = object(value)?.[part];
    if (value === undefined) throw new Error('MISSING_CATALOG_POINTER');
  }
  return value;
}

/** Native master Header shows a minute-resolution local civil timestamp without an offset.
 * The full current civil-zone offset range (-12h..+14h) bounds possible UTC instants.
 * This treats the native Created On field as profile creation time, not field-history proof. */
export function classifyMasterCreation(createdRaw: string | null, sourceCutoff: string):
  { status: ProfileTemporal['status']; earliestUtc: string | null; latestUtc: string | null } {
  const match = createdRaw?.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  const cutoff = Date.parse(sourceCutoff);
  if (!match || !Number.isFinite(cutoff) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(sourceCutoff)) {
    return { status: 'unknown', earliestUtc: null, latestUtc: null };
  }
  const [, m, d, y, h, min] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(min);
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  const roundtrip = new Date(ms);
  if (year < 2000 || year > 2100 || roundtrip.getUTCFullYear() !== year || roundtrip.getUTCMonth() !== month - 1 ||
      roundtrip.getUTCDate() !== day || roundtrip.getUTCHours() !== hour || roundtrip.getUTCMinutes() !== minute) {
    return { status: 'unknown', earliestUtc: null, latestUtc: null };
  }
  const earliest = ms - 14 * 3_600_000, latest = ms + 12 * 3_600_000 + 59_999;
  return { status: earliest > cutoff ? 'after_cutoff' : latest <= cutoff ? 'existed_by_cutoff' : 'unknown',
    earliestUtc: new Date(earliest).toISOString(), latestUtc: new Date(latest).toISOString() };
}

export class EvidenceGateway {
  private readonly payloads = new Map<string, unknown>();
  private readonly entries: CatalogEntry[];
  private readonly masters = new Map<string, { value: unknown; path: string | null; sha256: string | null }>();
  private appendQueue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, entries: CatalogEntry[]) { this.entries = entries; }

  private async payload(entry: CatalogEntry): Promise<unknown> {
    const key = `${entry.path}\u001f${entry.sha256}`;
    if (!this.payloads.has(key)) {
      const bytes = await readFile(entry.path);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('CACHE_HASH_MISMATCH');
      this.payloads.set(key, JSON.parse(bytes.toString('utf8')));
    }
    return pointerValue(this.payloads.get(key), entry.pointer);
  }

  async read<T>(request: ReadRequest, live: () => Promise<T>): Promise<{ result: T; sidecar: ReadSidecar }> {
    const notes: string[] = [];
    const requiresLive = request.operation !== 'read' || /(?:^|[_:.-])(?:prepare|save|execute|dispatch|commit)(?:$|[_:.-])/i.test(request.tool);
    const canStore = !requiresLive && safeForStorage(request.args);
    let argsKey: string | null = null;
    try { if (canStore) argsKey = nativeReadArgsKey(request.tool, request.args); } catch { notes.push('Non-JSON arguments cannot be cached.'); }
    if (argsKey && !request.fresh && request.mode === 'observed') {
      const matches = this.entries.filter(entry => entry.kind === 'production_read' && entry.propertyCode === request.propertyCode &&
        entry.tool === request.tool && entry.argsKey === argsKey &&
        (request.coverageRequired !== 'complete' || entry.coverage.complete));
      for (const entry of matches.toSorted((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''))) {
        try {
          const value = await this.payload(entry);
          if (!safeForStorage(value)) throw new Error('CACHE_TRANSIENT_VALUE');
          return { result: value as T, sidecar: { origin: 'cache', observedAt: entry.observedAt,
            sourceCutoff: request.sourceCutoff, historicalValidity: 'unresolved', coverage: entry.coverage,
            payloadSha256: entry.sha256, notes: ['Observed-state cache; not evidence of historical state or current freshness.'] } };
        } catch { notes.push('Cached payload failed integrity, schema or session-safety validation; delegated live.'); }
      }
    }
    const result = await live();
    const observedAt = new Date().toISOString(), coverage = readCoverage(result);
    let payloadSha256: string | null = null;
    const liveResult = object(result);
    const prepared = liveResult?.status === 'prepared' || liveResult?.outcome === 'prepared';
    if (argsKey && !requiresLive && !prepared && result !== null && safeForStorage(result)) {
      try {
        const body = JSON.stringify(result);
        if (typeof body !== 'string') throw new Error('NON_JSON_CACHE_RESULT');
        payloadSha256 = digest(body);
        const path = join(this.directory, 'objects', `${payloadSha256}.json`);
        try { await writeFile(path, body, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (!object(error) || object(error)?.code !== 'EEXIST') throw error;
          const existing = await readFile(path);
          if (createHash('sha256').update(existing).digest('hex') !== payloadSha256) throw new Error('CACHE_HASH_MISMATCH');
        }
        const entry: CatalogEntry = { kind: 'production_read', path, sha256: payloadSha256, pointer: '',
          identity: '', propertyCode: request.propertyCode, observedAt, coverage, tool: request.tool, argsKey };
        this.appendQueue = this.appendQueue.then(async () => {
          await appendFile(join(this.directory, `runtime-${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
          this.entries.push(entry);
        });
        await this.appendQueue;
      } catch { payloadSha256 = null; notes.push('Live result was not persisted in the cache.'); }
    } else if (requiresLive || prepared) notes.push('Prepare and write operations are always live and are never cached.');
    else notes.push('Result or arguments contain transient, sensitive or unsupported values; not cached.');
    return { result, sidecar: { origin: 'live', observedAt, sourceCutoff: request.sourceCutoff,
      historicalValidity: 'unresolved', coverage, payloadSha256, notes } };
  }

  private async profileEvidence(args: GuestArgs): Promise<ProfileTemporal[]> {
    const candidates = args.result && Array.isArray(args.result.result.candidates) ? args.result.result.candidates : [];
    const ids = [...new Set(candidates.flatMap(candidate => {
      const id = object(candidate)?.nativeId;
      return typeof id === 'string' && /^\d+$/.test(id) ? [id] : [];
    }))];
    const found = new Map<string, { value: unknown; path: string | null; sha256: string | null }>();
    for (const id of ids) {
      const memo = this.masters.get(`${args.propertyCode}\u001f${id}`);
      if (memo) { found.set(id, memo); continue; }
      const entries = this.entries.filter(entry => entry.kind === 'profile_master' && entry.identity === id &&
        entry.propertyCode === args.propertyCode && entry.coverage.complete);
      for (const entry of entries.toReversed()) {
        try {
          const value = await this.payload(entry), profile = object(value);
          if (profile?.nativeId !== id || profile.propertyCode !== args.propertyCode || profile.outcome !== 'read') continue;
          const evidence = { value, path: entry.path, sha256: entry.sha256 };
          found.set(id, evidence); this.masters.set(`${args.propertyCode}\u001f${id}`, evidence); break;
        } catch { /* Invalid cached evidence cannot establish creation time. */ }
      }
    }
    const missing = ids.filter(id => !found.has(id));
    if (missing.length && args.readProfiles) {
      try {
        const batch = await args.readProfiles(missing);
        if (batch.outcome === 'read' && batch.sessionVerified === true) {
          for (const value of batch.profiles) {
            const profile = object(value), id = profile?.nativeId;
            if (profile && typeof id === 'string' && missing.includes(id) && profile.propertyCode === args.propertyCode && profile.outcome === 'read') {
              let evidence: { value: unknown; path: string | null; sha256: string | null } = { value, path: null, sha256: null };
              if (safeForStorage(value)) {
                try {
                  const body = JSON.stringify(value), sha256 = digest(body);
                  const path = join(this.directory, 'objects', `${sha256}.json`);
                  try { await writeFile(path, body, { flag: 'wx', mode: 0o600 }); }
                  catch (error) {
                    if (object(error)?.code !== 'EEXIST') throw error;
                    if (createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) throw new Error('CACHE_HASH_MISMATCH');
                  }
                  const entry: CatalogEntry = { kind: 'profile_master', path, sha256, pointer: '', identity: id,
                    propertyCode: args.propertyCode, observedAt: typeof profile.observedAt === 'string' ? profile.observedAt : null,
                    coverage: { complete: true, notes: ['Exact-ID master Header read; field coverage remains limited.'] } };
                  this.appendQueue = this.appendQueue.then(async () => {
                    await appendFile(join(this.directory, `runtime-${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
                    this.entries.push(entry);
                  });
                  await this.appendQueue;
                  evidence = { value, path, sha256 };
                } catch { /* Live evidence is still usable in this process. */ }
              }
              found.set(id, evidence); this.masters.set(`${args.propertyCode}\u001f${id}`, evidence);
            }
          }
        }
      } catch { /* An unavailable live master read leaves creation time unknown. */ }
    }
    return ids.map(nativeId => {
      const evidence = found.get(nativeId), profile = object(evidence?.value);
      const fields = Array.isArray(profile?.fields) ? profile.fields : [];
      const created = fields.map(object).filter(field => field?.name === 'created');
      const raw = created.length === 1 && created[0]?.state === 'present' && typeof created[0].value === 'string' ? created[0].value : null;
      const classification = classifyMasterCreation(raw, args.sourceCutoff);
      return { nativeId, ...classification, createdRaw: raw,
        observedAt: typeof profile?.observedAt === 'string' ? profile.observedAt : null,
        evidence: { path: evidence?.path ?? null, sha256: evidence?.sha256 ?? null },
        note: classification.status === 'unknown' ? 'Master creation time, timezone range, identity or read is unresolved.' :
          'Assumes native master Created On is creation time; offsets bounded to UTC-12..UTC+14; current profile fields remain historically uncertain.' };
    });
  }

  /** Exact-ID master reads preserve the native payload. A partial batch is never a complete absence claim. */
  async readMasterProfiles(input: { propertyCode: string; nativeIds: string[];
    readProfiles?: (nativeIds: string[]) => Promise<MasterProfilesRead> }): Promise<MasterProfilesRead & {
      evidence: Array<{ nativeId: string; path: string | null; sha256: string | null }> }> {
    if (new Set(input.nativeIds).size !== input.nativeIds.length || input.nativeIds.some(id => !/^\d+$/.test(id))) {
      return { outcome: 'input_gap', sessionVerified: false, profiles: [], evidence: [] };
    }
    await this.profileEvidence({ propertyCode: input.propertyCode, sourceCutoff: new Date().toISOString(),
      result: { status: 'partial', result: { candidates: input.nativeIds.map(nativeId => ({ nativeId })) } },
      readProfiles: input.readProfiles });
    const rows = input.nativeIds.flatMap(nativeId => {
      const evidence = this.masters.get(`${input.propertyCode}\u001f${nativeId}`);
      return evidence ? [{ nativeId, ...evidence }] : [];
    });
    const complete = rows.length === input.nativeIds.length;
    return { outcome: complete ? 'read' : 'partial', sessionVerified: complete,
      profiles: rows.map(row => row.value), evidence: rows.map(({ nativeId, path, sha256 }) => ({ nativeId, path, sha256 })) };
  }

  /** Original captured Stay 360/Documents payload only, never a production candidate-search response. */
  async readSnapshot(input: { kind: 'stay360_observation' | 'documents_observation'; propertyCode: string;
    confirmation: string; sourceCutoff: string; coverageRequired: 'complete' | 'any' }):
    Promise<{ result: unknown; sidecar: ReadSidecar } | null> {
    if (!/^\d{6,10}-\d{1,2}$/.test(input.confirmation)) return null;
    const entries = this.entries.filter(entry => entry.kind === input.kind && entry.propertyCode === input.propertyCode &&
      entry.identity === input.confirmation && (input.coverageRequired === 'any' || entry.coverage.complete));
    for (const entry of entries.toReversed()) {
      try {
        const result = await this.payload(entry), root = object(result);
        const stay = object(root?.stay360), record = object(root?.recordView);
        if (root?.ok !== true || root.confirmation !== input.confirmation ||
            object(stay?.details)?.confirmationInHeader !== input.confirmation ||
            object(record?.details)?.confirmationInRecord !== input.confirmation) continue;
        if (input.kind === 'documents_observation' && !root.documents) continue;
        return { result, sidecar: { origin: 'cache', observedAt: entry.observedAt,
          ...(entry.observedInterval ? { observedInterval: entry.observedInterval } : {}), sourceCutoff: input.sourceCutoff,
          historicalValidity: 'unresolved', coverage: entry.coverage, payloadSha256: entry.sha256,
          notes: ['Original snapshot only; not a candidate-reader response and not proof of historical or current state.'] } };
      } catch { /* Ignore mismatched/corrupt evidence. */ }
    }
    return null;
  }

  async classifyGuestCandidates(args: GuestArgs): Promise<{ result: ReservationWorkflowV2ReadResult | null; sidecar: GuestSidecar }> {
    const profiles = await this.profileEvidence(args);
    const candidates = args.result && Array.isArray(args.result.result.candidates) ? args.result.result.candidates : [];
    return { result: args.result, sidecar: { sourceCutoff: args.sourceCutoff, profiles, excludedIds: [],
      historicalCoverage: 'unresolved', rawCandidateCount: candidates.length, deliveredCandidateCount: candidates.length } };
  }

  async filterGuestCandidates(args: GuestArgs): Promise<{ result: ReservationWorkflowV2ReadResult | null; sidecar: GuestSidecar }> {
    const { result, sidecar } = await this.classifyGuestCandidates(args);
    const excludedIds = sidecar.profiles.filter(profile => profile.status === 'after_cutoff').map(profile => profile.nativeId);
    if (!result || !excludedIds.length || !Array.isArray(result.result.candidates)) return { result, sidecar };
    const delivered = result.result.candidates.filter(candidate => {
      const id = object(candidate)?.nativeId;
      return typeof id !== 'string' || !excludedIds.includes(id);
    });
    const resultCoverage = object(result.result.coverage);
    return { result: { ...result, status: 'partial',
      coverage: { complete: false, notes: [...(result.coverage?.notes ?? []), 'Post-cutoff master profiles excluded; historical search completeness is unresolved.'] },
      result: { ...result.result, outcome: 'partial', candidates: delivered, enumeratedCount: delivered.length,
        ...(resultCoverage ? { coverage: { ...resultCoverage, possiblyTruncated: true, truncated: true } } : {}) } },
      sidecar: { ...sidecar, excludedIds, deliveredCandidateCount: delivered.length } };
  }

  /** Identity-verified record creation excludes future stays; never proves historical query absence. */
  async filterStayCandidates(args: { result: ReservationWorkflowV2ReadResult | null; propertyCode: string; sourceCutoff: string }):
    Promise<{ result: ReservationWorkflowV2ReadResult | null; sidecar: StaySidecar }> {
    const native = args.result?.result;
    const rows = Array.isArray(native?.rows) ? native.rows : object(native?.stay) ? [native?.stay] : [];
    const confirmations = [...new Set(rows.flatMap(row => {
      const confirmation = object(row)?.confirmation;
      return typeof confirmation === 'string' && /^\d{6,10}-\d{1,2}$/.test(confirmation) ? [confirmation] : [];
    }))];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const sidecar: StaySidecar = { sourceCutoff: args.sourceCutoff, excludedConfirmations: [], stays: [] };
    for (const confirmation of confirmations) {
      const snapshot = await this.readSnapshot({ kind: 'stay360_observation', propertyCode: args.propertyCode,
        confirmation, sourceCutoff: args.sourceCutoff, coverageRequired: 'any' });
      const fields = object(object(object(snapshot?.result)?.recordView)?.details)?.fields;
      const list = Array.isArray(fields) ? fields.map(object) : [];
      const created = list.filter(field => field?.name === 'created' && field.section === 'Record Details');
      const reservation = list.filter(field => field?.name === 'reservationdate' && field.section === 'Reservation');
      const raw = created.length === 1 && typeof created[0]?.value === 'string' ? created[0].value : null;
      const match = raw?.match(/^(\d{2})-([A-Z]{3})-(\d{4}) (\d{2}):(\d{2})$/);
      const corroborated = reservation.length === 1 && typeof reservation[0]?.value === 'string' &&
        raw?.slice(0, 11) === reservation[0].value.slice(0, 11);
      const month = match ? months.indexOf(match[2]!) + 1 : 0;
      const civil = match && month && corroborated ? `${String(month).padStart(2, '0')}/${match[1]}/${match[3]} ${match[4]}:${match[5]}` : null;
      const temporal = classifyMasterCreation(civil, args.sourceCutoff);
      sidecar.stays.push({ confirmation, ...temporal, createdRaw: raw, evidence: snapshot?.sidecar ?? null });
      if (temporal.status === 'after_cutoff') sidecar.excludedConfirmations.push(confirmation);
    }
    if (!args.result || !native || !sidecar.excludedConfirmations.length) return { result: args.result, sidecar };
    const excluded = new Set(sidecar.excludedConfirmations);
    return { result: { ...args.result, status: 'partial', result: { ...native, outcome: 'partial',
      ...(Array.isArray(native.rows) ? { rows: native.rows.filter(row => !excluded.has(String(object(row)?.confirmation))), truncated: true } : {}),
      ...(object(native.stay) && excluded.has(String(object(native.stay)?.confirmation)) ? { stay: null } : {}) },
      coverage: { complete: false, notes: [...(args.result.coverage?.notes ?? []),
        'Known post-cutoff stay creation excluded using identity-verified Created On and Reservation Date; historical search completeness remains unresolved.'] } }, sidecar };
  }
}

export async function createEvidenceGateway(directory: string, options: { catalogPath?: string } = {}): Promise<EvidenceGateway> {
  await mkdir(join(directory, 'objects'), { recursive: true, mode: 0o700 });
  const entries: CatalogEntry[] = [];
  const runtimeFiles = (await readdir(directory)).filter(name => /^runtime-\d+\.jsonl$/.test(name)).sort();
  const paths = [options.catalogPath ?? DEFAULT_CATALOG, ...runtimeFiles.map(name => join(directory, name))];
  for (const path of paths) {
    let content: string;
    try { content = await readFile(path, 'utf8'); }
    catch (error) {
      if (object(error)?.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of content.split('\n').filter(Boolean)) {
      const parsed = catalogSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error('INVALID_CACHE_CATALOG');
      entries.push(parsed.data);
    }
  }
  return new EvidenceGateway(directory, entries);
}
