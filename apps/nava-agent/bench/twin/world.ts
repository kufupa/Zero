import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import type {CaseCard, TwinEnvelope} from '../types.js';
import {extractSenderHost} from '../../src/party-matching.js';
import {normalizeGuaranteeCode} from '../../src/guarantee-normalize.mjs';

export const DEFAULT_DATA_ROOT='/home/orca/.local/share/zero/bench/replay-bench-20261119';

export type TwinPdf = {
  sent_at?:string;
  filed_at?:string;
  pdf_fields?:Record<string,unknown>;
  fields?:Record<string,unknown>;
  [key:string]:unknown;
};

export type TwinAnchor = {
  confirmation:string;
  hms_capture_later?:string;
  hms_fields:Record<string,unknown>;
  pdfs?:TwinPdf[];
  pdf_versions?:TwinPdf[];
  [key:string]:unknown;
};

export type TwinProfile = {
  nativeId:string;
  firstName?:string|null;
  lastName?:string|null;
  email?:string|null;
  mobile?:string|null;
  fields?:Array<{name?:string;value?:unknown;rawValue?:unknown}>;
  [key:string]:unknown;
};

export type SenderPairRow = {
  confirmation: string;
  host: string;
  mailAtMs: number;
  sentAtMs: number;
  ta1: string;
  company: string;
};

type BaseWorld = {
  anchors:TwinAnchor[];
  profiles:TwinProfile[];
  catalog:Record<string,unknown>;
  /** confirmation → Created On epoch ms from stay360 / sidecar (booking-time identity). */
  createdOn:Map<string, number>;
  senderPairs:SenderPairRow[];
};

const baseCache=new Map<string,BaseWorld>();
const object=(value:unknown):Record<string,unknown> =>
  value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};

function jsonl<T>(path:string):T[] {
  return readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as T);
}

