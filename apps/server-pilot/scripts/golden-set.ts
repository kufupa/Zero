import { classifyMailSource, type MailSourceClassification } from '../src/ai/mail-source.js';
import { withGoldenSetPairLock, writePrivateFileAtomically } from './golden-set-storage.js';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { normalisePartyName } from '../src/ai/party-match-v2.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const DATA_ROOT = '/home/orca/nava-research';
const CORPUS_ROOT = `${DATA_ROOT}/corpus/2026-10-13`;
const GOLDEN_PATH = `${DATA_ROOT}/testsets/golden-v1.jsonl`;
const HMS_NEEDED_PATH = `${DATA_ROOT}/testsets/golden-v1-hms-needed.json`;
const PARTY_TRUTH_PATH = `${DATA_ROOT}/testsets/party-truth.jsonl`;
const DEFAULT_REPORT_PATH = `${DATA_ROOT}/reports/golden-v1-score.md`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HMS_WINDOW_START = '2026-09-12';
const CROSS_THREAD_REPLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const GOLDEN_CLASSES = ['quote', 'amend', 'cancel', 'create', 'skip'] as const;

export type GoldenClass = (typeof GOLDEN_CLASSES)[number];
export type ChangeType = 'dates' | 'rooms' | 'names' | 'other';

const TARGET_COUNTS: Record<GoldenClass, number> = {
  quote: 12,
  amend: 6,
  cancel: 4,
  create: 3,
  skip: 5,
};

const CLASS_PRIORITY: Record<GoldenClass, number> = {
  skip: 0,
  cancel: 1,
  amend: 2,
  create: 3,
  quote: 4,
};

const KNOWN_NON_DIRECT_DOMAINS = [
  'synxis.com',
  'expedia.com',
  'expediapartnercentral.com',
  'partnercentral.com',
  'webbeds.com',
  'hotelbeds.com',
  'booking.com',
  'get-e.com',
  'get-e.co.za',
  'hotels.com',
  'agoda.com',
  'trip.com',
  'traveloka.com',
  'airbnb.com',
  'reviewpro.com',
  'trustyou.com',
  'tripadvisor.com',
  'revinate.com',
  'medallia.com',
] as const;

type JsonRecord = Record<string, unknown>;

export type GoldenDate = { arrival: string; departure: string };
export type GoldenRoom = { count: number | null; room_type: string | null };
export type GoldenParty = { company: string | null; agency: string | null };

export type GoldenAnswer = {
  dates?: GoldenDate[];
  rooms?: GoldenRoom[];
  room_count?: number | null;
  room_type?: string | null;
  board?: string | null;
  party?: GoldenParty | null;
  rate_plan?: string | null;
  total?: string | null;
  conf?: string | null;
  confirmation_numbers?: string[];
  extracted_confirmation_numbers?: string[];
  change_type?: ChangeType | null;
  change_types?: ChangeType[];
  hms?: JsonRecord | null;
  hmsCurrent?: JsonRecord | null;
  status?: string | null;
  cancellation_reply?: {
    confirmed: boolean;
    confirmation_number: string | null;
  } | null;
  skip?: boolean;
};

export type GoldenEvidence = {
  inbound_message_id: string;
  staff_message_ids: string[];
  pdf_files: string[];
  staff_quote_run_ids?: string[];
  hms_read_ids?: string[];
  hms_truth?: { source: string; conf: string } | null;
  source_classification?: {
    kind: string;
    source: string | null;
    reason: string;
  };
};

export type GoldenRow = {
  message_id: string;
  class: GoldenClass;
  answer: GoldenAnswer;
  evidence: GoldenEvidence;
};

export type GoldenCandidate = GoldenRow & {
  sender_domain: string | null;
  stay_date: string | null;
  received_at: string;
};

export type GoldenPrediction = JsonRecord & { message_id?: string };
export type MetricCount = { correct: number; total: number };
export type ClassScore = {
  count: number;
  action: MetricCount;
  dates: MetricCount;
  confirmation: MetricCount;
  rooms: MetricCount;
  party: MetricCount;
};

export type GoldenScore = {
  byClass: Record<GoldenClass, ClassScore>;
  overall: ClassScore;
  skip: {
    true_positive: number;
    false_positive: number;
    false_negative: number;
    precision: MetricCount;
    recall: MetricCount;
  };
};

export type GoldenSelection = {
  rows: GoldenRow[];
  availableByClass: Record<GoldenClass, number>;
  eligibleByClass: Record<GoldenClass, number>;
  selectedByClass: Record<GoldenClass, number>;
  targets: Record<GoldenClass, number>;
};

type CrossThreadBookingEvidence = {
  requestText: string;
  senderDomain: string | null;
  requestAt: string;
  staffAt: string;
  requestDates: readonly GoldenDate[];
  outcomeDates: readonly GoldenDate[];
  party: GoldenParty | null | undefined;
};

export function isCrossThreadBookingMatch(evidence: CrossThreadBookingEvidence): boolean {
  const requestTime = Date.parse(evidence.requestAt);
  const staffTime = Date.parse(evidence.staffAt);
  if (
    !Number.isFinite(requestTime) ||
    !Number.isFinite(staffTime) ||
    staffTime <= requestTime ||
    staffTime - requestTime > CROSS_THREAD_REPLY_WINDOW_MS
  ) {
    return false;
  }

  const matchingStay = evidence.requestDates.some((requestDate) =>
    evidence.outcomeDates.some(
      (outcomeDate) =>
        outcomeDate.arrival === requestDate.arrival &&
        outcomeDate.departure === requestDate.departure,
    ),
  );
  if (!matchingStay) return false;

  const partyNames = [evidence.party?.company, evidence.party?.agency]
    .filter((value): value is string => Boolean(value))
    .map(normalisePartyName)
    .filter((name) => name.length >= 5);
  if (!partyNames.length) return false;
  const requestKey = normalisePartyName(evidence.requestText);
  if (partyNames.some((name) => requestKey.includes(name))) return true;

  const domainLabels = evidence.senderDomain?.toLowerCase().split('.').filter(Boolean) ?? [];
  const countryCodeSecondLevel =
    domainLabels.at(-1)?.length === 2 &&
    ['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'].includes(domainLabels.at(-2) ?? '');
  const domainLabel = domainLabels.at(countryCodeSecondLevel ? -3 : -2);
  if (!domainLabel) return false;
  const domainKey = normalisePartyName(domainLabel);
  return partyNames.some(
    (name) =>
      name === domainKey || name.split(' ').some((word) => word.length >= 5 && word === domainKey),
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || null;
}

function dateParts(year: number, month: number, day: number): string | null {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function parseDateToken(value: string, defaultYear?: number): string | null {
  const text = value.replace(/,/gu, '').trim();
  const numeric = text.match(/^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/u);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const third = Number(numeric[3]);
    if ((numeric[1]?.length ?? 0) === 4) return dateParts(first, second, third);
    let year = third < 100 ? 2000 + third : third;
    let month = second;
    let day = first;
    if (first <= 12 && second > 12) {
      month = first;
      day = second;
    }
    if (numeric[3]?.length === 2) year = 2000 + third;
    return dateParts(year, month, day);
  }

  const monthNames: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const dayFirst = text.match(/^(\d{1,2})[-\s]+([a-z]+)(?:[-\s]+(\d{2,4}))?$/iu);
  const monthFirst = text.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?$/iu);
  const match = dayFirst ?? monthFirst;
  if (match) {
    const isDayFirst = match === dayFirst;
    const day = Number(isDayFirst ? match[1] : match[2]);
    const monthText = (isDayFirst ? match[2] : match[1]).toLowerCase();
    const month = monthNames[monthText];
    const rawYear = isDayFirst ? match[3] : match[3];
    const parsedYear = rawYear ? Number(rawYear) : defaultYear;
    if (!month || !parsedYear) return null;
    const year = rawYear && rawYear.length === 2 ? 2000 + parsedYear : parsedYear;
    return dateParts(year, month, day);
  }
  return null;
}

const MONTH_TOKEN =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_TOKEN = String.raw`(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[-\s]+${MONTH_TOKEN}[-\s]+\d{2,4}|${MONTH_TOKEN}\s+\d{1,2},?\s+\d{2,4})`;

function datePairsFromText(text: string, defaultYear?: number): GoldenDate[] {
  const patterns = [
    new RegExp(
      String.raw`(?:arrival(?:\s+date)?|check[\s-]?in)\s*[:=]?\s*(${DATE_TOKEN})[\s\S]{0,200}?(?:departure(?:\s+date)?|check[\s-]?out)\s*[:=]?\s*(${DATE_TOKEN})`,
      'iu',
    ),
    new RegExp(
      String.raw`(?:from|between)\s+(${DATE_TOKEN})[\s\S]{0,80}?(?:to|until|through|and)\s+(${DATE_TOKEN})`,
      'iu',
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1] || !match[2]) continue;
    const arrival = parseDateToken(match[1], defaultYear);
    const departure = parseDateToken(match[2], defaultYear);
    if (arrival && departure) return [{ arrival, departure }];
  }
  return [];
}

