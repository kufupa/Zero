/**
 * v8 read-only live-check pack. One JSON line per check, PII redacted.
 *
 * Every check takes the session hotel's property lock the way the pane routes do, and runs its HMS CLI with
 * paneStaySpawnEnv. Nothing is saved, booked, cancelled or clicked. Only the operator runs it, on EC2.
 *
 *   party <name> [--kind company|agency|both]            party-lookup.mjs (organization / bookingAgency search)
 *   deeplink --conf <labtest conf> [--stay-id <id>]      hms-deeplink-probe.mjs (GET navigations, new tabs)
 *   rateshop (--org <nativeId> | --agency <nativeId> --name <party name>)
 *            [--arrival YYYY-MM-DD] [--nights 1-30] [--adults 1-9]
 *                                                        fetch-quote.mjs search only: no details, no rate click
 *   stay --conf <labtest conf>                           stay-lookup.mjs find (the pane's find CLI)
 *   quote --arrival YYYY-MM-DD --nights 1-30 --adults 1-9 --room <code>
 *         [--org <nativeId> --org-name <name>] [--agency <nativeId> --agency-name <name>]
 *                                                        the server's staff quote path after approval (installed
 *                                                        runner, property lock): picked parties first, public rates
 *                                                        if HMS flags no negotiated row. In-memory input; nothing saved
 *   <any> --dry-run                                      validates arguments and env; no lock, no spawn, no HMS
 *
 * Exit codes: 0 every check ok, 1 a check refused or failed (or a dry run found a problem), 2 bad arguments.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStayLookupArgs, paneStayLookupEnabled } from '../src/ai/pane-stay-lookup.js';
import { PANE_STAY_PROPERTY_CODE, paneStayPropertyLock, type PaneStayLock } from '../src/ai/pane-stay-save.js';
import { paneStaySpawnEnv } from '../src/ai/pane-stay-spawn-env.js';
import { CENTURION_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import {
  getInstalledStaffQuoteServices,
  readInstalledStaffQuoteConfiguration,
} from '../src/ai/staff-quote-installation.js';
import {
  executeStaffQuote,
  partyContractReviewNote,
  prepareStaffQuote,
  quoteWithPartyFallback,
  staffQuoteInput,
  type StaffQuoteInput,
} from '../src/ai/staff-quote-workflow.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../src/hms/property-read-lock.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const TOOLING = resolve(fileURLToPath(new URL('../tooling/playwright-quote/', import.meta.url)));
const PARTY_CLI = join(TOOLING, 'party-lookup.mjs');
const RATE_CLI = join(TOOLING, 'fetch-quote.mjs');
const PROBE_CLI = join(TOOLING, 'hms-deeplink-probe.mjs');
const RUN_ROOT = join(REPO_ROOT, '.private', 'pms-pipeline', 'v8-live-checks');
const RATE_OUTPUT = join(REPO_ROOT, '.private', 'playwright-quote', 'runs');
// party-lookup.mjs reads at most 80 grid rows. Reaching that many means the list may be incomplete.
const PARTY_ROW_CAP = 80;
// quote-contract.mjs MAX_NIGHTS. The adult cap keeps a rate shop to ordinary occupancy.
const MAX_NIGHTS = 30;
const MAX_ADULTS = 9;
const DEFAULT_ARRIVAL_DAYS = 30;
const CHILD_TIMEOUT_MS = { party: 5 * 60_000, deeplink: 10 * 60_000, rateshop: 10 * 60_000, stay: 5 * 60_000 };
const CONFIRMATION = /^\d+-\d+$/;
const STAY_ID = /^\d{1,12}$/;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const LOOPBACK_CDP = /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;
const PARTY_OK = new Set(['resolved', 'ambiguous', 'no_match']);
const DEEPLINK_OK = new Set(['observed']);
// stay-lookup.mjs exits 0 only for found and not_found; every other outcome exits 1.
const STAY_OK = new Set(['found', 'not_found']);
const RATE_OK = new Set(['quote', 'no_match', 'unavailable']);
const DROPPED_KEYS = new Set([
  'firstname', 'lastname', 'guestname', 'bookername', 'bookeremail', 'email', 'emailaddress', 'phone', 'phonenumber',
  'mobile', 'address', 'postalcode', 'dateofbirth', 'password', 'token', 'cookie', 'secret', 'username', 'reservationnote',
]);
const COMMANDS = ['party', 'deeplink', 'rateshop', 'stay', 'quote'] as const;
// A room type as HMS names it (STQN, DLXQN). The staff quote input carries it as a room code.
const ROOM_CODE = /^[A-Z0-9_-]{1,16}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
type CommandName = (typeof COMMANDS)[number];
const FLAGS_BY_COMMAND: Record<CommandName, readonly string[]> = {
  party: ['kind'],
  deeplink: ['conf', 'stay-id'],
  rateshop: ['org', 'agency', 'name', 'arrival', 'nights', 'adults'],
  stay: ['conf'],
  quote: ['arrival', 'nights', 'adults', 'room', 'org', 'org-name', 'agency', 'agency-name'],
};

export const USAGE = [
  'usage: scripts/v8-live-checks.ts <command> [flags] [--dry-run]',
  '  party <name> [--kind company|agency|both]',
  '  deeplink --conf <labtest confirmation> [--stay-id <id>]',
  '  rateshop (--org <nativeId> | --agency <nativeId> --name <party name>) [--arrival YYYY-MM-DD] [--nights 1-30] [--adults 1-9]',
  '  stay --conf <labtest confirmation>',
  '  quote --arrival YYYY-MM-DD --nights 1-30 --adults 1-9 --room <code> [--org <nativeId> --org-name <name>] [--agency <nativeId> --agency-name <name>]',
  'Each check prints one JSON line. Exit 0 all ok, 1 a check refused or failed, 2 bad arguments.',
].join('\n');

export type PartyKind = 'company' | 'agency';
export type RateSource = { contextKey: 'organization' | 'agency'; nativeId: string; name: string | null };
export type LiveCheck =
  | { check: 'party'; name: string; kinds: PartyKind[] }
  | { check: 'deeplink'; conf: string; stayId: string | null }
  | { check: 'rateshop'; source: RateSource; arrival: string; nights: number; adults: number }
  | { check: 'stay'; conf: string }
  | { check: 'quote'; arrival: string; nights: number; adults: number; room: string; org: PartyPick | null; agency: PartyPick | null };
export type PartyPick = { nativeId: string; name: string };
export type ParsedLiveCheck = { check: LiveCheck; dryRun: boolean };
export type ParseOutcome = { ok: true; value: ParsedLiveCheck } | { ok: false; error: string };

export type CliRun = { code: number | null; stdout: string };
export type PartyCandidate = { nativeId?: unknown; displayName?: unknown; [field: string]: unknown };
export type QuoteOption = {
  room?: { code?: string };
  rate?: { code?: string };
  rateScope?: string;
  eligibility?: string;
  availability?: string;
  nightly?: Array<{ date?: string; price?: { currency?: string; amount?: string } }>;
  calculated?: { ok?: boolean; perRoom?: { amount?: string } };
};
export type QuoteResult = { outcome?: string; groups?: Array<{ id?: string; options?: QuoteOption[] }> };
export type RateRow = {
  group: string | null;
  roomType: string | null;
  planCode: string | null;
  isNegotiatedRate: boolean | null;
  rateScope: string;
  eligibility: string | null;
  availability: string | null;
  rate: {
    currency: string | null;
    perNight: Array<{ date: string | null; amount: string | null }>;
    perRoomSum: string | null;
  };
};

export type LiveCheckDeps = {
  env: NodeJS.ProcessEnv;
  today: () => string;
  writeLine: (line: string) => void;
  lock: () => PaneStayLock | null;
  spawnEnv: () => NodeJS.ProcessEnv;
  runCli: (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<CliRun>;
  newRunId: () => string;
};

const fail = (error: string): ParseOutcome => ({ ok: false, error });
const ok = (value: ParsedLiveCheck): ParseOutcome => ({ ok: true, value });
const elapsed = (started: number): number => Date.now() - started;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** A party name: trimmed, 1 to 100 characters, no control characters. */
export function normalizeName(raw: string): string | null {
  const text = raw.trim();
  if (text.length < 1 || text.length > 100) return null;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return text;
}