function optionalJsonl<T>(path: string): T[] {
  try { return jsonl<T>(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export const rows = (value: unknown): Record<string,unknown>[] => Array.isArray(value) ? value.map(object) : [];

export const confirmationId = (value: unknown) => {
  const raw = String(value ?? '').trim();
  return /^\d{6,10}(?:-\d+)?$/.test(raw) ? (raw.includes('-') ? raw : `${raw}-1`) : null;
};

export function indexMentions(mail: Record<string, unknown>, index: Map<string, number>) {
  const at = Date.parse(String(mail.received_at ?? mail.timestamp ?? mail.sent_at ?? ''));
  if (!Number.isFinite(at)) return;
  const attachmentText = rows(mail.pdf_attachments_text).map(row => String(row.text ?? '')).join(' ');
  for (const value of `${mail.subject ?? ''} ${mail.body_text ?? ''} ${attachmentText}`.matchAll(/(?<![\w-])\d{6,10}(?:-\d+)?(?![\w-])/g)) {
    const id = confirmationId(value[0])!;
    if (at < (index.get(id) ?? Infinity)) index.set(id, at);
  }
}

const letterCache = new Map<string, {letters: TwinPdf[]; mentions: Map<string, number>}>();
function loadLetterEvidence() {
  const path = process.env.NAVA_BENCH_LETTERS ?? '/home/orca/.local/share/zero/runs/overnight-20261122/data/letters.jsonl';
  const cached = letterCache.get(path);
  if (cached) return cached;
  const letters = optionalJsonl<Record<string, unknown>>(path).map(row => ({
    sent_at: String(row.sent_at ?? ''),
    confirmation: row.confirmation_no ?? row.filename_confirmation_no,
    thread_id: row.source_thread_id,
    fields: row.parse_ok === true ? {
      guest_name: row.guest_name, arrival_date: row.arrival, departure_date: row.departure,
      adults: row.adults, children: row.children, room_type_text: row.room_type_text,
      company_text: row.company, agency_text: row.agency,
    } : {},
  }));
  const mentions = new Map<string, number>();
  // Index every thread message; empty confirmations[] still carry HMS refs in body/subject.
  for (const row of optionalJsonl<Record<string, unknown>>(join(dirname(path), 'threads.jsonl'))) {
    for (const mail of rows(row.messages)) indexMentions(mail, mentions);
  }
  const evidence = {letters, mentions};
  letterCache.set(path, evidence);
  return evidence;
}

function optionalJson(path:string):Record<string,unknown> | null {
  try {
    return object(JSON.parse(readFileSync(path,'utf8')));
  } catch (error) {
    // Missing path or accidental directory env (NAVA_BENCH_CREATED=/empty/dir) → absent, not crash.
    if (error && typeof error === 'object' && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'EISDIR')) return null;
    throw error;
  }
}

export const defaultWorldDir = () => join(process.env.NAVA_BENCH_DATA_ROOT ?? DEFAULT_DATA_ROOT, 'world');

const catalogCache = new Map<string, Record<string, unknown>>();
export function loadCatalogue(root = defaultWorldDir()): Record<string, unknown> {
  const cached = catalogCache.get(root);
  if (cached) return cached;
  const catalog = optionalJson(join(root,'catalog.json')) ?? optionalJson(join(root,'catalog/catalog.json'))
    ?? (resolve(root) === resolve(defaultWorldDir()) ? optionalJson(join(dirname(root),'catalog/catalog.json')) : null) ?? {};
  catalogCache.set(root, catalog);
  return catalog;
}

/** Parse Stay360 "Created On:" values like `31-AUG-2026 08:46`. */
export function parseCreatedOn(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  const native = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(raw);
  if (native) {
    const month = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').indexOf(native[2].toUpperCase());
    if (month >= 0) {
      return Date.UTC(Number(native[3]), month, Number(native[1]), Number(native[4] ?? 0), Number(native[5] ?? 0));
    }
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function createdFieldValue(fields: Record<string, unknown> | null | undefined): unknown {
  if (!fields) return null;
  return fields.created ?? fields.created_on ?? fields.createdOn ?? fields.booked_at ?? fields.booked_on
    ?? fields.created_at ?? fields.creation_date ?? fields.created_date ?? fields.createdate;
}

function walkCreatedFields(node: unknown, into: Map<string, number>, confirmation?: string): void {
  if (Array.isArray(node)) {
    for (const item of node) walkCreatedFields(item, into, confirmation);
    return;
  }
  const row = object(node);
  if (!Object.keys(row).length) return;
  const conf = confirmationId(row.confirmation ?? row.confirmation_no ?? row.confirmationnumber ?? confirmation);
  const name = String(row.name ?? '').toLowerCase();
  const label = String(row.label ?? '').toLowerCase();
  if (conf && (name === 'created' || name === 'created_on' || label.startsWith('created on'))) {
    const at = parseCreatedOn(row.value ?? row.rawValue);
    if (at !== null && at < (into.get(conf) ?? Infinity)) into.set(conf, at);
  }
  const nestedConf = conf ?? confirmation;
  for (const value of Object.values(row)) {
    if (value && typeof value === 'object') walkCreatedFields(value, into, nestedConf);
  }
}

function loadCreatedOn(root: string): Map<string, number> {
  const into = new Map<string, number>();
  const overnightReads = '/home/orca/.local/share/zero/runs/overnight-20261122/data';
  const strict = process.env.NAVA_BENCH_STRICT_WORLD === '1';
  // Strict: only supplied Created-On (no implicit overnight/stay360 reads).
  const candidates = (strict ? [process.env.NAVA_BENCH_CREATED] : [
    process.env.NAVA_BENCH_CREATED,
    join(root, 'created-on.jsonl'),
    join(root, 'stay360-run01.json'),
    join(dirname(root), 'stay360-run01.json'),
    join(DEFAULT_DATA_ROOT, 'world', 'stay360-run01.json'),
    join(overnightReads, 'initial-native.reads.jsonl'),
    ...['focus2', 'focus3', 'focus4', 'focus5', 'focus6', 'focus8', 'focus10'].map(name => join(overnightReads, `${name}.reads.jsonl`)),
  ]).filter((path): path is string => !!path);
  for (const path of candidates) {
    if (path.endsWith('.jsonl')) {
      for (const row of optionalJsonl<Record<string, unknown>>(path)) {
        const conf = confirmationId(row.confirmation ?? row.confirmation_no);
        const at = parseCreatedOn(createdFieldValue(object(row)) ?? row.created_on ?? row.created);
        if (conf && at !== null && at < (into.get(conf) ?? Infinity)) into.set(conf, at);
        walkCreatedFields(row.record_view ?? row.recordView ?? row, into, conf ?? undefined);
      }
      continue;
    }
    const doc = optionalJson(path);
    if (!doc) continue;
    walkCreatedFields(doc.results ?? doc, into);
  }
  return into;
}

function loadBase(root:string):BaseWorld {
  const cached=baseCache.get(root);
  if(cached) return cached;
  const anchors=jsonl<TwinAnchor>(join(root,'anchors.jsonl'));
  const profilesFile=optionalJson(join(root,'profiles.json'));
  const createdOn = loadCreatedOn(root);
  // Merge Created On + native guarantee_type from pre-cutoff HMS reads into real replay worlds only (not temp test fixtures).
  const isRealWorld = resolve(root) === resolve(defaultWorldDir()) || root.includes('/v6/') || Boolean(process.env.NAVA_BENCH_DEV_DIR);
  const strict = process.env.NAVA_BENCH_STRICT_WORLD === '1';
  const overnightReads = '/home/orca/.local/share/zero/runs/overnight-20261122/data';
  const readGuarantee = new Map<string, {guaranteetype: string; ta1: string; company: string; createdMs: number}>();
  // Strict: suppress synthetic global read-based commercial anchors.
  if (isRealWorld && !strict && existsSync(overnightReads)) {
    for (const file of readdirSync(overnightReads).filter(f => f.endsWith('.reads.jsonl')).sort()) {
      for (const row of optionalJsonl<Record<string, unknown>>(join(overnightReads, file))) {
        const conf = confirmationId(row.confirmation ?? row.confirmation_no);
        const fieldsList = (object(object(row.record_view).details).fields);
        if (!conf || !Array.isArray(fieldsList)) continue;
        const flds = Object.fromEntries(fieldsList.filter(x => x && typeof x === 'object' && 'name' in x).map(x => [String((x as Record<string, unknown>).name), (x as Record<string, unknown>).value]));
        const gCode = normalizeGuaranteeCode(flds.guaranteetype);
        const createdMs = createdOn.get(conf) ?? parseCreatedOn(flds.createddate ?? flds.createdon ?? flds.created) ?? (typeof row.arrival_hint === 'string' ? Date.parse(`${row.arrival_hint}T00:00:00Z`) : NaN);
        if (gCode && Number.isFinite(createdMs) && !readGuarantee.has(conf)) {
          readGuarantee.set(conf, {guaranteetype: gCode, ta1: String(flds.ta1 ?? '').trim(), company: String(flds.company ?? '').trim(), createdMs});
        }
      }
    }
  }
  const anchorConfs = new Set<string>();
  for (const anchor of anchors) {
    const confirmation = confirmationId(anchor.confirmation);
    if (confirmation) anchorConfs.add(confirmation);
    const createdMs = confirmation ? createdOn.get(confirmation) : undefined;
    const rg = confirmation ? readGuarantee.get(confirmation) : undefined;
    const fields = object(anchor.hms_fields);
    if (createdMs != null && createdFieldValue(fields) == null) {
      anchor.hms_fields = {...fields, created: new Date(createdMs).toISOString()};
    }
    if (rg && !object(anchor.hms_fields).guaranteetype) {
      anchor.hms_fields = {...object(anchor.hms_fields), guaranteetype: rg.guaranteetype, ...(rg.ta1 && !object(anchor.hms_fields).ta1 ? {ta1: rg.ta1} : {}), ...(rg.company && !object(anchor.hms_fields).company ? {company: rg.company} : {})};
    }
    for (const capture of rows(anchor.captures)) {
      const captureFields = object(capture.hms_fields);
      if (createdMs != null && createdFieldValue(captureFields) == null) capture.hms_fields = {...captureFields, created: new Date(createdMs).toISOString()};
      if (rg && !object(capture.hms_fields).guaranteetype) capture.hms_fields = {...object(capture.hms_fields), guaranteetype: rg.guaranteetype};
    }
  }
  // Append strictly time-stamped read-only guarantee stays not already in anchors (run.ts gates createdAtMs < cutoff).
  if (!strict) for (const [conf, rg] of readGuarantee) {
    if (anchorConfs.has(conf) || (!rg.ta1 && !rg.company)) continue;
    const stamp = new Date(rg.createdMs).toISOString();
    anchors.push({confirmation: conf, captured_at: stamp, hms_fields: {created: stamp, ta1: rg.ta1, company: rg.company, guaranteetype: rg.guaranteetype}});
  }
  // Strict: only supplied pairs file (Train-filtered); no default world/global pairs.
  const pairsCandidates = (strict ? [process.env.NAVA_BENCH_PAIRS_FILE] : [
    process.env.NAVA_BENCH_PAIRS_FILE,
    join(root, 'pairs.jsonl'),
    join(DEFAULT_DATA_ROOT, 'world/pairs.jsonl'),
  ]).filter((p): p is string => Boolean(p));
  const pairsPath = pairsCandidates.find(p => existsSync(p));
  const senderPairs: SenderPairRow[] = [];
  if (pairsPath && process.env.NAVA_BENCH_DISABLE_PAIRS !== '1') {
    for (const row of optionalJsonl<Record<string, unknown>>(pairsPath)) {
      const methods = object(row.methods);
      // Strict validation/test worlds must not learn commercial party hints from
      // weak train-derived temporal pairings.  Only direct evidence that the
      // sender thread produced this hotel confirmation is admissible there.
      if (strict && methods.direct_confirmation !== true && methods.direct_header !== true) continue;
      const anchor = object(row.anchor);
      const fields = object(anchor.hms_fields);
      const sentAtMs = Date.parse(String(anchor.sent_at ?? ''));
      const conf = String(row.confirmation ?? row.case_id ?? '').trim();
      if (!conf || !Number.isFinite(sentAtMs)) continue;
      const ta1 = String(fields.ta1 ?? '').trim();
      const company = String(fields.company ?? '').trim();
      const thread = object(row.thread);
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      const seenHosts = new Map<string, number>();
      for (const raw of msgs) {
        const msg = object(raw);
        if (msg.direction !== 'inbound') continue;
        const at = Date.parse(String(msg.timestamp ?? msg.received_at ?? ''));
        if (!Number.isFinite(at) || at > sentAtMs) continue;
        const frm = Array.isArray(msg.from) ? msg.from[0] : msg.from;
        const host = extractSenderHost(typeof frm === 'string' ? frm : object(frm).email, '');
        if (host && at < (seenHosts.get(host) ?? Infinity)) seenHosts.set(host, at);
      }
      for (const [host, mailAtMs] of seenHosts) {
        senderPairs.push({confirmation: conf, host, mailAtMs, sentAtMs, ta1, company});
      }
    }
  }
  const devDir = process.env.NAVA_BENCH_DEV_DIR ?? join(overnightReads, 'v6/dev');
  const catalog = loadCatalogue(root);
  const canonicalName = (kind: 'agencies' | 'organizations', raw: string): string => {
    const catalogs = object(catalog.catalogs ?? catalog);
    const sec = object(catalogs[kind]);
    const list = Array.isArray(catalogs[kind]) ? catalogs[kind] as unknown[] : Array.isArray(sec.records) ? sec.records : [];
    const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(?:pty|ltd|limited|cc)\b/g, '').trim().replace(/\s+/g, ' ');
    let prefixHit: string | null = null;
    for (const r of list) {
      const rec = object(r);
      const name = String(rec.meaning ?? rec.name ?? rec.displayName ?? '').trim();
      if (!name) continue;
      const cn = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(?:pty|ltd|limited|cc)\b/g, '').trim().replace(/\s+/g, ' ');
      if (cn === norm) return name;
      if (!prefixHit && norm.length >= 6 && cn.length >= 6 && (norm.startsWith(cn) || cn.startsWith(norm))) prefixHit = name;
    }
    return prefixHit ?? raw;
  };
  // Train gold-derived prompt hints are opt-in only (never default / never in strict world).
  const allowGoldPairs = !strict && process.env.NAVA_BENCH_ALLOW_GOLD_PAIRS === '1'
    && process.env.NAVA_BENCH_DISABLE_PAIRS !== '1';
  if (allowGoldPairs && isRealWorld && existsSync(join(devDir, 'gold.json'))) {
    const devGold = optionalJson(join(devDir, 'gold.json')) ?? {};
    for (const [cid, rawRow] of Object.entries(devGold)) {
      const row = object(rawRow);
      if (row.workflow !== 'create' || row.skip === true) continue;
      const cd = optionalJson(join(devDir, cid, 'case.json'));
      if (!cd) continue;
      const asOfMs = Date.parse(String(cd.as_of ?? ''));
      if (!Number.isFinite(asOfMs)) continue;
      const sel = object(cd.selected_email);
      const fromAddr = String(sel.from_address ?? '');
      let host = extractSenderHost(fromAddr, '');
      if (!host && /legacyhotels?\./i.test(fromAddr)) {
        const m = /^\s*>?\s*From:[^\r\n]*?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/im.exec(String(sel.body_text ?? ''));
        if (m) host = extractSenderHost(m[1], '');
      }
      if (!host) continue;
      let ta1 = '', company = '';
      for (const item of rows(row.gold)) {
        const path = String(item.path ?? '');
        const val = typeof item.value === 'string' && !item.value.startsWith('{') ? item.value.trim() : '';
        if (path === '/bookings/0/fields/agency_name' && val) ta1 = canonicalName('agencies', val);
        if (path === '/bookings/0/fields/organization_name' && val) company = canonicalName('organizations', val);
      }
      // Only emit dev pairs with an explicit agency_name (gold.json omits unmentioned ta1; never poison directMisses).
      if (ta1) senderPairs.push({confirmation: cid, host, mailAtMs: asOfMs, sentAtMs: asOfMs, ta1, company});
    }
  }
  const base={
    anchors,
    profiles:Array.isArray(profilesFile?.profiles) ? profilesFile.profiles as TwinProfile[] : [],
    catalog,
    createdOn,
    senderPairs,
  };
  baseCache.set(root,base);
  return base;
}

const SESSION_KEYS = /^(session|session_id|sessionId|page|page_id|cookie|cookies|authorization|token|csrf|trace|trace_id)$/i;

/** Business criteria only: drop transient session IDs; keep LOS/dates/party/ages/restrictions. */
const orderedQuote = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(orderedQuote);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SESSION_KEYS.test(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, orderedQuote(item)]),
    );
  }
  return value;
};
export const quoteKey = (value: unknown) => JSON.stringify(orderedQuote(value));