function titleCaseRoomType(value: string): string {
  return value
    .replace(/\brooms?\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .map((word) => (word ? `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}` : word))
    .join(' ');
}

function parseMoney(value: string): string | null {
  let amount = value
    .trim()
    .replace(/^(?:ZAR|R)\s*/iu, '')
    .replace(/[\s ]/gu, '');
  if (!/\d/u.test(amount)) return null;
  if (amount.includes(',') && amount.includes('.')) {
    amount =
      amount.lastIndexOf(',') > amount.lastIndexOf('.')
        ? amount.replace(/\./gu, '').replace(',', '.')
        : amount.replace(/,/gu, '');
  } else if (amount.includes(',')) {
    const tail = amount.split(',').at(-1) ?? '';
    amount = tail.length <= 2 ? amount.replace(',', '.') : amount.replace(/,/gu, '');
  }
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null;
}

function partyField(lines: readonly string[], field: 'company' | 'agency'): string | null {
  const pattern =
    field === 'company'
      ? /^\s*(?:company|company name|client company)\s*[:=-]\s*(.+?)\s*$/iu
      : /^\s*(?:agency|travel agent|booking agent)\s*[:=-]\s*(.+?)\s*$/iu;
  for (const line of lines) {
    const value = pattern.exec(line)?.[1];
    const clean = cleanText(
      value?.split('|')[0]?.replace(/[<>]?\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, ''),
    );
    if (clean) return clean;
  }
  return null;
}

export function parseOfferPdfAnswer(
  text: string,
  sentAt?: string,
): Omit<
  GoldenAnswer,
  | 'conf'
  | 'confirmation_numbers'
  | 'change_type'
  | 'change_types'
  | 'hms'
  | 'status'
  | 'cancellation_reply'
  | 'skip'
> {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const flatText = lines.join('\n');
  const defaultYear = sentAt ? new Date(sentAt).getUTCFullYear() : undefined;
  const dates = datePairsFromText(flatText, defaultYear);
  const roomTypePattern =
    '(?:(?:standard|deluxe|superior|executive|classic|luxury|accessible|family)\\s+)?(?:single|double|twin|king|queen|suite|family)';
  const rooms: GoldenRoom[] = [];
  let explicitRoomCount: number | null = null;
  for (const line of lines) {
    const countFirst =
      new RegExp(String.raw`\b(\d{1,3})\s*[x×]?\s*(${roomTypePattern})\s+rooms?\b`, 'iu').exec(
        line,
      ) ?? new RegExp(String.raw`\b(\d{1,3})\s*[x×]\s*(${roomTypePattern})\b`, 'iu').exec(line);
    const typeFirst = new RegExp(
      String.raw`\b(${roomTypePattern})\s*(?:rooms?\s*)?[x×:]\s*(\d{1,3})\b`,
      'iu',
    ).exec(line);
    const labeledType = new RegExp(
      String.raw`(?:room|accommodation)\s+(?:type|category)\s*[:=\-]\s*(${roomTypePattern})\b`,
      'iu',
    ).exec(line);
    if (countFirst?.[1] && countFirst[2]) {
      rooms.push({ count: Number(countFirst[1]), room_type: titleCaseRoomType(countFirst[2]) });
      continue;
    }
    if (typeFirst?.[1] && typeFirst[2]) {
      rooms.push({ count: Number(typeFirst[2]), room_type: titleCaseRoomType(typeFirst[1]) });
      continue;
    }
    const roomCount = /\b(?:total\s+)?(?:no\.?\s+of\s+)?rooms?\s*[:=-]\s*(\d{1,3})\b/iu.exec(line);
    if (roomCount?.[1]) explicitRoomCount = Number(roomCount[1]);
    if (labeledType?.[1]) rooms.push({ count: null, room_type: titleCaseRoomType(labeledType[1]) });
  }
  if (explicitRoomCount !== null && rooms.length === 1 && rooms[0]?.count === null) {
    rooms[0] = { ...rooms[0], count: explicitRoomCount };
  }
  if (!rooms.length && explicitRoomCount !== null) {
    rooms.push({ count: explicitRoomCount, room_type: null });
  }
  const knownRoomCounts = rooms.map((room) => room.count);
  const roomCount =
    explicitRoomCount ??
    (knownRoomCounts.length && knownRoomCounts.every((count) => count !== null)
      ? knownRoomCounts.reduce<number>((total, count) => total + (count ?? 0), 0)
      : null);

  let board: string | null = null;
  const boardLine = lines.find((line) => /^(?:board|meal\s+plan|basis)\s*[:=-]/iu.test(line));
  if (boardLine) {
    board = cleanText(boardLine.replace(/^(?:board|meal\s+plan|basis)\s*[:=-]\s*/iu, ''));
  } else if (/\b(?:dinner\s*,?\s*bed\s*(?:&|and)\s*breakfast|\bdbb\b)/iu.test(flatText)) {
    board = 'Dinner, Bed & Breakfast';
  } else if (/\b(?:bed\s*(?:&|and)\s*breakfast|b\s*&\s*b|\bbb\b)/iu.test(flatText)) {
    board = 'Bed & Breakfast';
  } else if (/\broom\s+only\b/iu.test(flatText)) {
    board = 'Room Only';
  }

  const ratePlanMatch =
    /\b(?:rate\s*(?:plan|code|type)|rateplan|ratecode)\s*[:#=-]?\s*([A-Z0-9][A-Z0-9_-]{1,15})\b/iu.exec(
      flatText,
    );
  let total: string | null = null;
  for (const line of lines) {
    if (!/\b(?:grand\s+)?total(?:\s+(?:amount|price|accommodation))?\b/iu.test(line)) continue;
    if (/\b(?:rooms?|nights?|guests?|adults?|children)\b/iu.test(line)) continue;
    const value = /(?:ZAR|R)\s*[0-9][0-9 ,.\u00a0]*/iu.exec(line);
    if (value?.[0]) total = parseMoney(value[0]);
    if (total) break;
  }

  const company = partyField(lines, 'company');
  const agency = partyField(lines, 'agency');
  return {
    dates,
    rooms,
    room_count: roomCount,
    room_type: rooms.find((room) => room.room_type)?.room_type ?? null,
    board,
    party: { company, agency },
    rate_plan: cleanText(ratePlanMatch?.[1])?.toUpperCase() ?? null,
    total,
  };
}

export function inferChangeTypes(text: string): ChangeType[] {
  const changeTypes: ChangeType[] = [];
  if (
    /\b(?:date|dates|arrival|departure|check[\s-]?in|check[\s-]?out|night|extend|extension|shorten|early|later)\b/iu.test(
      text,
    )
  ) {
    changeTypes.push('dates');
  }
  if (
    /\b(?:room|rooms|room\s+type|bed|occupancy|add\s+(?:a\s+)?room|remove\s+(?:a\s+)?room)\b/iu.test(
      text,
    )
  ) {
    changeTypes.push('rooms');
  }
  if (/\b(?:guest\s+name|names?|spelling|rename|replace\s+(?:the\s+)?guest)\b/iu.test(text)) {
    changeTypes.push('names');
  }
  return changeTypes.length ? changeTypes : ['other'];
}

function candidatePreferred(candidate: GoldenCandidate, cutoff: string): boolean {
  return Boolean(candidate.stay_date && candidate.stay_date >= cutoff);
}

function outputCandidate(candidate: GoldenCandidate): GoldenRow {
  const {
    sender_domain: _senderDomain,
    stay_date: _stayDate,
    received_at: _receivedAt,
    ...row
  } = candidate;
  return row;
}

export function selectDiverseGoldenRows(
  candidates: readonly GoldenCandidate[],
  targets: Partial<Record<GoldenClass, number>> = TARGET_COUNTS,
  cutoff = HMS_WINDOW_START,
): GoldenSelection {
  const targetCounts = Object.fromEntries(
    GOLDEN_CLASSES.map((mailClass) => [mailClass, targets[mailClass] ?? TARGET_COUNTS[mailClass]]),
  ) as Record<GoldenClass, number>;
  const availableByClass = Object.fromEntries(
    GOLDEN_CLASSES.map((mailClass) => [mailClass, 0]),
  ) as Record<GoldenClass, number>;
  const eligibleByClass = { ...availableByClass };
  const selectedByClass = { ...availableByClass };
  const uniqueByClass = new Map<GoldenClass, Map<string, GoldenCandidate>>();
  const uniqueByMessage = new Map<string, GoldenCandidate>();
  for (const candidate of candidates) {
    const previous = uniqueByMessage.get(candidate.message_id);
    if (!previous || CLASS_PRIORITY[candidate.class] < CLASS_PRIORITY[previous.class]) {
      uniqueByMessage.set(candidate.message_id, candidate);
    }
  }
  for (const candidate of uniqueByMessage.values()) {
    const group = uniqueByClass.get(candidate.class) ?? new Map<string, GoldenCandidate>();
    group.set(candidate.message_id, candidate);
    uniqueByClass.set(candidate.class, group);
  }

  const rows: GoldenRow[] = [];
  for (const mailClass of GOLDEN_CLASSES) {
    const ordered = [...(uniqueByClass.get(mailClass)?.values() ?? [])].sort((left, right) => {
      const leftPreferred = candidatePreferred(left, cutoff);
      const rightPreferred = candidatePreferred(right, cutoff);
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      if (left.received_at !== right.received_at) {
        return right.received_at.localeCompare(left.received_at);
      }
      return left.message_id.localeCompare(right.message_id);
    });
    availableByClass[mailClass] = ordered.length;
    const domains = new Map<string, number>();
    const diverse: GoldenCandidate[] = [];
    for (const candidate of ordered) {
      const domain = candidate.sender_domain ?? 'unknown-domain';
      const count = domains.get(domain) ?? 0;
      if (count >= 2) continue;
      domains.set(domain, count + 1);
      diverse.push(candidate);
    }
    eligibleByClass[mailClass] = diverse.length;
    const chosen = diverse.slice(0, Math.max(0, targetCounts[mailClass]));
    selectedByClass[mailClass] = chosen.length;
    rows.push(...chosen.map(outputCandidate));
  }
  return { rows, availableByClass, eligibleByClass, selectedByClass, targets: targetCounts };
}

function newClassScore(): ClassScore {
  return {
    count: 0,
    action: { correct: 0, total: 0 },
    dates: { correct: 0, total: 0 },
    confirmation: { correct: 0, total: 0 },
    rooms: { correct: 0, total: 0 },
    party: { correct: 0, total: 0 },
  };
}

function addMetric(metric: MetricCount, correct: boolean): void {
  metric.total += 1;
  if (correct) metric.correct += 1;
}

function canonicalDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return parseDateToken(text) ?? text;
}

function datePairs(value: unknown): GoldenDate[] {
  if (Array.isArray(value)) {
    const pairs: GoldenDate[] = [];
    for (const item of value) {
      const row = asRecord(item);
      const arrival = canonicalDate(row.arrival ?? row.checkIn ?? row.check_in);
      const departure = canonicalDate(row.departure ?? row.checkOut ?? row.check_out);
      if (arrival && departure) pairs.push({ arrival, departure });
    }
    return pairs;
  }
  const row = asRecord(value);
  const arrival = canonicalDate(row.arrival ?? row.checkIn ?? row.check_in);
  const departure = canonicalDate(row.departure ?? row.checkOut ?? row.check_out);
  return arrival && departure ? [{ arrival, departure }] : [];
}

function answerDates(answer: GoldenAnswer): GoldenDate[] {
  return datePairs(answer.dates);
}

function predictionDates(prediction: JsonRecord): GoldenDate[] {
  const fromPrediction = datePairs(prediction.dates ?? prediction.stays);
  if (fromPrediction.length) return fromPrediction;
  return datePairs({
    arrival: prediction.arrival ?? prediction.check_in ?? prediction.checkIn,
    departure: prediction.departure ?? prediction.check_out ?? prediction.checkOut,
  });
}

function normalizedDateSet(dates: readonly GoldenDate[]): string[] {
  return [...new Set(dates.map((date) => `${date.arrival}/${date.departure}`))].sort();
}

function stringValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === 'string' || typeof item === 'number') {
      const clean = cleanText(String(item));
      return clean ? [clean] : [];
    }
    const record = asRecord(item);
    const text = cleanText(record.number ?? record.conf ?? record.confirmation_number);
    return text ? [text] : [];
  });
}

function answerOutcomeConfirmationNumbers(answer: GoldenAnswer): string[] {
  return [
    ...new Set([
      ...stringValues(answer.confirmation_numbers),
      ...stringValues(answer.conf),
    ]),
  ].sort();
}

function answerExtractedConfirmationNumbers(answer: GoldenAnswer): string[] | null {
  if (!Array.isArray(answer.extracted_confirmation_numbers)) return null;
  return [...new Set(stringValues(answer.extracted_confirmation_numbers))].sort();
}

function predictionConfirmationNumbers(prediction: JsonRecord): string[] {
  return [
    ...new Set([
      ...stringValues(prediction.confirmation_numbers ?? prediction.confirmationNumbers),
      ...stringValues(
        prediction.conf ?? prediction.confirmation_number ?? prediction.confirmationNumber,
      ),
    ]),
  ].sort();
}

function answerRoomCount(answer: GoldenAnswer): number | null {
  if (typeof answer.room_count === 'number' && Number.isFinite(answer.room_count)) {
    return answer.room_count;
  }
  if (!Array.isArray(answer.rooms) || answer.rooms.length === 0) return null;
  const counts = answer.rooms.map((room) => room.count);
  return counts.every((count) => typeof count === 'number' && Number.isFinite(count))
    ? counts.reduce<number>((total, count) => total + (count ?? 0), 0)
    : null;
}

function predictionRoomCount(prediction: JsonRecord): number | null {
  const direct = prediction.room_count ?? prediction.rooms_count ?? prediction.roomCount;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string' && /^\d+$/u.test(direct.trim())) return Number(direct);
  if (typeof prediction.rooms === 'number' && Number.isFinite(prediction.rooms)) {
    return prediction.rooms;
  }
  if (typeof prediction.rooms === 'string' && /^\d+$/u.test(prediction.rooms.trim())) {
    return Number(prediction.rooms);
  }
  if (!Array.isArray(prediction.rooms) || prediction.rooms.length === 0) return null;
  const counts = prediction.rooms.map((room) => {
    const record = asRecord(room);
    const count = record.count ?? record.rooms ?? record.quantity;
    if (typeof count === 'number' && Number.isFinite(count)) return count;
    return typeof count === 'string' && /^\d+$/u.test(count.trim()) ? Number(count) : null;
  });
  return counts.every((count) => count !== null)
    ? counts.reduce<number>((total, count) => total + (count ?? 0), 0)
    : null;
}

type PartyRole = 'company' | 'agency';
type NormalizedPartyRoles = Record<PartyRole, string[]> & { untyped: string[] };

function normalizedPartyNames(value: unknown): string[] {
  const names = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate === 'string') {
      const clean = cleanText(candidate);
      if (clean) names.add(normalisePartyName(clean));
    } else if (Array.isArray(candidate)) {
      for (const value of candidate) add(value);
    } else if (candidate && typeof candidate === 'object') {
      const record = asRecord(candidate);
      add(record.name ?? record.partyName ?? record.party_name);
    }
  };
  add(value);
  return [...names].filter(Boolean);
}

function answerPartyRoles(answer: GoldenAnswer): NormalizedPartyRoles {
  const party = asRecord(answer.party);
  return {
    company: normalizedPartyNames(party.company),
    agency: normalizedPartyNames(party.agency),
    untyped: [],
  };
}

function predictionPartyRoles(prediction: JsonRecord): NormalizedPartyRoles {
  const party = asRecord(prediction.party);
  return {
    company: normalizedPartyNames(
      party.company ??
        party.company_name ??
        party.companyName ??
        prediction.company ??
        prediction.company_name ??
        prediction.companyName ??
        prediction.endClient,
    ),
    agency: normalizedPartyNames(
      party.agency ??
        party.agency_name ??
        party.agencyName ??
        prediction.agency ??
        prediction.agency_name ??
        prediction.agencyName,
    ),
    untyped: [
      ...normalizedPartyNames(typeof prediction.party === 'string' ? prediction.party : party.name),
      ...normalizedPartyNames(prediction.party_name ?? prediction.partyName),
    ],
  };
}

function normalizeAction(value: unknown): GoldenClass | null {
  const action = cleanText(value)
    ?.toLowerCase()
    .replace(/[\s-]+/gu, '_');
  if (!action) return null;
  if (['quote', 'quote_availability'].includes(action)) return 'quote';
  if (
    ['create', 'booking', 'new_booking', 'create_reservation', 'new_reservation'].includes(action)
  ) {
    return 'create';
  }
  if (['amend', 'amendment', 'modify', 'amend_reservation'].includes(action)) return 'amend';
  if (['cancel', 'cancellation', 'cancel_reservation'].includes(action)) return 'cancel';
  if (['skip', 'no_action', 'none', 'system_notice', 'not_actionable'].includes(action))
    return 'skip';
  return null;
}

function predictionAction(prediction: JsonRecord): GoldenClass | null {
  return (
    normalizeAction(prediction.action) ??
    normalizeAction(prediction.kind) ??
    normalizeAction(prediction.skip === true ? 'skip' : null)
  );
}

function matchesSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length > 0 &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function matchesExactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sumClassScores(scores: readonly ClassScore[]): ClassScore {
  const overall = newClassScore();
  for (const score of scores) {
    overall.count += score.count;
    for (const field of ['action', 'dates', 'confirmation', 'rooms', 'party'] as const) {
      overall[field].correct += score[field].correct;
      overall[field].total += score[field].total;
    }
  }
  return overall;
}

export function scoreGoldenRows(
  goldenRows: readonly GoldenRow[],
  predictions: readonly GoldenPrediction[],
): GoldenScore {
  const predictionById = new Map<string, JsonRecord>();
  for (const prediction of predictions) {
    const messageId = cleanText(prediction.message_id);
    if (messageId) predictionById.set(messageId, prediction);
  }
  const byClass = Object.fromEntries(
    GOLDEN_CLASSES.map((mailClass) => [mailClass, newClassScore()]),
  ) as Record<GoldenClass, ClassScore>;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const row of goldenRows) {
    const score = byClass[row.class];
    const prediction = predictionById.get(row.message_id) ?? {};
    const predictedAction = predictionAction(prediction);
    score.count += 1;
    addMetric(score.action, predictedAction === row.class);

    const expectedDates = answerDates(row.answer);
    if (expectedDates.length) {
      addMetric(
        score.dates,
        matchesSet(
          normalizedDateSet(expectedDates),
          normalizedDateSet(predictionDates(prediction)),
        ),
      );
    }

    const explicitExtractedConfirmations = answerExtractedConfirmationNumbers(row.answer);
    const expectedConfirmations =
      explicitExtractedConfirmations ?? answerOutcomeConfirmationNumbers(row.answer);
    if (explicitExtractedConfirmations !== null || expectedConfirmations.length) {
      addMetric(
        score.confirmation,
        matchesExactSet(expectedConfirmations, predictionConfirmationNumbers(prediction)),
      );
    }

    const expectedRooms = answerRoomCount(row.answer);
    if (expectedRooms !== null) {
      addMetric(score.rooms, predictionRoomCount(prediction) === expectedRooms);
    }

    const expectedParty = answerPartyRoles(row.answer);
    const expectedPartyRoles = (['company', 'agency'] as const).filter(
      (role) => expectedParty[role].length > 0,
    );
    if (expectedPartyRoles.length) {
      const predictedParty = predictionPartyRoles(prediction);
      addMetric(
        score.party,
        expectedPartyRoles.every((role) => {
          const predictedNames = predictedParty[role].length
            ? predictedParty[role]
            : expectedPartyRoles.length === 1
              ? predictedParty.untyped
              : [];
          return expectedParty[role].some((name) => predictedNames.includes(name));
        }),
      );
    }

    const goldIsSkip = row.class === 'skip';
    const predictedSkip = predictedAction === 'skip';
    if (goldIsSkip && predictedSkip) truePositive += 1;
    else if (!goldIsSkip && predictedSkip) falsePositive += 1;
    else if (goldIsSkip && !predictedSkip) falseNegative += 1;
  }

  return {
    byClass,
    overall: sumClassScores(GOLDEN_CLASSES.map((mailClass) => byClass[mailClass])),
    skip: {
      true_positive: truePositive,
      false_positive: falsePositive,
      false_negative: falseNegative,
      precision: { correct: truePositive, total: truePositive + falsePositive },
      recall: { correct: truePositive, total: truePositive + falseNegative },
    },
  };
}

type CorpusMessage = JsonRecord & {
  id: string;
  thread_id: string;
  direction: string;
  from_address?: string | null;
  subject?: string | null;
  body?: string | null;
  body_is_html?: boolean;
  sent_at?: string | null;
  received_at?: string | null;
};

type StaffPdf = {
  attachment_id: string;
  message_id: string;
  file_name: string;
  kind: 'offer' | 'confirmation' | 'other';
  text: string;
  conf: string | null;
};

export type SelectionMetadata = {
  class: GoldenClass;
  target: number;
  evidence_candidates: number;
  after_domain_cap: number;
  selected: number;
};

export type HmsNeededFile = {
  conf_numbers: string[];
  selection: SelectionMetadata[];
  golden_sha256: string;
};

function isObjectValue(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    return null;
  }
  return value.map((item) => (item as string).trim());
}

function hasConfirmationNumber(answer: GoldenAnswer): boolean {
  const conf = cleanText(answer.conf);
  return Boolean(conf && /^\d{8}-\d{1,3}$/u.test(conf));
}

function hasHmsAnswer(answer: JsonRecord): boolean {
  return 'hms' in answer && (answer.hms === null || isObjectValue(answer.hms));
}

function hasSupportingEvidence(evidence: JsonRecord): boolean {
  const staffMessageIds = stringArray(evidence.staff_message_ids) ?? [];
  const pdfFiles = stringArray(evidence.pdf_files) ?? [];
  const staffQuoteRunIds = stringArray(evidence.staff_quote_run_ids) ?? [];
  const hmsReadIds = stringArray(evidence.hms_read_ids) ?? [];
  const hmsTruth = asRecord(evidence.hms_truth);
  const hmsTruthPointer =
    cleanText(hmsTruth.source) && /^\d{8}-\d{1,3}$/u.test(cleanText(hmsTruth.conf) ?? '');
  return Boolean(
    staffMessageIds.length ||
      pdfFiles.length ||
      staffQuoteRunIds.length ||
      hmsReadIds.length ||
      hmsTruthPointer,
  );
}

function isValidGoldenAnswer(mailClass: GoldenClass, answer: GoldenAnswer): boolean {
  if (mailClass === 'skip') return answer.skip === true;
  if (mailClass === 'quote') {
    const party = answerPartyRoles(answer);
    return Boolean(
      answerDates(answer).length ||
        answerRoomCount(answer) !== null ||
        cleanText(answer.room_type) ||
        cleanText(answer.board) ||
        party.company.length ||
        party.agency.length ||
        cleanText(answer.rate_plan) ||
        cleanText(answer.total),
    );
  }
  if (mailClass === 'create' || mailClass === 'amend' || mailClass === 'cancel') {
    const extractedConfirmations = stringArray(answer.extracted_confirmation_numbers);
    if (
      !extractedConfirmations ||
      extractedConfirmations.some((conf) => !/^\d{8}-\d{1,3}$/u.test(conf))
    ) {
      return false;
    }
  }
  if (!hasConfirmationNumber(answer) || !hasHmsAnswer(answer)) return false;
  if (mailClass === 'create') return true;
  if (mailClass === 'amend') {
    return Boolean(
      (Array.isArray(answer.change_types) &&
        answer.change_types.length > 0 &&
        answer.change_types.every((value) =>
          ['dates', 'rooms', 'names', 'other'].includes(value),
        )) ||
        (typeof answer.change_type === 'string' &&
          ['dates', 'rooms', 'names', 'other'].includes(answer.change_type)),
    );
  }
  const cancellationReply = asRecord(answer.cancellation_reply);
  return Boolean(
    typeof cancellationReply.confirmed === 'boolean' &&
      cancellationReply.confirmation_number === answer.conf &&
      (cancellationReply.confirmed || cleanText(answer.status)?.toLowerCase().includes('cancel')),
  );
}

export function parseGoldenRow(value: unknown, rowNumber = 1): GoldenRow {
  const row = asRecord(value);
  const messageId = cleanText(row.message_id);
  const mailClass = cleanText(row.class);
  const answer = asRecord(row.answer);
  const evidence = asRecord(row.evidence);
  const evidenceMessageId = cleanText(evidence.inbound_message_id);
  const staffMessageIds = stringArray(evidence.staff_message_ids);
  const pdfFiles = stringArray(evidence.pdf_files);
  const quoteRunIds =
    evidence.staff_quote_run_ids === undefined ? [] : stringArray(evidence.staff_quote_run_ids);
  const hmsReadIds = evidence.hms_read_ids === undefined ? [] : stringArray(evidence.hms_read_ids);
  const source = asRecord(evidence.source_classification);
  const hmsTruth = asRecord(evidence.hms_truth);
  const hmsTruthIsValid =
    evidence.hms_truth === undefined ||
    evidence.hms_truth === null ||
    Boolean(cleanText(hmsTruth.source) && /^\d{8}-\d{1,3}$/u.test(cleanText(hmsTruth.conf) ?? ''));
  const sourceIsValid =
    evidence.source_classification === undefined ||
    Boolean(
      cleanText(source.kind) &&
        cleanText(source.reason) &&
        (source.source === null ||
          source.source === undefined ||
          typeof source.source === 'string'),
    );
  const validClass = mailClass && GOLDEN_CLASSES.includes(mailClass as GoldenClass);
  const answerIsObject = isObjectValue(row.answer);
  const evidenceIsObject = isObjectValue(row.evidence);
  const parsedAnswer = answer as GoldenAnswer;
  const parsedEvidence = evidence as GoldenEvidence;
  const sourcePointerIsValid =
    mailClass === 'skip'
      ? Boolean(cleanText(source.kind) && source.kind !== 'direct' && cleanText(source.reason))
      : hasSupportingEvidence(evidence);

  if (
    !messageId ||
    !validClass ||
    !answerIsObject ||
    !evidenceIsObject ||
    evidenceMessageId !== messageId ||
    !staffMessageIds ||
    !pdfFiles ||
    !quoteRunIds ||
    !hmsReadIds ||
    !sourceIsValid ||
    !hmsTruthIsValid ||
    !sourcePointerIsValid ||
    !isValidGoldenAnswer(mailClass as GoldenClass, parsedAnswer)
  ) {
    throw new Error(
      `golden-v1.jsonl row ${rowNumber} is missing a valid answer or evidence pointer`,
    );
  }
  return {
    message_id: messageId,
    class: mailClass as GoldenClass,
    answer: parsedAnswer,
    evidence: parsedEvidence,
  };
}

export function parseHmsNeededFile(value: unknown): HmsNeededFile {
  const record = asRecord(value);
  const confNumbers = stringArray(record.conf_numbers);
  if (
    !confNumbers ||
    confNumbers.some((conf) => !/^\d{8}-\d{1,3}$/u.test(conf)) ||
    new Set(confNumbers).size !== confNumbers.length ||
    typeof record.golden_sha256 !== 'string' ||
    !/^[A-F0-9]{64}$/iu.test(record.golden_sha256) ||
    !Array.isArray(record.selection)
  ) {
    throw new Error('golden-v1-hms-needed.json manifest is malformed');
  }
  const selection: SelectionMetadata[] = [];
  for (const value of record.selection) {
    const row = asRecord(value);
    const mailClass = cleanText(row.class);
    const counts = [row.target, row.evidence_candidates, row.after_domain_cap, row.selected];
    if (
      !mailClass ||
      !GOLDEN_CLASSES.includes(mailClass as GoldenClass) ||
      !counts.every((count) => Number.isInteger(count) && (count as number) >= 0) ||
      (row.after_domain_cap as number) > (row.evidence_candidates as number) ||
      (row.selected as number) > (row.after_domain_cap as number) ||
      (row.selected as number) > (row.target as number)
    ) {
      throw new Error('golden-v1-hms-needed.json manifest is malformed');
    }
    selection.push({
      class: mailClass as GoldenClass,
      target: row.target as number,
      evidence_candidates: row.evidence_candidates as number,
      after_domain_cap: row.after_domain_cap as number,
      selected: row.selected as number,
    });
  }
  if (
    selection.length !== GOLDEN_CLASSES.length ||
    new Set(selection.map((row) => row.class)).size !== GOLDEN_CLASSES.length
  ) {
    throw new Error('golden-v1-hms-needed.json manifest is malformed');
  }
  return { conf_numbers: confNumbers, selection, golden_sha256: record.golden_sha256 };
}

export function assertHmsNeededMatchesGolden(
  rows: readonly GoldenRow[],
  hmsNeeded: HmsNeededFile,
): void {
  const counts = Object.fromEntries(GOLDEN_CLASSES.map((mailClass) => [mailClass, 0])) as Record<
    GoldenClass,
    number
  >;
  for (const row of rows) {
    counts[row.class] += 1;
  }
  const selectedByClass = new Map(hmsNeeded.selection.map((row) => [row.class, row.selected]));
  const expectedMissing = missingHmsConfirmations(rows);
  const actualMissing = [...hmsNeeded.conf_numbers].sort();
  if (
    GOLDEN_CLASSES.some((mailClass) => selectedByClass.get(mailClass) !== counts[mailClass]) ||
    expectedMissing.length !== actualMissing.length ||
    expectedMissing.some((conf, index) => conf !== actualMissing[index]) ||
    hmsNeeded.golden_sha256 !== goldenRowsSha256(rows)
  ) {
    throw new Error(
      'HMS-needed manifest does not match golden-v1.jsonl; rerun select to regenerate both',
    );
  }
}

export function missingHmsConfirmations(rows: readonly GoldenRow[]): string[] {
  const missing = new Set<string>();
  for (const row of rows) {
    if (row.class === 'quote' || row.class === 'skip' || answerHasSuccessfulHmsTruth(row.answer)) {
      continue;
    }
    const conf = rowConf(row);
    if (conf) missing.add(conf);
  }
  return [...missing].sort();
}