function confirmationFlag(raw: string | undefined): string | null {
  return raw !== undefined && raw.length <= 32 && CONFIRMATION.test(raw) ? raw : null;
}

function integerFlag(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

type Tokens =
  | { ok: true; flags: Map<string, string>; positional: string[]; dryRun: boolean }
  | { ok: false; error: string };

// `--flag value` and `--flag=value`. A flag may appear once. `--dry-run` takes no value.
function tokenize(tokens: readonly string[]): Tokens {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let dryRun = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    if (flag === 'dry-run') {
      if (equals >= 0) return { ok: false, error: 'dry_run_takes_no_value' };
      if (dryRun) return { ok: false, error: 'duplicate_flag:dry-run' };
      dryRun = true;
      continue;
    }
    if (flags.has(flag)) return { ok: false, error: `duplicate_flag:${flag}` };
    if (equals >= 0) {
      flags.set(flag, token.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) return { ok: false, error: `missing_value:${flag}` };
    flags.set(flag, next);
    index += 1;
  }
  return { ok: true, flags, positional, dryRun };
}

type PartyFlag = { ok: true; pick: PartyPick | null } | { ok: false; error: string };
/** A picked party is an HMS native id and the name it was picked under. Both or neither. */
function partyPickFlag(flags: Map<string, string>, idFlag: string, nameFlag: string): PartyFlag {
  const nativeId = flags.get(idFlag);
  const rawName = flags.get(nameFlag);
  if (nativeId === undefined) return rawName === undefined ? { ok: true, pick: null } : { ok: false, error: `${nameFlag}_without_${idFlag}` };
  if (!NATIVE_ID.test(nativeId)) return { ok: false, error: 'native_id_invalid' };
  if (rawName === undefined) return { ok: false, error: `${nameFlag}_required` };
  const name = normalizeName(rawName);
  if (name === null) return { ok: false, error: 'name_invalid' };
  return { ok: true, pick: { nativeId, name } };
}

/** Parses argv after the script name. `today` (UTC, YYYY-MM-DD) only sets the default rate shop arrival. */
export function parseLiveCheckArgs(argv: readonly string[], today: string): ParseOutcome {
  const [command, ...rest] = argv;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) return fail('unknown_command');
  const name = command as CommandName;
  const tokens = tokenize(rest);
  if (!tokens.ok) return fail(tokens.error);
  const { flags, positional, dryRun } = tokens;
  for (const flag of flags.keys()) {
    if (!FLAGS_BY_COMMAND[name].includes(flag)) return fail(`unknown_flag:${flag}`);
  }

  if (name === 'party') {
    if (positional.length !== 1) return fail('party_needs_one_name');
    const partyName = normalizeName(positional[0]);
    if (partyName === null) return fail('name_invalid');
    const kindFlag = flags.get('kind') ?? 'both';
    const kinds: PartyKind[] | null =
      kindFlag === 'company' ? ['company'] : kindFlag === 'agency' ? ['agency'] : kindFlag === 'both' ? ['company', 'agency'] : null;
    if (kinds === null) return fail('kind_invalid');
    return ok({ check: { check: 'party', name: partyName, kinds }, dryRun });
  }

  if (name === 'deeplink') {
    if (positional.length !== 0) return fail('unexpected_argument');
    const conf = confirmationFlag(flags.get('conf'));
    if (conf === null) return fail('conf_required_or_invalid');
    const stayId = flags.get('stay-id') ?? null;
    if (stayId !== null && !STAY_ID.test(stayId)) return fail('stay_id_invalid');
    return ok({ check: { check: 'deeplink', conf, stayId }, dryRun });
  }

  if (name === 'quote') {
    if (positional.length !== 0) return fail('unexpected_argument');
    const arrival = flags.get('arrival') ?? '';
    if (!isRealIsoDate(arrival)) return fail('arrival_invalid');
    const nightsRaw = flags.get('nights');
    const nights = nightsRaw === undefined ? null : integerFlag(nightsRaw, 0, 1, MAX_NIGHTS);
    if (nights === null) return fail('nights_invalid');
    const adultsRaw = flags.get('adults');
    const adults = adultsRaw === undefined ? null : integerFlag(adultsRaw, 0, 1, MAX_ADULTS);
    if (adults === null) return fail('adults_invalid');
    const room = flags.get('room') ?? '';
    if (!ROOM_CODE.test(room)) return fail('room_invalid');
    const org = partyPickFlag(flags, 'org', 'org-name');
    if (!org.ok) return fail(org.error);
    const agency = partyPickFlag(flags, 'agency', 'agency-name');
    if (!agency.ok) return fail(agency.error);
    return ok({ check: { check: 'quote', arrival, nights, adults, room, org: org.pick, agency: agency.pick }, dryRun });
  }

  if (name === 'rateshop') {
    if (positional.length !== 0) return fail('unexpected_argument');
    const org = flags.get('org');
    const agency = flags.get('agency');
    if ((org === undefined) === (agency === undefined)) return fail('org_or_agency_required');
    const contextKey: RateSource['contextKey'] = org !== undefined ? 'organization' : 'agency';
    const nativeId = org ?? agency ?? '';
    if (!NATIVE_ID.test(nativeId)) return fail('native_id_invalid');
    const nameFlag = flags.get('name');
    const partyName = nameFlag === undefined ? null : normalizeName(nameFlag);
    if (nameFlag !== undefined && partyName === null) return fail('name_invalid');
    // The agency picker is searched by name and matched on the id, so an agency id alone cannot be quoted.
    if (contextKey === 'agency' && partyName === null) return fail('agency_needs_name');
    const arrival = flags.get('arrival') ?? addDays(today, DEFAULT_ARRIVAL_DAYS);
    if (!isRealIsoDate(arrival)) return fail('arrival_invalid');
    const nights = integerFlag(flags.get('nights'), 1, 1, MAX_NIGHTS);
    if (nights === null) return fail('nights_invalid');
    const adults = integerFlag(flags.get('adults'), 2, 1, MAX_ADULTS);
    if (adults === null) return fail('adults_invalid');
    return ok({
      check: { check: 'rateshop', source: { contextKey, nativeId, name: partyName }, arrival, nights, adults },
      dryRun,
    });
  }

  if (positional.length !== 0) return fail('unexpected_argument');
  const conf = confirmationFlag(flags.get('conf'));
  if (conf === null) return fail('conf_required_or_invalid');
  return ok({ check: { check: 'stay', conf }, dryRun });
}