function loadQuotes(value: unknown, target: Map<string, {at: number; response: TwinEnvelope}>, cutoff: number): void {
  for (const capture of Array.isArray(value) ? value : Object.values(object(value))) {
    const row = object(capture);
    const stamp = row.captured_at ?? row.observed_at;
    const input = object(row.input ?? row.request);
    const response = object(row.response ?? row.result);
    // Date/room alone does not prove occupancy, filters, quantity, LOS, or restrictions matched.
    if (!beforeCutoff(stamp, cutoff) || !Array.isArray(input.groups) || !input.groups.length ||
        (response.ok !== true && response.ok !== false) || !Object.hasOwn(response, 'data')) continue;
    // Keep observed unavailable/sold-out tapes — agent must see complete no-offer, not TWIN_NO_PRICE.
    // Zero-stock is not a priced offer, but it is an observed outcome for that exact request.
    const at = Date.parse(String(stamp));
    const key = quoteKey(input);
    if ((target.get(key)?.at ?? -Infinity) < at) target.set(key, {at, response: response as TwinEnvelope});
  }
}

export function beforeCutoff(value: unknown, cutoff: number): boolean {
  return typeof value === 'string' && Date.parse(value) < cutoff;
}

export function selectedCutoff(card: CaseCard): number {
  const selected = object(card.selected_email);
  const received = Date.parse(String(selected.received_at ?? selected.timestamp ?? card.as_of ?? ''));
  return Math.min(received, card.as_of == null ? received : Date.parse(card.as_of));
}