function answerHasSuccessfulHmsTruth(answer: GoldenAnswer): boolean {
  return [answer.hms, answer.hmsCurrent].some(
    (truth) => truth !== null && truth !== undefined && isSuccessfulHmsRead(truth),
  );
}

function parseJsonLines(source: string, label: string): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${label} has invalid JSON on line ${index + 1}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} line ${index + 1} must be a JSON object`);
    }
    rows.push(parsed as JsonRecord);
  }
  return rows;
}

async function readJsonl(file: string): Promise<JsonRecord[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new Error(`Could not read ${basename(file)}`);
  }
  let source: string;
  try {
    source = file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  } catch {
    throw new Error(`${basename(file)} is not valid gzip data`);
  }
  return parseJsonLines(source, basename(file));
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new Error(`${basename(file)} is not valid JSON`);
  }
}

function serializeJsonLines(rows: readonly unknown[]): string {
  const contents = rows.map((row) => JSON.stringify(row) ?? 'null').join('\n');
  return contents ? `${contents}\n` : '';
}

export function goldenRowsSha256(rows: readonly GoldenRow[]): string {
  return createHash('sha256').update(serializeJsonLines(rows)).digest('hex');
}

function plainTextBody(message: CorpusMessage): string {
  const body = typeof message.body === 'string' ? message.body : '';
  if (message.body_is_html !== true) return body;
  return body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<\s*blockquote\b[^>]*>/giu, '\n> ')
    .replace(/<\s*br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|table|blockquote|h[1-6]|section)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[ \t]+\n/gu, '\n');
}

function authoredBodyText(message: CorpusMessage): string {
  const body = plainTextBody(message);
  const authored = body.split(
    /(?:^\s*from\s*:|^\s*sent\s*:|^\s*to\s*:|^\s*subject\s*:|^\s*-{2,}\s*original message|^\s*on .{2,160} wrote:|^\s*>)/imu,
    1,
  )[0];
  return authored?.trim() ?? body.trim();
}

function requestText(message: CorpusMessage): string {
  const body = plainTextBody(message);
  const unquoted = body.split(
    /(?:^\s*from\s*:|^\s*sent\s*:|^\s*to\s*:|^\s*subject\s*:|^\s*-{2,}\s*original message|^\s*on .{2,160} wrote:)/imu,
    1,
  )[0];
  return `${cleanText(message.subject) ?? ''}\n${unquoted ?? body}`.trim();
}

function senderDomain(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@((?:[A-Z0-9-]+\.)+[A-Z]{2,})/iu);
  return match?.[1]?.toLowerCase().replace(/\.$/u, '') ?? null;
}

function domainMatches(domain: string | null, registered: string): boolean {
  return Boolean(domain && (domain === registered || domain.endsWith(`.${registered}`)));
}

function isStaffMessage(message: CorpusMessage): boolean {
  return domainMatches(senderDomain(message.from_address), 'legacyhotels.co.za');
}

function explicitCancellationRequest(text: string): boolean {
  return /\b(?:please|kindly|can you|could you|would you|i would like to|i'd like to|we would like to|we'd like to|request(?:ing)? to)\b[\s\S]{0,60}\bcancel(?:l?ation)?\b/iu.test(
    text,
  );
}

function systemCancellationNotice(text: string): boolean {
  if (explicitCancellationRequest(text)) return false;
  return /\b(?:cancell?ation\s+(?:notice|notification|alert|confirmation)|(?:booking|reservation)\s+(?:was|has been|is)\s+cancell?ed|cancell?ed\s+(?:by|through)\s+(?:the\s+)?(?:supplier|channel|airline|system))\b/iu.test(
    text,
  );
}

function sourceClassification(message: CorpusMessage): MailSourceClassification {
  const text = requestText(message);
  const source = classifyMailSource({
    fromAddress: cleanText(message.from_address),
    subject: message.subject,
    bodyText: plainTextBody(message),
  });
  if (source.kind !== 'direct') return source;

  const domain = senderDomain(message.from_address);
  if (KNOWN_NON_DIRECT_DOMAINS.some((registered) => domainMatches(domain, registered))) {
    const system = [
      'reviewpro.com',
      'trustyou.com',
      'tripadvisor.com',
      'revinate.com',
      'medallia.com',
    ].some((registered) => domainMatches(domain, registered));
    return {
      kind: system ? 'system' : 'channel',
      source: system ? 'Known system sender' : 'Known channel sender',
      reason: 'known_sender_domain',
    };
  }
  if (systemCancellationNotice(text)) {
    return {
      kind: 'system',
      source: 'Cancellation notification',
      reason: 'system_cancellation_notification',
    };
  }
  return source;
}

function messageTime(message: Pick<CorpusMessage, 'received_at' | 'sent_at'>): string {
  return cleanText(message.received_at) ?? cleanText(message.sent_at) ?? '';
}

function messageTimeMs(message?: Pick<CorpusMessage, 'received_at' | 'sent_at'>): number {
  if (!message) return 0;
  const timestamp = messageTime(message);
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function confirmationNumbersFromText(text: string): string[] {
  return [...new Set(text.match(/\b\d{8}-\d{1,3}\b/gu) ?? [])].sort();
}

export type CancellationReplyEvidence = {
  message_id: string;
  confirmation_numbers: readonly string[];
};

export type CancellationResolution = {
  conf: string;
  staff_message_ids: string[];
  confirmed: boolean;
};

export function resolveCancellationEvidence(
  requestText: string,
  replies: readonly CancellationReplyEvidence[],
  replyPdfConfNumbers: readonly (string | null)[] = [],
  hmsCancelledConfNumbers: readonly string[] = [],
): CancellationResolution | null {
  const requestedConfs = confirmationNumbersFromText(requestText);
  const explicitReplyConfs = [...new Set(replies.flatMap((reply) => reply.confirmation_numbers))];
  const pdfConfs = [
    ...new Set(replyPdfConfNumbers.filter((conf): conf is string => Boolean(conf))),
  ];
  const cancelledHmsConfs = [...new Set(hmsCancelledConfNumbers)];
  const requestSet = new Set(requestedConfs);

  let conf: string | undefined;
  if (requestedConfs.length === 1) {
    conf = requestedConfs[0];
  } else if (requestedConfs.length > 1) {
    const replyMatches = [...new Set(explicitReplyConfs.filter((value) => requestSet.has(value)))];
    if (replyMatches.length > 1) return null;
    if (replyMatches.length === 1) {
      conf = replyMatches[0];
    } else {
      const supported = [
        ...new Set([...pdfConfs, ...cancelledHmsConfs].filter((value) => requestSet.has(value))),
      ];
      if (supported.length !== 1) return null;
      conf = supported[0];
    }
  } else {
    if (explicitReplyConfs.length > 1) return null;
    if (explicitReplyConfs.length === 1) {
      conf = explicitReplyConfs[0];
    } else {
      const related = [...new Set([...pdfConfs, ...cancelledHmsConfs])];
      if (related.length !== 1) return null;
      conf = related[0];
    }
  }
  if (!conf) return null;

  const numberlessRepliesCanBeMatched =
    requestedConfs.length === 1 ||
    (requestedConfs.length > 1 &&
      explicitReplyConfs.every((value) => !requestSet.has(value)) &&
      new Set([...pdfConfs, ...cancelledHmsConfs].filter((value) => requestSet.has(value))).size ===
        1) ||
    (requestedConfs.length === 0 && new Set([...pdfConfs, ...cancelledHmsConfs]).size === 1);
  const matchedReplies = replies.filter(
    (reply) =>
      reply.confirmation_numbers.includes(conf!) ||
      (reply.confirmation_numbers.length === 0 && numberlessRepliesCanBeMatched),
  );
  const confirmedByHms = cancelledHmsConfs.includes(conf);
  if (!matchedReplies.length && !confirmedByHms) return null;
  return {
    conf,
    staff_message_ids: matchedReplies.map((reply) => reply.message_id),
    confirmed: matchedReplies.length > 0,
  };
}

export function extractConfirmationNumberFromFilename(fileName: string): string | null {
  return /(?:^|[^A-Z0-9])(\d{8}-\d{1,3})(?=$|[^A-Z0-9])/iu.exec(fileName)?.[1] ?? null;
}

function confirmationFromFile(fileName: string, text: string): string | null {
  const fromName = extractConfirmationNumberFromFilename(fileName);
  if (fromName) return fromName;
  const labeled =
    /\b(?:confirmation|conf|reservation)(?:\s*(?:number|no\.?|#|ref(?:erence)?))?\s*[:#=-]?\s*(\d{8}-\d{1,3})\b/iu.exec(
      text,
    )?.[1];
  return labeled ?? null;
}

function pdfKind(fileName: string): StaffPdf['kind'] {
  const normalized = fileName.toLowerCase();
  if (normalized.includes('hrcen_confirmation_letter')) return 'confirmation';
  if (normalized.includes('hrcen_offer_')) return 'offer';
  return 'other';
}

function isQuotePdf(document: StaffPdf): boolean {
  if (document.kind === 'offer') return true;
  const label = `${document.file_name}\n${document.text.slice(0, 3_000)}`;
  return (
    /\b(?:quote|quotation|offer)\b/iu.test(label) &&
    /(?:\bZAR\s*|\bR\s*)\d/iu.test(document.text) &&
    /\b(?:room|accommodation|rate|arrival|departure)\b/iu.test(document.text)
  );
}

async function resolvePdfTextRoot(): Promise<string | null> {
  let canonicalCorpusRoot: string;
  try {
    canonicalCorpusRoot = await realpath(CORPUS_ROOT);
  } catch {
    throw new Error('Could not resolve the private corpus directory');
  }
  let canonicalPdfTextRoot: string;
  try {
    canonicalPdfTextRoot = await realpath(`${CORPUS_ROOT}/pdftxt`);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw new Error('Could not resolve the private PDF text directory');
  }
  if (!isPathWithin(canonicalCorpusRoot, canonicalPdfTextRoot)) {
    throw new Error('Refusing to read PDF text outside the private corpus directory');
  }
  return canonicalPdfTextRoot;
}

async function readStaffPdfText(pdfTextRoot: string | null, attachmentId: string): Promise<string> {
  if (!isSafeAttachmentId(attachmentId)) {
    throw new Error('staff_pdfs.tsv contains an unsafe attachment identifier');
  }
  if (!pdfTextRoot) return '';
  const textPath = resolve(pdfTextRoot, `${attachmentId}.txt`);
  let canonicalTextPath: string;
  try {
    canonicalTextPath = await realpath(textPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return '';
    throw new Error('Could not resolve parsed staff PDF text');
  }
  if (!isPathWithin(pdfTextRoot, canonicalTextPath)) {
    throw new Error('Refusing to read PDF text outside the private corpus directory');
  }
  try {
    return await readFile(canonicalTextPath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return '';
    throw new Error('Could not read parsed staff PDF text');
  }
}

async function loadStaffPdfs(): Promise<{ byMessage: Map<string, StaffPdf[]>; all: StaffPdf[] }> {
  const [attachmentRows, manifestText] = await Promise.all([
    readJsonl(`${CORPUS_ROOT}/attachments.jsonl.gz`),
    readFile(`${CORPUS_ROOT}/staff_pdfs.tsv`, 'utf8').catch(() => {
      throw new Error('Could not read staff_pdfs.tsv');
    }),
  ]);
  const pdfTextRoot = await resolvePdfTextRoot();
  const filenames = new Map(
    attachmentRows.flatMap((row) => {
      const id = cleanText(row.id);
      const filename = cleanText(row.filename);
      return id && filename ? [[id, filename] as const] : [];
    }),
  );
  const byMessage = new Map<string, StaffPdf[]>();
  const all: StaffPdf[] = [];
  const manifestRows = manifestText.split(/\r?\n/u).filter(Boolean);
  for (const line of manifestRows) {
    const [attachmentId, messageId, suppliedPath] = line.split('\t');
    if (!attachmentId || !messageId) continue;
    if (!isSafeAttachmentId(attachmentId)) {
      throw new Error('staff_pdfs.tsv contains an unsafe attachment identifier');
    }
    const fileName = filenames.get(attachmentId) ?? basename(suppliedPath ?? 'staff-document.pdf');
    const text = await readStaffPdfText(pdfTextRoot, attachmentId);
    const kind = pdfKind(fileName);
    const document: StaffPdf = {
      attachment_id: attachmentId,
      message_id: messageId,
      file_name: basename(fileName),
      kind,
      text,
      conf: confirmationFromFile(fileName, text),
    };
    all.push(document);
    const messageDocuments = byMessage.get(messageId) ?? [];
    messageDocuments.push(document);
    byMessage.set(messageId, messageDocuments);
  }
  return { byMessage, all };
}

export function latestSucceededExtractions(rows: readonly JsonRecord[]): Map<string, JsonRecord> {
  const latest = new Map<string, JsonRecord>();
  for (const row of rows) {
    if (cleanText(row.status)?.toLowerCase() !== 'succeeded') continue;
    const messageId = cleanText(row.message_id);
    if (!messageId) continue;
    const createdAt = Date.parse(cleanText(row.created_at) ?? '');
    if (!Number.isFinite(createdAt)) continue;
    const previous = latest.get(messageId);
    const previousCreatedAt = Date.parse(cleanText(previous?.created_at) ?? '');
    const rowId = cleanText(row.id) ?? '';
    const previousId = cleanText(previous?.id) ?? '';
    if (
      !previous ||
      createdAt > previousCreatedAt ||
      (createdAt === previousCreatedAt && rowId > previousId)
    ) {
      latest.set(messageId, row);
    }
  }
  return latest;
}

function indexedThreads(messages: readonly CorpusMessage[]): Map<string, CorpusMessage[]> {
  const byThread = new Map<string, CorpusMessage[]>();
  for (const message of messages) {
    const values = byThread.get(message.thread_id) ?? [];
    values.push(message);
    byThread.set(message.thread_id, values);
  }
  for (const thread of byThread.values()) {
    thread.sort((left, right) => messageTimeMs(left) - messageTimeMs(right));
  }
  return byThread;
}

function nextStaffReplies(thread: readonly CorpusMessage[], messageId: string): CorpusMessage[] {
  const index = thread.findIndex((message) => message.id === messageId);
  if (index < 0) return [];
  const replies: CorpusMessage[] = [];
  for (const message of thread.slice(index + 1)) {
    if (message.direction?.toLowerCase() === 'inbound') break;
    if (message.direction?.toLowerCase() === 'outbound' && isStaffMessage(message))
      replies.push(message);
  }
  return replies;
}

const ASK_SIGNAL =
  /\?|\b(?:please|kindly|could you|can you|would you|may we|may i|would like|looking for|looking to|request(?:ing)?|require(?:d)?|need|advise|enquire|inquire|do you have|are there|is there|interested in|wish to|planning to|want to)\b/iu;
const QUOTE_LANGUAGE = /\b(?:quote|quotation|availability|available|tariff|rates?|prices?)\b/iu;
const LODGING_LANGUAGE =
  /\b(?:accommodation|hotel\s+room|rooms?|bedroom|overnight|stay|check[\s-]?in|check[\s-]?out|guest\s+room|room\s+block)\b/iu;
const CHANGE_LANGUAGE =
  /\b(?:amend(?:ment)?|change|modify|update|move|extend|extension|shorten|reduce|increase|add|remove|replace|correct|upgrade|downgrade|switch|revise)\b/iu;
const BOOKING_LANGUAGE =
  /\b(?:new\s+booking|booking|book|reservation|reserve|make\s+a\s+reservation)\b/iu;

function looksLikeQuoteRequest(message: CorpusMessage): boolean {
  const text = requestText(message);
  if (
    !text ||
    /\b(?:cancell?ation|amendment|payment\s+proof|invoice|complaint|guest\s+review)\b/iu.test(text)
  ) {
    return false;
  }
  const hasAsk = ASK_SIGNAL.test(text);
  const hasLodgingContext = LODGING_LANGUAGE.test(text) || datePairsFromText(text).length > 0;
  const availabilityAsk =
    /\b(?:do you have|are there|is there|check)\b[\s\S]{0,60}\b(?:room|availability|accommodation)\b/iu.test(
      text,
    );
  return hasAsk && hasLodgingContext && (QUOTE_LANGUAGE.test(text) || availabilityAsk);
}

function looksLikeBookingRequest(message: CorpusMessage): boolean {
  const text = requestText(message);
  if (!text || explicitCancellationRequest(text) || CHANGE_LANGUAGE.test(text)) return false;
  if (/\b(?:confirm|verify|check)\b[\s\S]{0,80}\b(?:booking|reservation)\b/iu.test(text))
    return false;
  return ASK_SIGNAL.test(text) && BOOKING_LANGUAGE.test(text);
}

function looksLikeChangeRequest(message: CorpusMessage): boolean {
  const text = requestText(message);
  if (!text || explicitCancellationRequest(text)) return false;
  return (
    CHANGE_LANGUAGE.test(text) &&
    /\b(?:booking|reservation|conf(?:irmation)?|stay|room|guest|arrival|departure)\b/iu.test(text)
  );
}

function looksLikeCancellationRequest(message: CorpusMessage): boolean {
  return explicitCancellationRequest(requestText(message));
}

function nextAmendmentRequestTime(
  message: CorpusMessage,
  thread: readonly CorpusMessage[],
): number | null {
  const requestIndex = thread.findIndex((candidate) => candidate.id === message.id);
  if (requestIndex < 0) return null;
  const nextRequest = thread
    .slice(requestIndex + 1)
    .find(
      (candidate) =>
        candidate.direction.toLowerCase() === 'inbound' && looksLikeChangeRequest(candidate),
    );
  return nextRequest ? messageTimeMs(nextRequest) : null;
}

function amendmentReplyMessages(
  message: CorpusMessage,
  thread: readonly CorpusMessage[],
): CorpusMessage[] {
  const requestIndex = thread.findIndex((candidate) => candidate.id === message.id);
  if (requestIndex < 0) return [];
  const nextRequestIndex = thread.findIndex(
    (candidate, index) =>
      index > requestIndex &&
      candidate.direction.toLowerCase() === 'inbound' &&
      looksLikeChangeRequest(candidate),
  );
  return thread
    .slice(requestIndex + 1, nextRequestIndex < 0 ? undefined : nextRequestIndex)
    .filter(
      (candidate) => candidate.direction.toLowerCase() === 'outbound' && isStaffMessage(candidate),
    );
}

function hasClearAmendmentLink(
  request: CorpusMessage,
  reply: CorpusMessage,
  conf: string,
): boolean {
  const requestConfs = confirmationNumbersFromText(requestText(request));
  const replyConfs = confirmationNumbersFromText(
    `${cleanText(reply.subject) ?? ''}\n${plainTextBody(reply)}`,
  );
  return requestConfs.includes(conf) || replyConfs.includes(conf);
}

function looksLikeChangeConfirmation(message: CorpusMessage): boolean {
  const text = `${cleanText(message.subject) ?? ''}\n${plainTextBody(message)}`;
  return /\b(?:updated|amended|changed|modified|revised|adjusted|corrected|changes? (?:have|has) been made)\b/iu.test(
    text,
  );
}

export function cancellationReplyEvidence(
  message: CorpusMessage,
): CancellationReplyEvidence | null {
  const text = authoredBodyText(message);
  if (
    !/\b(?:cancell?ed|cancellation (?:has been )?(?:processed|confirmed|completed)|reservation (?:has been )?cancell?ed)\b/iu.test(
      text,
    ) || /\b(?:cannot|can't|unable|not possible|not yet|please cancel)\b/iu.test(text)
  ) {
    return null;
  }
  return { message_id: message.id, confirmation_numbers: confirmationNumbersFromText(text) };
}

function confirmationDocuments(documents: readonly StaffPdf[]): StaffPdf[] {
  return documents.filter((document) => document.kind === 'confirmation' && document.conf);
}

function firstLetterByConf(
  documents: readonly StaffPdf[],
  messageById: ReadonlyMap<string, CorpusMessage>,
): Map<string, StaffPdf> {
  const first = new Map<string, StaffPdf>();
  const ordered = confirmationDocuments(documents).sort(
    (left, right) =>
      messageTimeMs(messageById.get(left.message_id)) -
      messageTimeMs(messageById.get(right.message_id)),
  );
  for (const document of ordered) {
    if (document.conf && !first.has(document.conf)) first.set(document.conf, document);
  }
  return first;
}

function datesFromAnswer(answer: GoldenAnswer): GoldenDate[] {
  return datePairs(answer.dates);
}

function truthPartyName(commercial: JsonRecord, field: 'company' | 'agency'): string | null {
  return cleanText(asRecord(commercial[field]).name);
}

export function answerWithTruth(
  answer: GoldenAnswer,
  conf: string,
  truth: JsonRecord | undefined,
): GoldenAnswer {
  return {
    ...answer,
    conf,
    confirmation_numbers: [conf],
    hms: null,
    hmsCurrent: truth ?? answer.hmsCurrent ?? answer.hms ?? null,
  };
}

function parsedPdfAnswer(document: StaffPdf, sentAt: string): GoldenAnswer {
  return parseOfferPdfAnswer(document.text, sentAt);
}

function answerCompleteness(answer: GoldenAnswer): number {
  return [
    datesFromAnswer(answer).length > 0,
    answer.room_count !== null && answer.room_count !== undefined,
    Boolean(answer.room_type),
    Boolean(answer.board),
    Boolean(answer.party?.company || answer.party?.agency),
    Boolean(answer.rate_plan),
    Boolean(answer.total),
  ].filter(Boolean).length;
}

function bestPdfAnswer(documents: readonly StaffPdf[], sentAt: string): GoldenAnswer {
  return (
    documents
      .map((document) => parsedPdfAnswer(document, sentAt))
      .sort((left, right) => answerCompleteness(right) - answerCompleteness(left))[0] ?? {}
  );
}

export function makeCandidate(input: {
  message: CorpusMessage;
  mailClass: GoldenClass;
  answer: GoldenAnswer;
  staffMessages?: readonly CorpusMessage[];
  pdfs?: readonly StaffPdf[];
  truthByConf?: ReadonlyMap<string, JsonRecord>;
  source?: MailSourceClassification;
  quoteRunIds?: readonly string[];
  hmsReadIds?: readonly string[];
}): GoldenCandidate {
  const answerWithExtractedReferences =
    input.mailClass === 'create' || input.mailClass === 'amend' || input.mailClass === 'cancel'
      ? {
          ...input.answer,
          extracted_confirmation_numbers: confirmationNumbersFromText(requestText(input.message)),
        }
      : input.answer;
  const conf = cleanText(answerWithExtractedReferences.conf);
  const truth = conf ? input.truthByConf?.get(conf) : undefined;
  const answer = conf
    ? answerWithTruth(answerWithExtractedReferences, conf, truth)
    : answerWithExtractedReferences;
  const arrival = datesFromAnswer(answer)[0]?.arrival ?? null;
  return {
    message_id: input.message.id,
    class: input.mailClass,
    answer,
    evidence: {
      inbound_message_id: input.message.id,
      staff_message_ids: [...new Set(input.staffMessages?.map((message) => message.id) ?? [])],
      pdf_files: [...new Set(input.pdfs?.map((document) => document.file_name) ?? [])],
      staff_quote_run_ids: input.quoteRunIds?.length ? [...new Set(input.quoteRunIds)] : undefined,
      hms_read_ids: input.hmsReadIds?.length ? [...new Set(input.hmsReadIds)] : undefined,
      hms_truth: truth && conf ? { source: basename(PARTY_TRUTH_PATH), conf } : null,
      source_classification: input.source
        ? { kind: input.source.kind, source: input.source.source, reason: input.source.reason }
        : undefined,
    },
    sender_domain: senderDomain(input.message.from_address),
    stay_date: arrival,
    received_at: messageTime(input.message),
  };
}

function hmsReadIdsByMessage(rows: readonly JsonRecord[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const messageId = cleanText(row.trigger_message_id);
    const id = cleanText(row.id);
    if (!messageId || !id) continue;
    const values = result.get(messageId) ?? [];
    values.push(id);
    result.set(messageId, values);
  }
  return result;
}

function staffQuoteRunIdsByThread(rows: readonly JsonRecord[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const threadId = cleanText(row.thread_id);
    const id = cleanText(row.id);
    if (!threadId || !id) continue;
    const values = result.get(threadId) ?? [];
    values.push(id);
    result.set(threadId, values);
  }
  return result;
}

export function indexedTruth(rows: readonly JsonRecord[]): Map<string, JsonRecord> {
  const truth = new Map<string, JsonRecord>();
  for (const row of rows) {
    const conf = cleanText(row.conf);
    if (!conf || !isSuccessfulHmsRead(row)) continue;
    truth.set(conf, row);
  }
  return truth;
}

function isSuccessfulHmsRead(row: JsonRecord): boolean {
  const statuses = [row.status, row.outcome]
    .map((value) => cleanText(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (
    !statuses.length ||
    !statuses.includes('found') ||
    statuses.some((value) => value !== 'found')
  ) {
    return false;
  }
  const commercial = asRecord(row.commercial);
  return Boolean(
    datePairs({ arrival: commercial.arrival, departure: commercial.departure }).length ||
      cleanText(commercial.roomType) ||
      cleanText(commercial.ratePlan) ||
      cleanText(commercial.mealPlan) ||
      truthPartyName(commercial, 'company') ||
      truthPartyName(commercial, 'agency') ||
      cleanText(commercial.status),
  );
}

type MergeTruthChoice = { truth: JsonRecord; source: 'supplied' | 'saved' | 'base' };

export function preferredMergeTruth(
  answer: GoldenAnswer,
  conf: string,
  suppliedTruth?: JsonRecord,
  baseTruth?: JsonRecord,
): MergeTruthChoice | null {
  if (
    suppliedTruth &&
    cleanText(suppliedTruth.conf) === conf &&
    isSuccessfulHmsRead(suppliedTruth)
  ) {
    return { truth: suppliedTruth, source: 'supplied' };
  }
  for (const savedTruth of [answer.hmsCurrent, answer.hms]) {
    if (savedTruth && cleanText(savedTruth.conf) === conf && isSuccessfulHmsRead(savedTruth)) {
      return { truth: savedTruth, source: 'saved' };
    }
  }
  if (baseTruth && cleanText(baseTruth.conf) === conf && isSuccessfulHmsRead(baseTruth)) {
    return { truth: baseTruth, source: 'base' };
  }
  return null;
}

export function matchingAmendmentUpdate(
  message: CorpusMessage,
  thread: readonly CorpusMessage[],
  conf: string,
  documents: readonly StaffPdf[],
  messageById: ReadonlyMap<string, CorpusMessage>,
): StaffPdf | undefined {
  const requestTime = messageTimeMs(message);
  const nextRequestTime = nextAmendmentRequestTime(message, thread);
  const sameThreadReplies = amendmentReplyMessages(message, thread);
  const sameThreadReplyIds = new Set(sameThreadReplies.map((reply) => reply.id));
  return documents
    .filter((document) => document.kind === 'confirmation' && document.conf === conf)
    .filter((document) => {
      const attached = messageById.get(document.message_id);
      if (
        !attached ||
        attached.direction.toLowerCase() !== 'outbound' ||
        !isStaffMessage(attached)
      ) {
        return false;
      }
      const attachedTime = messageTimeMs(attached);
      const delta = attachedTime - requestTime;
      if (delta <= 0 || (nextRequestTime !== null && attachedTime >= nextRequestTime)) {
        return false;
      }
      const replyConfs = confirmationNumbersFromText(
        `${cleanText(attached.subject) ?? ''}\n${plainTextBody(attached)}`,
      );
      if (attached.thread_id === message.thread_id) {
        return (
          sameThreadReplyIds.has(attached.id) && hasClearAmendmentLink(message, attached, conf)
        );
      }
      return delta <= CROSS_THREAD_REPLY_WINDOW_MS && replyConfs.includes(conf);
    })
    .sort(
      (left, right) =>
        messageTimeMs(messageById.get(left.message_id)) -
        messageTimeMs(messageById.get(right.message_id)),
    )
    .at(0);
}

export function matchingAmendmentReplies(
  message: CorpusMessage,
  thread: readonly CorpusMessage[],
  messages: readonly CorpusMessage[],
  conf: string,
): CorpusMessage[] {
  const requestTime = messageTimeMs(message);
  const nextRequestTime = nextAmendmentRequestTime(message, thread);
  const sameThreadConfirmations = amendmentReplyMessages(message, thread).filter(
    (reply) => looksLikeChangeConfirmation(reply) && hasClearAmendmentLink(message, reply, conf),
  );
  const crossThreadConfirmations = messages.filter((reply) => {
    const replyTime = messageTimeMs(reply);
    const delta = replyTime - requestTime;
    return (
      reply.thread_id !== message.thread_id &&
      reply.direction.toLowerCase() === 'outbound' &&
      isStaffMessage(reply) &&
      delta > 0 &&
      delta <= CROSS_THREAD_REPLY_WINDOW_MS &&
      (nextRequestTime === null || replyTime < nextRequestTime) &&
      looksLikeChangeConfirmation(reply) &&
      confirmationNumbersFromText(plainTextBody(reply)).includes(conf)
    );
  });
  return [
    ...new Map(
      [...sameThreadConfirmations, ...crossThreadConfirmations].map((reply) => [reply.id, reply]),
    ).values(),
  ];
}

async function selectCandidates(): Promise<{
  candidates: GoldenCandidate[];
  selection: GoldenSelection;
  hmsNeeded: string[];
}> {
  const [messageRows, hmsRows, quoteRows, truthRows, pdfData] = await Promise.all([
    readJsonl(`${CORPUS_ROOT}/messages.jsonl.gz`),
    readJsonl(`${CORPUS_ROOT}/hms_reads.jsonl.gz`),
    readJsonl(`${CORPUS_ROOT}/staff_quotes.jsonl.gz`),
    readJsonl(PARTY_TRUTH_PATH),
    loadStaffPdfs(),
  ]);
  const messages = messageRows.flatMap((row) => {
    const id = cleanText(row.id);
    const threadId = cleanText(row.thread_id);
    const direction = cleanText(row.direction);
    return id && threadId && direction
      ? [{ ...row, id, thread_id: threadId, direction } as CorpusMessage]
      : [];
  });
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const threads = indexedThreads(messages);
  const truthByConf = indexedTruth(truthRows);
  const hmsReadsByMessage = hmsReadIdsByMessage(hmsRows);
  const quoteRunIdsByThread = staffQuoteRunIdsByThread(quoteRows);
  const firstLetters = firstLetterByConf(pdfData.all, messageById);
  const lettersByConf = new Map<string, StaffPdf[]>();
  for (const document of confirmationDocuments(pdfData.all)) {
    if (!document.conf) continue;
    const values = lettersByConf.get(document.conf) ?? [];
    values.push(document);
    lettersByConf.set(document.conf, values);
  }
  const candidates: GoldenCandidate[] = [];
  const bookingRequests: CorpusMessage[] = [];

  for (const message of messages) {
    if (message.direction.toLowerCase() !== 'inbound') continue;
    const source = sourceClassification(message);
    const thread = threads.get(message.thread_id) ?? [];
    const replies = nextStaffReplies(thread, message.id);
    const replyPdfs = replies.flatMap((reply) => pdfData.byMessage.get(reply.id) ?? []);

    if (source.kind !== 'direct') {
      candidates.push(
        makeCandidate({
          message,
          mailClass: 'skip',
          answer: { skip: true },
          source,
          hmsReadIds: hmsReadsByMessage.get(message.id),
        }),
      );
      continue;
    }

    if (looksLikeQuoteRequest(message)) {
      const quoteReplies = replies.filter((reply) =>
        /\bplease\s+(?:see|find)\s+(?:the\s+)?attached\s+(?:the\s+)?quotation\b/iu.test(
          plainTextBody(reply),
        ),
      );
      const offerPdfs = replyPdfs.filter((document) => document.kind === 'offer');
      const quoteReplyPdfs = replyPdfs.filter(isQuotePdf);
      const answerPdfs = offerPdfs.length ? offerPdfs : quoteReplyPdfs;
      const hasStaffQuoteEvidence = offerPdfs.length > 0 || quoteReplies.length > 0;
      if (hasStaffQuoteEvidence && answerPdfs.length) {
        const answer = bestPdfAnswer(answerPdfs, messageTime(message));
        if (answerCompleteness(answer) > 0) {
          candidates.push(
            makeCandidate({
              message,
              mailClass: 'quote',
              answer,
              staffMessages: replies.filter(
                (reply) =>
                  quoteReplies.some((quoteReply) => quoteReply.id === reply.id) ||
                  answerPdfs.some((document) => document.message_id === reply.id),
              ),
              pdfs: answerPdfs,
              quoteRunIds: quoteRunIdsByThread.get(message.thread_id),
            }),
          );
        }
      }
    }

    const bookingRequest = looksLikeBookingRequest(message);
    if (bookingRequest) {
      bookingRequests.push(message);
      for (const document of replyPdfs) {
        if (document.kind !== 'confirmation' || !document.conf) continue;
        const firstLetter = firstLetters.get(document.conf);
        if (firstLetter?.attachment_id !== document.attachment_id) continue;
        const answer = answerWithTruth(
          {
            ...parsedPdfAnswer(document, messageTime(message)),
            conf: document.conf,
            confirmation_numbers: [document.conf],
          },
          document.conf,
          truthByConf.get(document.conf),
        );
        candidates.push(
          makeCandidate({
            message,
            mailClass: 'create',
            answer,
            staffMessages: replies.filter((reply) => reply.id === document.message_id),
            pdfs: [document],
            truthByConf,
            hmsReadIds: hmsReadsByMessage.get(message.id),
          }),
        );
        break;
      }
    }

    if (looksLikeChangeRequest(message)) {
      const request = requestText(message);
      const mentionedConfs = confirmationNumbersFromText(request);
      const laterLetters = replyPdfs.filter(
        (document) => document.kind === 'confirmation' && document.conf,
      );
      const possibleConfs = [
        ...new Set([...mentionedConfs, ...laterLetters.map((doc) => doc.conf!)]),
      ];
      for (const conf of possibleConfs) {
        const before = (lettersByConf.get(conf) ?? []).some((document) => {
          const attached = messageById.get(document.message_id);
          return attached && messageTimeMs(attached) < messageTimeMs(message);
        });
        const hmsExisting = truthByConf.get(conf)?.outcome === 'found';
        const matchingUpdate = matchingAmendmentUpdate(
          message,
          thread,
          conf,
          lettersByConf.get(conf) ?? [],
          messageById,
        );
        const confirmingReplies = matchingAmendmentReplies(message, thread, messages, conf);
        if (!(before || hmsExisting) || (!matchingUpdate && !confirmingReplies.length)) continue;
        const update = matchingUpdate;
        const pdfs = update ? [update] : [];
        const answer = answerWithTruth(
          {
            ...(update ? parsedPdfAnswer(update, messageTime(message)) : {}),
            conf,
            confirmation_numbers: [conf],
            change_types: inferChangeTypes(request),
            change_type: inferChangeTypes(request)[0] ?? 'other',
          },
          conf,
          truthByConf.get(conf),
        );
        const updateMessage = update ? messageById.get(update.message_id) : undefined;
        const staffMessages = updateMessage
          ? [...confirmingReplies, updateMessage]
          : confirmingReplies;
        candidates.push(
          makeCandidate({
            message,
            mailClass: 'amend',
            answer,
            staffMessages,
            pdfs,
            truthByConf,
            hmsReadIds: hmsReadsByMessage.get(message.id),
          }),
        );
        break;
      }
    }

    if (looksLikeCancellationRequest(message)) {
      const request = requestText(message);
      const repliesThatConfirm = replies.flatMap((reply) => {
        const evidence = cancellationReplyEvidence(reply);
        return evidence ? [{ reply, evidence }] : [];
      });
      const replyEvidence = repliesThatConfirm.map(({ evidence }) => evidence);
      const pdfConfirmationNumbers = replyPdfs
        .filter((document) => document.kind === 'confirmation')
        .map((document) => document.conf);
      const requestAndReplyConfs = [
        ...confirmationNumbersFromText(request),
        ...replyEvidence.flatMap((reply) => reply.confirmation_numbers),
        ...pdfConfirmationNumbers.filter((conf): conf is string => Boolean(conf)),
      ];
      const hmsCancelledConfNumbers = [...new Set(requestAndReplyConfs)].filter((conf) =>
        cleanText(asRecord(truthByConf.get(conf)?.commercial).status)
          ?.toLowerCase()
          .includes('cancel'),
      );
      const cancellation = resolveCancellationEvidence(
        request,
        replyEvidence,
        pdfConfirmationNumbers,
        hmsCancelledConfNumbers,
      );
      if (cancellation) {
        const conf = cancellation.conf;
        const hmsTruth = truthByConf.get(conf);
        const status = cleanText(asRecord(hmsTruth?.commercial).status);
        candidates.push(
          makeCandidate({
            message,
            mailClass: 'cancel',
            answer: {
              conf,
              confirmation_numbers: [conf],
              cancellation_reply: {
                confirmed: cancellation.confirmed,
                confirmation_number: conf,
              },
              status,
            },
            staffMessages: repliesThatConfirm
              .filter(({ reply }) => cancellation.staff_message_ids.includes(reply.id))
              .map(({ reply }) => reply),
            pdfs: replyPdfs.filter(
              (document) => document.kind === 'confirmation' && document.conf === conf,
            ),
            truthByConf,
            hmsReadIds: hmsReadsByMessage.get(message.id),
          }),
        );
      }
    }
  }

  const requestProfiles = bookingRequests.flatMap((message) => {
    const text = requestText(message);
    if (confirmationNumbersFromText(text).length) return [];
    const dates = datePairsFromText(text);
    if (!dates.length) return [];
    return [
      {
        message,
        text,
        dates,
        senderDomain: senderDomain(message.from_address),
        requestAt: messageTime(message),
      },
    ];
  });
  const firstLetterProfiles = [...firstLetters.values()].flatMap((document) => {
    if (!document.conf) return [];
    const staffMessage = messageById.get(document.message_id);
    if (!staffMessage) return [];
    const answer = answerWithTruth(
      {
        ...parsedPdfAnswer(document, messageTime(staffMessage)),
        conf: document.conf,
        confirmation_numbers: [document.conf],
      },
      document.conf,
      truthByConf.get(document.conf),
    );
    const dates = datesFromAnswer(answer);
    if (!dates.length || !answer.party) return [];
    return [{ document, staffMessage, answer, dates, staffAt: messageTime(staffMessage) }];
  });
  const crossThreadPairs = requestProfiles.flatMap((request) =>
    firstLetterProfiles.flatMap((outcome) =>
      isCrossThreadBookingMatch({
        requestText: request.text,
        senderDomain: request.senderDomain,
        requestAt: request.requestAt,
        staffAt: outcome.staffAt,
        requestDates: request.dates,
        outcomeDates: outcome.dates,
        party: outcome.answer.party,
      })
        ? [{ request, outcome }]
        : [],
    ),
  );
  const pairsByRequest = new Map<string, typeof crossThreadPairs>();
  const pairsByOutcome = new Map<string, typeof crossThreadPairs>();
  for (const pair of crossThreadPairs) {
    const requestPairs = pairsByRequest.get(pair.request.message.id) ?? [];
    requestPairs.push(pair);
    pairsByRequest.set(pair.request.message.id, requestPairs);
    const outcomePairs = pairsByOutcome.get(pair.outcome.document.attachment_id) ?? [];
    outcomePairs.push(pair);
    pairsByOutcome.set(pair.outcome.document.attachment_id, outcomePairs);
  }
  for (const pair of crossThreadPairs) {
    if (
      pairsByRequest.get(pair.request.message.id)?.length !== 1 ||
      pairsByOutcome.get(pair.outcome.document.attachment_id)?.length !== 1
    ) {
      continue;
    }
    candidates.push(
      makeCandidate({
        message: pair.request.message,
        mailClass: 'create',
        answer: pair.outcome.answer,
        staffMessages: [pair.outcome.staffMessage],
        pdfs: [pair.outcome.document],
        truthByConf,
        hmsReadIds: hmsReadsByMessage.get(pair.request.message.id),
      }),
    );
  }

  const selection = selectDiverseGoldenRows(candidates);
  const selectedConfs = new Set(
    selection.rows
      .filter((row) => row.class !== 'quote' && row.class !== 'skip')
      .flatMap((row) => answerOutcomeConfirmationNumbers(row.answer)),
  );
  const hmsNeeded = [...selectedConfs].filter((conf) => !truthByConf.has(conf)).sort();
  return { candidates, selection, hmsNeeded };
}

function selectionMetadata(selection: GoldenSelection): SelectionMetadata[] {
  return GOLDEN_CLASSES.map((mailClass) => ({
    class: mailClass,
    target: selection.targets[mailClass],
    evidence_candidates: selection.availableByClass[mailClass],
    after_domain_cap: selection.eligibleByClass[mailClass],
    selected: selection.selectedByClass[mailClass],
  }));
}

function formatClassCounts(selection: GoldenSelection): string {
  return GOLDEN_CLASSES.map(
    (mailClass) =>
      `${mailClass} ${selection.selectedByClass[mailClass]}/${selection.targets[mailClass]}`,
  ).join(', ');
}

async function runSelect(goldenPath: string, hmsNeededPath: string): Promise<void> {
  const result = await withGoldenSetPairLock(goldenPath, hmsNeededPath, async (pair) => {
    await pair.recover();
    const { selection, hmsNeeded } = await selectCandidates();
    const rows = selection.rows.map((row, index) => parseGoldenRow(row, index + 1));
    const hmsNeededFile: HmsNeededFile = {
      conf_numbers: hmsNeeded,
      selection: selectionMetadata(selection),
      golden_sha256: goldenRowsSha256(rows),
    };
    const validatedManifest = parseHmsNeededFile(hmsNeededFile);
    assertHmsNeededMatchesGolden(rows, validatedManifest);
    await pair.write(serializeJsonLines(rows), `${JSON.stringify(validatedManifest, null, 2)}\n`);
    return { selection, total: rows.length, hmsNeededCount: hmsNeeded.length };
  });
  process.stdout.write(
    `Golden v1 selection: ${formatClassCounts(result.selection)}; total=${result.total}; HMS-needed=${result.hmsNeededCount}.\n`,
  );
}

async function readGoldenRows(): Promise<GoldenRow[]> {
  const rows = await readJsonl(GOLDEN_PATH);
  return rows.map((row, index) => parseGoldenRow(row, index + 1));
}

async function readHmsNeeded(): Promise<HmsNeededFile> {
  return parseHmsNeededFile(await readJson(HMS_NEEDED_PATH));
}

function rowConf(row: GoldenRow): string | null {
  return cleanText(row.answer.conf) ?? answerOutcomeConfirmationNumbers(row.answer)[0] ?? null;
}

async function runMergeHms(
  hmsPath: string,
  goldenPath: string,
  hmsNeededPath: string,
): Promise<void> {
  const result = await withGoldenSetPairLock(goldenPath, hmsNeededPath, async (pair) => {
    await pair.recover();
    const [goldenRows, suppliedTruthRows, baseTruthRows, hmsNeeded] = await Promise.all([
      readGoldenRows(),
      readJsonl(hmsPath),
      readJsonl(PARTY_TRUTH_PATH),
      readHmsNeeded(),
    ]);
    assertHmsNeededMatchesGolden(goldenRows, hmsNeeded);
    const suppliedTruthByConf = indexedTruth(suppliedTruthRows);
    const baseTruthByConf = indexedTruth(baseTruthRows);
    const merged = goldenRows.map((row) => {
      const conf = rowConf(row);
      if (!conf) return row;
      const choice = preferredMergeTruth(
        row.answer,
        conf,
        suppliedTruthByConf.get(conf),
        baseTruthByConf.get(conf),
      );
      if (!choice) return row;
      return {
        ...row,
        answer: answerWithTruth(row.answer, conf, choice.truth),
        evidence:
          choice.source === 'saved'
            ? row.evidence
            : {
                ...row.evidence,
                hms_truth: {
                  source: basename(choice.source === 'supplied' ? hmsPath : PARTY_TRUTH_PATH),
                  conf,
                },
              },
      };
    });
    const updatedHmsNeeded = missingHmsConfirmations(merged);
    const updatedManifest = parseHmsNeededFile({
      ...hmsNeeded,
      conf_numbers: updatedHmsNeeded,
      golden_sha256: goldenRowsSha256(merged),
    });
    assertHmsNeededMatchesGolden(merged, updatedManifest);
    await pair.write(serializeJsonLines(merged), `${JSON.stringify(updatedManifest, null, 2)}\n`);
    return { mergedCount: merged.length, neededCount: updatedHmsNeeded.length };
  });
  process.stdout.write(
    `Merged HMS truth into ${result.mergedCount} golden rows; still-needed=${result.neededCount}.\n`,
  );
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value);
  return null;
}

function extractionDates(extraction: JsonRecord): GoldenDate[] {
  const payload = asRecord(extraction.payload);
  const stays = Array.isArray(payload.stays) ? payload.stays : [];
  const dates: GoldenDate[] = [];
  for (const stay of stays) {
    const requested = asRecord(asRecord(stay).requested);
    const arrival = canonicalDate(requested.arrival);
    const departure = canonicalDate(requested.departure);
    if (arrival && departure) dates.push({ arrival, departure });
  }
  if (!dates.length) {
    const arrival = canonicalDate(payload.arrival);
    const departure = canonicalDate(payload.departure);
    if (arrival && departure) dates.push({ arrival, departure });
  }
  return dates;
}

export function extractionRooms(extraction: JsonRecord): {
  rooms: GoldenRoom[];
  roomCount: number | null;
} {
  const payload = asRecord(extraction.payload);
  const stays = Array.isArray(payload.stays) ? payload.stays : [];
  const rooms: GoldenRoom[] = [];
  const perStayCounts: number[] = [];
  for (const stayValue of stays) {
    const stay = asRecord(stayValue);
    const rows = Array.isArray(stay.rows) ? stay.rows : [];
    let stayCount = numericValue(stay.totalRooms);
    let inferredRoomCount = 0;
    let hasInferredRoomCount = false;
    for (const rowValue of rows) {
      const row = asRecord(rowValue);
      const count = numericValue(row.rooms);
      const roomType = cleanText(row.roomType);
      if (count !== null) rooms.push({ count, room_type: roomType });
      if (stayCount === null && count !== null) {
        inferredRoomCount += count;
        hasInferredRoomCount = true;
      }
    }
    if (stayCount === null && hasInferredRoomCount) stayCount = inferredRoomCount;
    if (stayCount !== null) perStayCounts.push(stayCount);
  }
  const roomCount =
    stays.length && perStayCounts.length === stays.length
      ? perStayCounts.reduce((total, count) => total + count, 0)
      : null;
  return { rooms, roomCount };
}

export function snapshotPrediction(
  messageId: string,
  message: CorpusMessage | undefined,
  extraction: JsonRecord | undefined,
): GoldenPrediction {
  if (
    message &&
    classifyMailSource({
      fromAddress: cleanText(message.from_address),
      subject: cleanText(message.subject),
      bodyText: plainTextBody(message),
    }).kind !== 'direct'
  ) {
    return { message_id: messageId, action: 'skip' };
  }
  if (!extraction) return { message_id: messageId, action: null };
  const payload = asRecord(extraction.payload);
  const roomAnswer = extractionRooms(extraction);
  return {
    message_id: messageId,
    action: cleanText(extraction.kind),
    dates: extractionDates(extraction),
    rooms: roomAnswer.rooms,
    room_count: roomAnswer.roomCount,
    party: {
      company: cleanText(payload.endClient),
      agency: cleanText(payload.agency),
    },
    confirmation_numbers: stringValues(payload.confirmationNumbers),
  };
}

function metricText(metric: MetricCount): string {
  if (!metric.total) return '— (0/0)';
  const percent = ((metric.correct / metric.total) * 100).toFixed(1);
  return `${metric.correct}/${metric.total} (${percent}%)`;
}

function shortReason(metadata: SelectionMetadata | undefined): string {
  if (!metadata || metadata.selected >= metadata.target) return '—';
  if (metadata.evidence_candidates < metadata.target) {
    return `evidence gates yielded ${metadata.evidence_candidates}/${metadata.target}`;
  }
  if (metadata.after_domain_cap < metadata.target) {
    return `2/domain cap left ${metadata.after_domain_cap}/${metadata.target}`;
  }
  return `selected ${metadata.selected}/${metadata.target}`;
}

export function buildScoreReport(input: {
  rows: readonly GoldenRow[];
  score: GoldenScore;
  mode: 'snapshot' | 'fresh JSONL';
  selection: readonly SelectionMetadata[];
  hmsNeededCount: number;
}): string {
  const selectionByClass = new Map(input.selection.map((row) => [row.class, row]));
  const selectionLines = GOLDEN_CLASSES.map((mailClass) => {
    const row = selectionByClass.get(mailClass);
    const selected = input.score.byClass[mailClass].count;
    const target = row?.target ?? TARGET_COUNTS[mailClass];
    return `| ${mailClass} | ${row?.evidence_candidates ?? '—'} | ${row?.after_domain_cap ?? '—'} | ${selected}/${target} | ${shortReason(row)} |`;
  });
  const scoreLines = GOLDEN_CLASSES.map((mailClass) => {
    const score = input.score.byClass[mailClass];
    return `| ${mailClass} | ${score.count} | ${metricText(score.action)} | ${metricText(score.dates)} | ${metricText(score.confirmation)} | ${metricText(score.rooms)} | ${metricText(score.party)} |`;
  });
  const noAnswerKeyLines = GOLDEN_CLASSES.map((mailClass) => {
    const score = input.score.byClass[mailClass];
    const missing = [
      score.count - score.dates.total,
      score.count - score.confirmation.total,
      score.count - score.rooms.total,
      score.count - score.party.total,
    ];
    return `| ${mailClass} | ${missing.join(' | ')} |`;
  });
  const shortClasses = GOLDEN_CLASSES.flatMap((mailClass) => {
    const count = input.score.byClass[mailClass].count;
    const target = selectionByClass.get(mailClass)?.target ?? TARGET_COUNTS[mailClass];
    if (count >= target) return [];
    return [
      `- **${mailClass}: ${count}/${target}** rows; ${shortReason(selectionByClass.get(mailClass))}.`,
    ];
  });
  const skipPrecision = metricText(input.score.skip.precision);
  const skipRecall = metricText(input.score.skip.recall);
  return [
    '# Golden v1 score',
    '',
    `Nava input: ${input.mode}. Golden rows scored: ${input.rows.length}. Current HMS reads still missing: ${input.hmsNeededCount}.`,
    '',
    '## Selection audit',
    '',
    '| Class | Evidence candidates | After 2/domain cap | Selected / target | Short reason |',
    '|---|---:|---:|---:|---|',
    ...selectionLines,
    ...(shortClasses.length ? ['', 'Short classes:', ...shortClasses] : []),
    '',
    '## Score by class',
    '',
    '| Class | Rows | Action correct | Dates exact | Conf exact | Rooms count exact | Party normalized |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...scoreLines,
    `| **overall** | **${input.score.overall.count}** | **${metricText(input.score.overall.action)}** | ${metricText(input.score.overall.dates)} | ${metricText(input.score.overall.confirmation)} | ${metricText(input.score.overall.rooms)} | ${metricText(input.score.overall.party)} |`,
    '',
    '## No answer key',
    '',
    '| Class | Dates | Conf | Rooms | Party |',
    '|---|---:|---:|---:|---:|',
    ...noAnswerKeyLines,
    '',
    'Rows without that field in the answer key are unscored for that field and excluded from its denominator.',
    '',
    `Skip precision: ${skipPrecision}. Skip recall: ${skipRecall}. TP=${input.score.skip.true_positive}, FP=${input.score.skip.false_positive}, FN=${input.score.skip.false_negative}.`,
    '',
    '## Methodology',
    '',
    '- Selection uses inbound mail plus staff/HMS evidence, not stored Nava labels: quote requests pair to offer/quotation PDFs; creates pair to a first confirmation letter, including split-thread links only when exact stay dates and party evidence agree within 30 days and the pair is unique; amendments require a human change request on an existing confirmation plus a later same-conf letter or staff confirmation (cross-thread evidence requires the exact conf); cancels require a human cancel request and staff/HMS evidence; channel/system notices are skip. Travel-agent senders remain eligible unless a known channel/system rule matches.',
    '- Selection prefers stays arriving on or after 2026-09-12, then newest inbound mail, and caps each sender domain at two rows per class. Evidence pointers and parsed answers live only in the private test set.',
    '- Action maps booking→create, amendment→amend, cancellation→cancel, and source-classified automated mail→skip. Dates compare exact normalized arrival/departure pairs; confirmation numbers compare exact sets; rooms compare counts; party names use accent- and legal-suffix normalization, matched company-to-company and agency-to-agency. If the answer names both roles, both must match.',
    '- Field denominators include only answer-key fields present in the selected rows. “No answer key” counts rows where that answer field is absent and excludes them from its denominator. Skip precision/recall use this deliberately balanced sample, not the production mail base rate.',
    '',
    '## Known gaps',
    '',
    `- ${input.hmsNeededCount} selected confirmation number(s) do not yet have a current row in the private HMS truth file; any available current read stays in hmsCurrent and is never used as a historical answer key.`,
    '- HMS truth is limited by the existing find window. PDF text parsing is deterministic and conservative; unrecognized layouts remain null rather than guessed.',
    '- In this selected quote sample, no offer PDF yielded a parseable stay-date pair or explicit rate plan; those fields remain unscored rather than borrowing request dates or guessing. Offer totals, rooms, board, and named parties are retained when the PDF exposes them.',
    '- Snapshot scoring uses each message’s latest succeeded extraction and does not replay the exact historical model state or thread chronology. A fresh JSONL run should use the same message_id/action/date/room/party/confirmation fields.',
    '- This is a curated, small real-mail set. Its per-class metrics are decision evidence, not population estimates; refresh the snapshot and re-audit evidence as the mix changes.',
    '',
    'This report contains class labels and counts only; no message identifiers, sender names, addresses, or bodies.',
    '',
  ].join('\n');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function assertOutputIsPrivate(path: string, privateRoot: string, repositoryRoot: string): void {
  if (
    resolve(path) === resolve(privateRoot) ||
    !isPathWithin(privateRoot, path) ||
    isPathWithin(repositoryRoot, path)
  ) {
    throw new Error('Refusing to write golden data or reports outside the private data directory');
  }
}

export function isSafeAttachmentId(value: string): boolean {
  return /^[A-Z0-9_-]+$/iu.test(value);
}

type PrivateOutputOptions = {
  allowedRoot?: string;
  inputPaths?: readonly string[];
};

export async function resolvePrivateOutputPath(
  path: string,
  privateRoot = DATA_ROOT,
  repositoryRoot = REPO_ROOT,
  options: PrivateOutputOptions = {},
): Promise<string> {
  const outputPath = resolve(path);
  const privateRootPath = resolve(privateRoot);
  const repositoryRootPath = resolve(repositoryRoot);
  const allowedRootPath = options.allowedRoot ? resolve(options.allowedRoot) : undefined;
  assertOutputIsPrivate(outputPath, privateRootPath, repositoryRootPath);
  if (allowedRootPath) {
    if (
      !isPathWithin(privateRootPath, allowedRootPath) ||
      isPathWithin(repositoryRootPath, allowedRootPath) ||
      !isPathWithin(allowedRootPath, outputPath)
    ) {
      throw new Error('Refusing to write a report outside the private reports directory');
    }
  }
  if ((options.inputPaths ?? []).some((inputPath) => resolve(inputPath) === outputPath)) {
    throw new Error('Refusing to overwrite a golden scoring input');
  }

  let canonicalPrivateRoot: string;
  let canonicalRepositoryRoot: string;
  try {
    [canonicalPrivateRoot, canonicalRepositoryRoot] = await Promise.all([
      realpath(privateRootPath),
      realpath(repositoryRootPath),
    ]);
  } catch {
    throw new Error('Refusing to write golden data or reports outside the private data directory');
  }
  if (isPathWithin(canonicalRepositoryRoot, canonicalPrivateRoot)) {
    throw new Error('Refusing to write golden data or reports outside the private data directory');
  }

  let canonicalAllowedRoot: string | undefined;
  if (allowedRootPath) {
    try {
      const allowedRootInfo = await lstat(allowedRootPath);
      if (!allowedRootInfo.isDirectory() || allowedRootInfo.isSymbolicLink()) {
        throw new Error('Refusing to write a report outside the private reports directory');
      }
      canonicalAllowedRoot = await realpath(allowedRootPath);
    } catch {
      throw new Error('Refusing to write a report outside the private reports directory');
    }
    if (
      !isPathWithin(canonicalPrivateRoot, canonicalAllowedRoot) ||
      isPathWithin(canonicalRepositoryRoot, canonicalAllowedRoot)
    ) {
      throw new Error('Refusing to write a report outside the private reports directory');
    }
  }

  let existingParent = dirname(outputPath);
  while (true) {
    try {
      await lstat(existingParent);
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR')) {
        throw new Error(
          'Refusing to write golden data or reports outside the private data directory',
        );
      }
      const parent = dirname(existingParent);
      if (parent === existingParent) {
        throw new Error(
          'Refusing to write golden data or reports outside the private data directory',
        );
      }
      existingParent = parent;
    }
  }

  let canonicalExistingParent: string;
  try {
    canonicalExistingParent = await realpath(existingParent);
  } catch {
    throw new Error('Refusing to write golden data or reports outside the private data directory');
  }
  if (
    !isPathWithin(canonicalPrivateRoot, canonicalExistingParent) ||
    isPathWithin(canonicalRepositoryRoot, canonicalExistingParent) ||
    (canonicalAllowedRoot && !isPathWithin(canonicalAllowedRoot, canonicalExistingParent))
  ) {
    throw new Error(
      canonicalAllowedRoot
        ? 'Refusing to write a report outside the private reports directory'
        : 'Refusing to write golden data or reports outside the private data directory',
    );
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  } catch {
    throw new Error('Could not create a private report directory');
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(outputPath));
  } catch {
    throw new Error('Refusing to write golden data or reports outside the private data directory');
  }
  if (
    !isPathWithin(canonicalPrivateRoot, canonicalParent) ||
    isPathWithin(canonicalRepositoryRoot, canonicalParent) ||
    (canonicalAllowedRoot && !isPathWithin(canonicalAllowedRoot, canonicalParent))
  ) {
    throw new Error(
      canonicalAllowedRoot
        ? 'Refusing to write a report outside the private reports directory'
        : 'Refusing to write golden data or reports outside the private data directory',
    );
  }

  const canonicalOutputPath = resolve(canonicalParent, basename(outputPath));
  try {
    const existingOutput = await lstat(canonicalOutputPath);
    if (existingOutput.isSymbolicLink() || !existingOutput.isFile() || existingOutput.nlink > 1) {
      throw new Error(
        'Refusing to write golden data or reports outside the private data directory',
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  for (const inputPath of options.inputPaths ?? []) {
    if (resolve(inputPath) === canonicalOutputPath) {
      throw new Error('Refusing to overwrite a golden scoring input');
    }
    try {
      if ((await realpath(inputPath)) === canonicalOutputPath) {
        throw new Error('Refusing to overwrite a golden scoring input');
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  return canonicalOutputPath;
}

async function runScore(navaInput: string, reportPath: string): Promise<void> {
  const [goldenPath, hmsNeededPath] = await Promise.all([
    resolvePrivateOutputPath(GOLDEN_PATH),
    resolvePrivateOutputPath(HMS_NEEDED_PATH),
  ]);
  await withGoldenSetPairLock(goldenPath, hmsNeededPath, async ({ recover }) => {
    await recover();
    await runScoreWithPairLocked(navaInput, reportPath);
  });
}

async function runScoreWithPairLocked(navaInput: string, reportPath: string): Promise<void> {
  const inputPaths = [GOLDEN_PATH, HMS_NEEDED_PATH];
  if (navaInput.toLowerCase() !== 'snapshot') inputPaths.push(resolve(navaInput));
  const outputPath = await resolvePrivateOutputPath(reportPath, DATA_ROOT, REPO_ROOT, {
    allowedRoot: `${DATA_ROOT}/reports`,
    inputPaths,
  });
  const goldenRows = await readGoldenRows();
  const hmsNeeded = await readHmsNeeded();
  assertHmsNeededMatchesGolden(goldenRows, hmsNeeded);
  let predictions: GoldenPrediction[];
  let mode: 'snapshot' | 'fresh JSONL';
  if (navaInput.toLowerCase() === 'snapshot') {
    const [messageRows, extractionRows] = await Promise.all([
      readJsonl(`${CORPUS_ROOT}/messages.jsonl.gz`),
      readJsonl(`${CORPUS_ROOT}/extractions.jsonl.gz`),
    ]);
    const messages = new Map(
      messageRows.flatMap((row) => {
        const id = cleanText(row.id);
        const threadId = cleanText(row.thread_id);
        const direction = cleanText(row.direction);
        return id && threadId && direction
          ? [[id, { ...row, id, thread_id: threadId, direction } as CorpusMessage] as const]
          : [];
      }),
    );
    const latest = latestSucceededExtractions(extractionRows);
    predictions = goldenRows.map((row) =>
      snapshotPrediction(row.message_id, messages.get(row.message_id), latest.get(row.message_id)),
    );
    mode = 'snapshot';
  } else {
    predictions = (await readJsonl(navaInput)) as GoldenPrediction[];
    mode = 'fresh JSONL';
  }
  const score = scoreGoldenRows(goldenRows, predictions);
  const report = buildScoreReport({
    rows: goldenRows,
    score,
    mode,
    selection: hmsNeeded.selection,
    hmsNeededCount: hmsNeeded.conf_numbers.length,
  });
  await writePrivateFileAtomically(outputPath, report);
  process.stdout.write(
    `Golden v1 score written: rows=${goldenRows.length}; action=${score.overall.action.correct}/${score.overall.action.total}; skip-precision=${metricText(score.skip.precision)}; skip-recall=${metricText(score.skip.recall)}.\n`,
  );
}

type CliCommand =
  | { command: 'select'; help: boolean }
  | { command: 'merge-hms'; hms: string; help: boolean }
  | { command: 'score'; nava: string; report: string; help: boolean }
  | { command: 'help'; help: true };

function parseCommand(args: readonly string[]): CliCommand {
  const command = args[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', help: true };
  }
  if (!['select', 'merge-hms', 'score'].includes(command)) {
    throw new Error('expected subcommand: select, merge-hms, or score');
  }
  const subcommand = command as 'select' | 'merge-hms' | 'score';
  const values = new Map<string, string>();
  let help = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (!['--hms', '--nava', '--report'].includes(flag)) throw new Error(`unknown option: ${flag}`);
    const value = inline ?? args[++index];
    if (!value?.trim()) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  if (subcommand === 'select') return { command: subcommand, help };
  if (subcommand === 'merge-hms') {
    const hms = values.get('--hms');
    if (!hms && !help) throw new Error('merge-hms requires --hms <truth.jsonl>');
    return { command: subcommand, hms: hms ?? PARTY_TRUTH_PATH, help };
  }
  const nava = values.get('--nava');
  if (!nava && !help) throw new Error('score requires --nava <snapshot|path.jsonl>');
  return {
    command: subcommand,
    nava: nava ?? 'snapshot',
    report: values.get('--report') ?? DEFAULT_REPORT_PATH,
    help,
  };
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm exec tsx apps/server-pilot/scripts/golden-set.ts select',
    '  pnpm exec tsx apps/server-pilot/scripts/golden-set.ts merge-hms --hms <truth.jsonl>',
    '  pnpm exec tsx apps/server-pilot/scripts/golden-set.ts score --nava <snapshot|path.jsonl> [--report <md>]',
    '',
    `Private golden output: ${GOLDEN_PATH}`,
    `Default score report: ${DEFAULT_REPORT_PATH}`,
  ].join('\n');
}

export async function runGoldenSet(args = process.argv.slice(2)): Promise<void> {
  const command = parseCommand(args);
  if (command.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command.command === 'select') {
    const [goldenPath, hmsNeededPath] = await Promise.all([
      resolvePrivateOutputPath(GOLDEN_PATH),
      resolvePrivateOutputPath(HMS_NEEDED_PATH),
    ]);
    await runSelect(goldenPath, hmsNeededPath);
    return;
  }
  if (command.command === 'merge-hms') {
    const mergeInputPaths = [command.hms];
    const [goldenPath, hmsNeededPath] = await Promise.all([
      resolvePrivateOutputPath(GOLDEN_PATH, DATA_ROOT, REPO_ROOT, {
        inputPaths: mergeInputPaths,
      }),
      resolvePrivateOutputPath(HMS_NEEDED_PATH, DATA_ROOT, REPO_ROOT, {
        inputPaths: mergeInputPaths,
      }),
    ]);
    await runMergeHms(command.hms, goldenPath, hmsNeededPath);
    return;
  }
  await runScore(command.nava, command.report);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === resolve(fileURLToPath(import.meta.url))) {
  void runGoldenSet().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'golden-set command failed'}\n`,
    );
    process.exitCode = 1;
  });
}