/** Text redaction for every printed string: URLs, emails and phone-like runs. Confirmation numbers pass through. */
export function redactText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/gi, '<email>')
    .replace(/\+\d[\d\s().-]{6,}\d/g, '<phone>')
    .replace(/\b\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g, '<phone>');
}

/** Drops guest, contact and credential keys at any depth, and redacts every string that is kept. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      out[key] = redactDeep(inner);
    }
    return out;
  }
  return value;
}

// `ok` needs exit code 0 and an outcome from the allowlist, so a run that exited non-zero is never ok.
export function partyCheckLine(input: {
  kind: PartyKind;
  query: string;
  outcome: string;
  exitCode: number | null;
  resultOutcome: string | null;
  candidates: readonly PartyCandidate[];
  ms: number;
}) {
  // A failed run reports no candidates. A list from a run that exited non-zero is not a verified answer.
  const failed = input.outcome === 'failed';
  const results = failed
    ? []
    : input.candidates
        .map((candidate) => ({
          kind: input.kind,
          nativeId: String(candidate.nativeId ?? ''),
          name: String(candidate.displayName ?? ''),
        }))
        .filter((row) => row.nativeId !== '');
  return {
    check: 'party',
    kind: input.kind,
    query: input.query,
    outcome: input.outcome,
    exitCode: input.exitCode,
    resultOutcome: input.resultOutcome,
    results,
    truncated: !failed && input.candidates.length >= PARTY_ROW_CAP,
    ok: input.exitCode === 0 && PARTY_OK.has(input.outcome),
    ms: input.ms,
  };
}

/** A check that never reached its CLI: refused by the lock or a flag. Never ok. */
export function refusedLine(check: string, outcome: string, ms: number) {
  return { check, outcome, exitCode: null, resultOutcome: null, ok: false, ms };
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Booleans for agency, organization and note. The note text, guest names and agency names are never printed. */
export function stayCheckLine(input: {
  outcome: string;
  reason: string | null;
  exitCode: number | null;
  arrivalMismatch: boolean;
  stay: Record<string, unknown> | null;
  reservationNote: boolean;
  ms: number;
}) {
  const stay = input.stay;
  const labtest = /^labtest$/i.test((textOf(stay?.lastName) ?? '').trim());
  return {
    check: 'stay',
    outcome: input.outcome,
    exitCode: input.exitCode,
    resultOutcome: input.outcome,
    reason: input.reason,
    labtest,
    confirmation: labtest ? textOf(stay?.confirmation) : null,
    status: textOf(stay?.status),
    arrival: textOf(stay?.arrival),
    departure: textOf(stay?.departure),
    hasBookingAgency: textOf(stay?.bookingAgency) !== null,
    hasOrganization: textOf(stay?.organization) !== null,
    hasReservationNote: input.reservationNote,
    arrivalMismatch: input.arrivalMismatch,
    ok: input.exitCode === 0 && STAY_OK.has(input.outcome),
    ms: input.ms,
  };
}

function isNegotiated(scope: string | undefined): boolean | null {
  if (scope === 'contextual') return true;
  if (scope === 'public') return false;
  return null;
}

/** Rows from a fetch-quote result. Rates are displayed amounts, not payable totals. */
export function rateRows(result: QuoteResult): RateRow[] {
  const rows: RateRow[] = [];
  for (const group of result.groups ?? []) {
    for (const option of group.options ?? []) {
      const nightly = option.nightly ?? [];
      rows.push({
        group: group.id ?? null,
        roomType: option.room?.code ?? null,
        planCode: option.rate?.code ?? null,
        isNegotiatedRate: isNegotiated(option.rateScope),
        rateScope: option.rateScope ?? 'unknown',
        eligibility: option.eligibility ?? null,
        availability: option.availability ?? null,
        rate: {
          currency: nightly[0]?.price?.currency ?? null,
          perNight: nightly.map((night) => ({ date: night.date ?? null, amount: night.price?.amount ?? null })),
          perRoomSum: option.calculated?.ok === true ? (option.calculated.perRoom?.amount ?? null) : null,
        },
      });
    }
  }
  return rows;
}

export function rateshopCheckLine(input: {
  source: RateSource;
  arrival: string;
  nights: number;
  adults: number;
  outcome: string;
  exitCode: number | null;
  resultOutcome: string | null;
  rows: RateRow[];
  evidence: string | null;
  ms: number;
}) {
  return {
    check: 'rateshop',
    contextKey: input.source.contextKey,
    propertyCode: PANE_STAY_PROPERTY_CODE,
    arrival: input.arrival,
    nights: input.nights,
    adults: input.adults,
    outcome: input.outcome,
    exitCode: input.exitCode,
    resultOutcome: input.resultOutcome,
    // Rates come only from a run that exited 0. fetch-quote can write a quote and still exit 2 (incomplete audit).
    rows: input.exitCode === 0 ? input.rows : [],
    evidence: input.evidence,
    ok: input.exitCode === 0 && RATE_OK.has(input.outcome),
    ms: input.ms,
  };
}

/** The fetch-quote request for a contextual search. Summary details only, so no rate cell is ever clicked. */
export function quoteRequestFor(source: RateSource, arrival: string, nights: number, adults: number) {
  const contextRef = source.name === null ? { nativeId: source.nativeId } : { nativeId: source.nativeId, name: source.name };
  return {
    schemaVersion: 2,
    propertyCode: PANE_STAY_PROPERTY_CODE,
    arrivalDate: arrival,
    departureDate: addDays(arrival, nights),
    rooms: [{ id: 'live-check-1', quantity: 1, adults, children: 0, childAges: [] }],
    rateContext: { [source.contextKey]: contextRef },
    // The pane builder uses Preset whenever a rate context is set (reservationist-business-services).
    search: { salesStrategy: 'Preset' },
    details: 'summary',
  };
}

function planFor(check: LiveCheck): Record<string, unknown> {
  switch (check.check) {
    case 'party':
      return { kinds: check.kinds, spawn: 'party-lookup.mjs', lock: 'property' };
    case 'deeplink':
      return { stayIdGiven: check.stayId !== null, spawn: 'hms-deeplink-probe.mjs', lock: 'property' };
    case 'rateshop':
      return {
        contextKey: check.source.contextKey,
        arrival: check.arrival,
        nights: check.nights,
        adults: check.adults,
        salesStrategy: 'Preset',
        details: 'summary',
        spawn: 'fetch-quote.mjs',
        lock: 'property',
      };
    case 'stay':
      return { spawn: 'stay-lookup.mjs (find)', lock: 'property' };
    case 'quote':
      return {
        arrival: check.arrival,
        nights: check.nights,
        adults: check.adults,
        room: check.room,
        parties: { company: check.org !== null, agency: check.agency !== null },
        path: 'prepareStaffQuote, quoteWithPartyFallback, executeStaffQuote (installed runner)',
        lock: 'property',
      };
  }
}

/** Checks the environment a real run needs, by name and by boolean. No value that could be a secret is printed. */
export function dryRunReport(check: LiveCheck, env: NodeJS.ProcessEnv, spawnEnv: NodeJS.ProcessEnv) {
  const problems: string[] = [];
  const databaseUrlSet = Boolean(env.DATABASE_URL);
  const quoteInputProblem = check.check === 'quote' ? staffQuoteInputProblem(check) : null;
  if (!databaseUrlSet) problems.push('property_lock_unavailable');
  const cdpLoopback = LOOPBACK_CDP.test(spawnEnv.HMS_STAGEHAND_CDP_URL ?? '');
  if (!cdpLoopback) problems.push('cdp_not_loopback_or_unset');
  const borrowedOwnership = spawnEnv.HMS_STAGEHAND_BROWSER_OWNERSHIP === 'borrowed';
  if (!borrowedOwnership) problems.push('browser_ownership_not_borrowed');
  const secretPath = spawnEnv.HMS_QUOTE_SECRET_PATH ?? '';
  const credentialFileFound = (secretPath !== '' && existsSync(secretPath)) || Boolean(spawnEnv.HMS_READ_SECRET_ARN);
  if (!credentialFileFound) problems.push('credential_source_missing');
  if (check.check === 'quote' && !env.RESERVATIONIST_STAFF_QUOTE_CONFIGURATION) problems.push('staff_quote_configuration_missing');
  if (quoteInputProblem) problems.push(quoteInputProblem);
  return {
    check: check.check,
    dryRun: true,
    ok: problems.length === 0,
    problems,
    plan: planFor(check),
    env: { databaseUrlSet, cdpLoopback, borrowedOwnership, credentialFileFound },
  };
}

type Locked<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: 'refused_lock_unavailable' | 'refused_lock_busy' | 'execution_failure' };