export function anchorPdfs(anchor: TwinAnchor): TwinPdf[] {
  return [...(anchor.pdf_versions ?? []), ...(anchor.pdfs ?? [])];
}

export function anchorCaptures(anchor: TwinAnchor) {
  return [...rows(anchor.captures), {...anchor, captured_at: anchor.captured_at ?? anchor.hms_capture_later}]
    .filter(row => Object.keys(object(row.hms_fields)).length)
    .sort((a, b) => Date.parse(String(b.captured_at)) - Date.parse(String(a.captured_at)));
}

export type ThreadSenders = ReadonlyMap<string, {host: string; at: number}>;

export class TwinWorld {
  readonly anchors:TwinAnchor[];
  readonly profiles:TwinProfile[];
  readonly catalog:Record<string,unknown>;
  readonly createdOn:Map<string, number>;
  readonly senderPairs:SenderPairRow[];
  readonly quotes=new Map<string,{at: number; response: TwinEnvelope}>();
  readonly cutoff: number;
  readonly letterEvidence: ReturnType<typeof loadLetterEvidence>;
  readonly coverage={quoteMisses:0};
  readonly propertyCode: string;

  constructor(caseCard:CaseCard, root=defaultWorldDir(), property?:string, readonly threadSenders?: ThreadSenders) {
    const base=loadBase(root);
    this.propertyCode = String(caseCard.property_code ?? caseCard.source?.property_code ?? property ?? 'HRCEN').trim().toUpperCase();
    if (!this.propertyCode) throw new Error('Replay property is empty');
    const inProperty = (row: Record<string,unknown>) =>
      String(row.property_code ?? row.propertyCode ?? 'HRCEN').toUpperCase() === this.propertyCode;
    this.anchors = base.anchors.filter(inProperty);
    this.createdOn = base.createdOn;
    this.senderPairs = this.propertyCode === 'HRCEN' ? base.senderPairs : [];
    this.letterEvidence = this.propertyCode === 'HRCEN' ? loadLetterEvidence() : {letters: [], mentions: new Map()};
    this.cutoff=selectedCutoff(caseCard);
    if (!Number.isFinite(this.cutoff)) throw new Error('CASE_AS_OF_MISSING');
    this.profiles=base.profiles.filter(profile => inProperty(profile) && beforeCutoff(profile.observedAt ?? profile.observed_at, this.cutoff));
    // Room, rate, and party directories are static reference data.
    this.catalog=inProperty(base.catalog) ? base.catalog : {};
    loadQuotes(caseCard.quotes,this.quotes,this.cutoff);
    loadQuotes(object(caseCard.world).quotes,this.quotes,this.cutoff);
    loadQuotes(caseCard.recorded_prices,this.quotes,this.cutoff);
  }

}

export {createdFieldValue};

export function loadTwinWorld(caseCard:CaseCard,root?:string, property?:string, threadSenders?:ThreadSenders):TwinWorld {
  return new TwinWorld(caseCard,root,property,threadSenders);
}
