import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import type {CaseCard, TwinEnvelope} from '../types.js';

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

type BaseWorld = {
  anchors:TwinAnchor[];
  profiles:TwinProfile[];
  catalog:Record<string,unknown>;
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

export const confirmationId = (value: unknown) => {
  const raw = String(value ?? '').trim();
  return /^\d{6,10}(?:-\d+)?$/.test(raw) ? (raw.includes('-') ? raw : `${raw}-1`) : null;
};

export function indexMentions(mail: Record<string, unknown>, index: Map<string, number>) {
  const at = Date.parse(String(mail.received_at ?? mail.timestamp ?? ''));
  if (!Number.isFinite(at)) return;
  for (const value of `${mail.subject ?? ''} ${mail.body_text ?? ''}`.matchAll(/(?<![\w-])\d{6,10}(?:-\d+)?(?![\w-])/g)) {
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
  for (const row of optionalJsonl<Record<string, unknown>>(join(dirname(path), 'threads.jsonl'))) {
    if (Array.isArray(row.confirmations) && row.confirmations.length) {
      for (const mail of rows(row.messages)) indexMentions(mail, mentions);
    }
  }
  const evidence = {letters, mentions};
  letterCache.set(path, evidence);
  return evidence;
}

function optionalJson(path:string):Record<string,unknown> | null {
  try {
    return object(JSON.parse(readFileSync(path,'utf8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export const defaultWorldDir = () => join(process.env.NAVA_BENCH_DATA_ROOT ?? DEFAULT_DATA_ROOT, 'world');
export const rows = (value: unknown): Record<string,unknown>[] => Array.isArray(value) ? value.map(object) : [];

const catalogCache = new Map<string, Record<string, unknown>>();
export function loadCatalogue(root = defaultWorldDir()): Record<string, unknown> {
  const cached = catalogCache.get(root);
  if (cached) return cached;
  const catalog = optionalJson(join(root,'catalog.json')) ?? optionalJson(join(root,'catalog/catalog.json'))
    ?? (resolve(root) === resolve(defaultWorldDir()) ? optionalJson(join(dirname(root),'catalog/catalog.json')) : null) ?? {};
  catalogCache.set(root, catalog);
  return catalog;
}

function loadBase(root:string):BaseWorld {
  const cached=baseCache.get(root);
  if(cached) return cached;
  const anchors=jsonl<TwinAnchor>(join(root,'anchors.jsonl'));
  const profilesFile=optionalJson(join(root,'profiles.json'));
  const base={
    anchors,
    profiles:Array.isArray(profilesFile?.profiles) ? profilesFile.profiles as TwinProfile[] : [],
    catalog: loadCatalogue(root),
  };
  baseCache.set(root,base);
  return base;
}

const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]))
  : value;
export const quoteKey = (value: unknown) => JSON.stringify(ordered(value));

function loadQuotes(value: unknown, target: Map<string, {at: number; response: TwinEnvelope}>, cutoff: number): void {
  for (const capture of Array.isArray(value) ? value : Object.values(object(value))) {
    const row = object(capture);
    const stamp = row.captured_at ?? row.observed_at;
    const input = object(row.input ?? row.request);
    const response = object(row.response ?? row.result);
    // Date/room alone does not prove occupancy, filters, quantity, or restrictions matched.
    if (!beforeCutoff(stamp, cutoff) || !Array.isArray(input.groups) || !input.groups.length ||
        (response.ok !== true && response.ok !== false) || !Object.hasOwn(response, 'data')) continue;
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

export function loadTwinWorld(caseCard:CaseCard,root?:string, property?:string, threadSenders?:ThreadSenders):TwinWorld {
  return new TwinWorld(caseCard,root,property,threadSenders);
}