// The same acquisition the pane routes use: a bounded wait, and a deadline reads as a busy lock.
async function withPropertyLock<T>(lock: PaneStayLock | null, work: () => Promise<T>): Promise<Locked<T>> {
  if (!lock) return { ok: false, outcome: 'refused_lock_unavailable' };
  try {
    return { ok: true, value: await lock.withLock(work, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS)) };
  } catch (error) {
    return { ok: false, outcome: isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'execution_failure' };
  }
}

function runNodeCli(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliRun> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [file, ...args],
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolvePromise({ code, stdout: String(stdout ?? '') });
      },
    );
  });
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.startsWith('{'))
    .flatMap((text) => {
      try {
        return [JSON.parse(text) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function newRunDir(deps: LiveCheckDeps): string {
  return join(RUN_ROOT, deps.newRunId());
}

type RateshopCheck = { source: RateSource; arrival: string; nights: number; adults: number };
type PartyRun = { outcome: string; exitCode: number | null; resultOutcome: string | null; candidates: PartyCandidate[] };
type QuoteRun = {
  outcome: string;
  exitCode: number | null;
  resultOutcome: string | null;
  rows: RateRow[];
  evidence: string | null;
};
type StayResult = { outcome?: unknown; reason?: unknown; arrivalMismatch?: unknown; stay?: unknown };

async function partyLookup(kind: PartyKind, name: string, deps: LiveCheckDeps): Promise<PartyRun> {
  const dir = newRunDir(deps);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const requestPath = join(dir, 'party-request.json');
  const request =
    kind === 'company'
      ? {
        propertyCode: CENTURION_HMS_READ_TARGET.propertyCode,
        kind: 'organization',
        query: { organizationName: name },
      }
      : {
        propertyCode: CENTURION_HMS_READ_TARGET.propertyCode,
        kind: 'bookingAgency',
        query: { bookingAgencyName: name },
      };
  try {
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    const run = await deps.runCli(PARTY_CLI, ['--request', requestPath], deps.spawnEnv(), CHILD_TIMEOUT_MS.party);
    const envelope = jsonLines(run.stdout).at(-1) ?? null;
    const resultOutcome = textOf(envelope?.outcome);
    const rawCandidates = envelope?.candidates;
    const candidates = Array.isArray(rawCandidates) ? (rawCandidates as PartyCandidate[]) : [];
    // A non-zero exit is a failed lookup. The envelope's own outcome is kept for the reader, and no candidates are reported.
    if (run.code !== 0) return { outcome: 'failed', exitCode: run.code, resultOutcome, candidates: [] };
    if (resultOutcome === null) {
      return { outcome: 'execution_failure', exitCode: run.code, resultOutcome: null, candidates: [] };
    }
    return { outcome: resultOutcome, exitCode: run.code, resultOutcome, candidates };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function partyCheck(kind: PartyKind, name: string, deps: LiveCheckDeps) {
  const started = Date.now();
  const locked = await withPropertyLock(deps.lock(), () => partyLookup(kind, name, deps));
  if (!locked.ok) {
    return partyCheckLine({
      kind,
      query: name,
      outcome: locked.outcome,
      exitCode: null,
      resultOutcome: null,
      candidates: [],
      ms: elapsed(started),
    });
  }
  return partyCheckLine({
    kind,
    query: name,
    outcome: locked.value.outcome,
    exitCode: locked.value.exitCode,
    resultOutcome: locked.value.resultOutcome,
    candidates: locked.value.candidates,
    ms: elapsed(started),
  });
}

async function deeplinkCheck(check: { conf: string; stayId: string | null }, deps: LiveCheckDeps) {
  const started = Date.now();
  const args = ['--property', CENTURION_HMS_READ_TARGET.propertyCode, '--conf', check.conf];
  if (check.stayId !== null) args.push('--stay-id', check.stayId);
  const locked = await withPropertyLock(deps.lock(), () =>
    deps.runCli(PROBE_CLI, args, deps.spawnEnv(), CHILD_TIMEOUT_MS.deeplink),
  );
  if (!locked.ok) return [refusedLine('deeplink', locked.outcome, elapsed(started))];
  const { code, stdout } = locked.value;
  const records = jsonLines(stdout);
  // A probe line is written once its own observation is complete. A child that exits non-zero did not finish cleanly,
  // so none of its lines is reported ok.
  const lines: Array<Record<string, unknown>> = records.map((record) => {
    const probeOutcome = textOf(record.outcome);
    return {
      check: 'deeplink',
      ...record,
      outcome: code === 0 ? probeOutcome : 'failed',
      resultOutcome: probeOutcome,
      exitCode: code,
      ok: code === 0 && probeOutcome !== null && DEEPLINK_OK.has(probeOutcome),
    };
  });
  if (code !== 0) {
    lines.push({
      check: 'deeplink',
      outcome: 'failed',
      exitCode: code,
      resultOutcome: null,
      probesRecorded: records.length,
      ok: false,
      ms: elapsed(started),
    });
  } else if (records.length === 0) {
    lines.push({
      check: 'deeplink',
      outcome: 'execution_failure',
      exitCode: code,
      resultOutcome: null,
      probesRecorded: 0,
      ok: false,
      ms: elapsed(started),
    });
  }
  return lines;
}

async function runQuoteSearch(check: RateshopCheck, deps: LiveCheckDeps): Promise<QuoteRun> {
  const dir = newRunDir(deps);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const requestPath = join(dir, 'quote-request.json');
  try {
    await writeFile(requestPath, JSON.stringify(quoteRequestFor(check.source, check.arrival, check.nights, check.adults)), {
      mode: 0o600,
    });
    const run = await deps.runCli(
      RATE_CLI,
      ['--request', requestPath, '--output', RATE_OUTPUT],
      deps.spawnEnv(),
      CHILD_TIMEOUT_MS.rateshop,
    );
    const evidenceDir = /^Evidence: (.+)$/m.exec(run.stdout)?.[1]?.trim() ?? null;
    // fetch-quote writes result.json before it can exit 2, so the file's own outcome is read for a failed run too.
    const result = evidenceDir === null ? null : await readJsonFile<QuoteResult>(join(evidenceDir, 'result.json'));
    const resultOutcome = textOf(result?.outcome);
    const evidence = evidenceDir === null ? null : relative(REPO_ROOT, evidenceDir);
    if (run.code !== 0) return { outcome: 'failed', exitCode: run.code, resultOutcome, rows: [], evidence };
    if (result === null || resultOutcome === null) {
      return { outcome: 'execution_failure', exitCode: run.code, resultOutcome: null, rows: [], evidence };
    }
    return { outcome: resultOutcome, exitCode: run.code, resultOutcome, rows: rateRows(result), evidence };
  } catch {
    return { outcome: 'execution_failure', exitCode: null, resultOutcome: null, rows: [], evidence: null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function rateshopCheck(check: RateshopCheck, deps: LiveCheckDeps) {
  const started = Date.now();
  const locked = await withPropertyLock(deps.lock(), () => runQuoteSearch(check, deps));
  const common = {
    source: check.source,
    arrival: check.arrival,
    nights: check.nights,
    adults: check.adults,
    ms: elapsed(started),
  };
  if (!locked.ok) {
    return rateshopCheckLine({ ...common, outcome: locked.outcome, exitCode: null, resultOutcome: null, rows: [], evidence: null });
  }
  return rateshopCheckLine({
    ...common,
    outcome: locked.value.outcome,
    exitCode: locked.value.exitCode,
    resultOutcome: locked.value.resultOutcome,
    rows: locked.value.rows,
    evidence: locked.value.evidence,
  });
}

async function stayCheck(check: { conf: string }, deps: LiveCheckDeps) {
  const started = Date.now();
  if (!paneStayLookupEnabled(deps.env)) return refusedLine('stay', 'refused_flag_off', elapsed(started));
  // The pane's find CLI and arguments, run directly so its exit code is read. The pane's own path ignores the code.
  const outDir = newRunDir(deps);
  try {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const locked = await withPropertyLock(deps.lock(), async () => {
      const [script = '', ...args] = buildStayLookupArgs(
        { mode: 'find', confirmation: check.conf, arrival: null },
        outDir,
        CENTURION_HMS_READ_TARGET.propertyCode,
      );
      const run = await deps.runCli(script, args, deps.spawnEnv(), CHILD_TIMEOUT_MS.stay);
      return { run, result: await readJsonFile<StayResult>(join(outDir, 'result.json')) };
    });
    const ms = elapsed(started);
    if (!locked.ok) return refusedLine('stay', locked.outcome, ms);
    const { run, result } = locked.value;
    const resultOutcome = textOf(result?.outcome);
    if (run.code !== 0) {
      return { check: 'stay', outcome: 'failed', exitCode: run.code, resultOutcome, reason: textOf(result?.reason), ok: false, ms };
    }
    if (result === null || resultOutcome === null) {
      return { check: 'stay', outcome: 'execution_failure', exitCode: run.code, resultOutcome: null, reason: null, ok: false, ms };
    }
    const stay = objectOrNull(result.stay);
    return stayCheckLine({
      outcome: resultOutcome,
      reason: textOf(result.reason),
      exitCode: run.code,
      arrivalMismatch: result.arrivalMismatch === true,
      stay,
      reservationNote: textOf(stay?.reservationNote) !== null,
      ms,
    });
  } catch {
    return { check: 'stay', outcome: 'execution_failure', exitCode: null, resultOutcome: null, reason: null, ok: false, ms: elapsed(started) };
  } finally {
    // The lookup writes record screenshots and the guest's form values here. Only booleans leave this process.
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type QuoteCheck = Extract<LiveCheck, { check: 'quote' }>;

/** The staff quote input the pane would send for this check: one group for the room, and the picked parties. */
export function staffQuoteInputFor(check: QuoteCheck, messageId: string, sourceHash: string): StaffQuoteInput {
  const company = check.org ? { kind: 'company' as const, nativeId: check.org.nativeId, name: check.org.name } : null;
  const agency = check.agency ? { kind: 'agency' as const, nativeId: check.agency.nativeId, name: check.agency.name } : null;
  return staffQuoteInput.parse({
    messageId,
    sourceHash,
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [
      {
        id: 'live-check-1',
        arrivalDate: check.arrival,
        departureDate: addDays(check.arrival, check.nights),
        quantity: 1,
        adults: check.adults,
        childrenAges: [],
        board: 'room_only',
        roomCodes: [check.room],
      },
    ],
    ...(company || agency ? { parties: { ...(company ? { company } : {}), ...(agency ? { agency } : {}) } } : {}),
  });
}

function staffQuoteInputProblem(check: QuoteCheck): string | null {
  try {
    staffQuoteInputFor(check, 'dry-run-message', '0'.repeat(64));
    return null;
  } catch {
    return 'staff_quote_input_invalid';
  }
}

/** A caught error as the harness prints it: the stage it came from, identifier-shaped name, code and message. No free text. */
export type QuoteFailure = { stage: string; name: string; code: string | null; message: string };
const IDENTIFIER_TEXT = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
export function quoteFailure(stage: string, error: unknown): QuoteFailure {
  const name = error instanceof Error && IDENTIFIER_TEXT.test(error.name) ? error.name : 'unknown';
  const message = error instanceof Error && IDENTIFIER_TEXT.test(error.message) ? error.message : 'message_redacted';
  return { stage, name, code: quoteErrorCode(error), message };
}

export type QuoteLineInput = {
  error?: QuoteFailure | null;
  party: { company: PartyPick | null; agency: PartyPick | null };
  chosen: { planCode: string; isNegotiatedRate: boolean } | null;
  publicFallback: { copy: string } | null;
  totalMinor: number | null;
  outcome: string;
  code: string | null;
  ms: number;
};

/** One line for a quote: the party picked, the rate HMS chose or the public fallback, the total, the outcome and the time. */
export function quoteCheckLine(line: QuoteLineInput) {
  return {
    check: 'quote',
    ok: line.outcome === 'quote',
    party: line.party,
    ...(line.publicFallback ? { publicFallback: true, copy: line.publicFallback.copy } : { contractChosen: line.chosen }),
    totalMinor: line.totalMinor,
    outcome: line.outcome,
    ...(line.code !== null ? { code: line.code } : {}),
    ...(line.error ? { error: line.error } : {}),
    ms: line.ms,
  };
}

function quoteErrorCode(error: unknown): string | null {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof raw === 'string' && ERROR_CODE.test(raw) ? raw : null;
}

/**
 * The server's staff quote path, as the workstation runs it after approval: the picked parties first, then public rates
 * if HMS flags no negotiated row. Runs under the property lock. Nothing is saved, booked or rendered.
 */
async function quoteCheck(check: QuoteCheck, deps: LiveCheckDeps): Promise<Record<string, unknown>> {
  const started = Date.now();
  const party = { company: check.org, agency: check.agency };
  const failed = (outcome: string, error: QuoteFailure | null) =>
    quoteCheckLine({
      party,
      chosen: null,
      publicFallback: null,
      totalMinor: null,
      outcome,
      code: error?.code ?? null,
      error,
      ms: elapsed(started),
    });
  let propertyCode: string;
  try {
    propertyCode = readInstalledStaffQuoteConfiguration().owner.propertyCode;
  } catch (error) {
    return failed('refused_configuration_unavailable', quoteFailure('configuration', error));
  }
  const messageId = `v8-live-check-${randomUUID()}`;
  const sourceHash = createHash('sha256').update(messageId).digest('hex');
  const input = staffQuoteInputFor(check, messageId, sourceHash);
  const scope = {
    // The route's transport. A live run with another transport is refused by the policy scope.
    transportId: 'transport-centurion',
    userId: 'v8-live-check',
    threadId: messageId,
    messageId,
    sourceHash,
    propertyCode,
    messageAt: new Date().toISOString(),
  };
  const signer = { signerName: 'v8 live check', signerEmail: 'v8-live-check@localhost' };
  const signal = new AbortController().signal;
  // The source behind the revision's rate, read from the same services call that priced it. No second HMS read.
  const captured: Array<{ source: { result: { groups: Array<{ id: string; options: QuoteOption[] }> } }; groupId: string; optionId: string }> = [];
  // Where the attempt is, so a caught error names the step it came from.
  let stage = 'prepare';
  const quoteAt = (attempt: ReturnType<typeof prepareStaffQuote>) => {
    const label = attempt.request.rateContext ? 'party' : 'public';
    stage = `${label}.services`;
    const services = getInstalledStaffQuoteServices(
      { authorizationId: attempt.authorizationId, authorizeContext: async () => true, signer },
      attempt.approval,
    );
    const resolveQuoteTask = services.resolveQuoteTask;
    const authorizeGuestProposal = services.authorizeGuestProposal;
    return executeStaffQuote(
      attempt,
      {
        ...services,
        resolveQuoteTask:
          resolveQuoteTask &&
          (async (quoteContext) => {
            stage = `${label}.resolve_quote_task`;
            const resolved = await resolveQuoteTask(quoteContext);
            stage = `${label}.after_resolve`;
            const selection = resolved.selections[0];
            if (selection) {
              captured.push({ source: await resolved.resolveSource(selection.sourceRef), groupId: selection.groupId, optionId: selection.optionId });
            }
            return resolved;
          }),
        authorizeGuestProposal:
          authorizeGuestProposal &&
          (async (quoteContext, revision, facts) => {
            stage = `${label}.authorize_guest_proposal`;
            return authorizeGuestProposal(quoteContext, revision, facts);
          }),
      },
      async () => true,
    );
  };
  const locked = await withPropertyLock(deps.lock(), async () => {
    try {
      const attempt = await quoteWithPartyFallback({
        input,
        first: prepareStaffQuote(input, scope, signer, signal),
        retry: () => prepareStaffQuote(input, scope, signer, signal, 'public'),
        run: quoteAt,
      });
      return { ok: true as const, attempt };
    } catch (error) {
      return { ok: false as const, failure: quoteFailure(stage, error) };
    }
  });
  if (!locked.ok) return failed(locked.outcome, null);
  if (!locked.value.ok) {
    const failure = locked.value.failure;
    return failed(failure.code === null ? 'execution_failure' : 'refused', failure);
  }
  const { attempt } = locked.value;
  const picked = captured.at(-1);
  const option = picked?.source.result.groups.find((group) => group.id === picked.groupId)?.options.find((o) => o.id === picked.optionId);
  const rateCode = option?.rate?.code;
  return quoteCheckLine({
    party,
    chosen: !attempt.fellBack && rateCode ? { planCode: rateCode, isNegotiatedRate: option?.rateScope === 'contextual' } : null,
    publicFallback: attempt.fellBack ? { copy: partyContractReviewNote(input.parties, attempt.result.groups) ?? '' } : null,
    totalMinor: attempt.result.totalMinor ?? null,
    outcome: 'quote',
    code: null,
    ms: elapsed(started),
  });
}

async function runCheck(check: LiveCheck, deps: LiveCheckDeps): Promise<number> {
  let failed = false;
  const emit = (record: Record<string, unknown>) => {
    if (record.ok !== true) failed = true;
    deps.writeLine(JSON.stringify(redactDeep(record)));
  };
  switch (check.check) {
    case 'party':
      for (const kind of check.kinds) emit(await partyCheck(kind, check.name, deps));
      break;
    case 'deeplink':
      for (const record of await deeplinkCheck(check, deps)) emit(record);
      break;
    case 'rateshop':
      emit(await rateshopCheck(check, deps));
      break;
    case 'stay':
      emit(await stayCheck(check, deps));
      break;
    case 'quote':
      emit(await quoteCheck(check, deps));
      break;
  }
  return failed ? 1 : 0;
}

function defaultDeps(overrides: Partial<LiveCheckDeps>): LiveCheckDeps {
  const env = overrides.env ?? process.env;
  return {
    env,
    today: () => new Date().toISOString().slice(0, 10),
    writeLine: (line) => console.log(line),
    lock: () => paneStayPropertyLock(CENTURION_HMS_READ_TARGET),
    spawnEnv: () => paneStaySpawnEnv(env, undefined, CENTURION_HMS_READ_TARGET),
    runCli: runNodeCli,
    newRunId: () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
}

export async function main(argv: readonly string[], overrides: Partial<LiveCheckDeps> = {}): Promise<number> {
  const deps = defaultDeps(overrides);
  if (argv.length === 0) {
    deps.writeLine(USAGE);
    return 2;
  }
  if (argv[0] === 'help' || argv.includes('--help')) {
    deps.writeLine(USAGE);
    return 0;
  }
  const parsed = parseLiveCheckArgs(argv, deps.today());
  if (!parsed.ok) {
    deps.writeLine(JSON.stringify({ check: 'args', ok: false, error: parsed.error }));
    return 2;
  }
  if (parsed.value.dryRun) {
    const report = dryRunReport(parsed.value.check, deps.env, deps.spawnEnv());
    deps.writeLine(JSON.stringify(redactDeep(report)));
    return report.ok ? 0 : 1;
  }
  return runCheck(parsed.value.check, deps);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // The error name only. Messages can carry the input.
      console.error(`v8-live-checks failed: ${error instanceof Error ? error.name : 'unknown'}`);
      process.exitCode = 2;
    },
  );
}
