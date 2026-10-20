/**
 * Sender-domain and mail-body hints for the pane's party picker. They are suggestions only: staff confirm them, and a
 * suggestion never sets a rate context by itself. No HMS id is carried here. Every suggestion is unverified, and staff
 * find its HMS id with Find in HMS, so a pick is always the one HMS returns live.
 */
import { lookupLearnedSenderHistory, lookupLearnedSenderParty } from './party-sender-map.js';

export type PartyKind = 'company' | 'agency';

export type PartySuggestion = {
  kind: PartyKind;
  name: string;
  nativeId: null;
  idStatus: 'unverified';
};

export type PartyMention = {
  kind: PartyKind;
  name: string;
  source: 'travel_agency_details' | 'organization_details' | 'employee_line';
};

type SenderAlias = {
  domains: readonly string[];
  kind: PartyKind;
  name: string;
};

const SENDER_ALIASES: readonly SenderAlias[] = [
  { domains: ['destinitravel.co.za'], kind: 'agency', name: 'Destini/Club Travel' },
  { domains: ['renniesbcdtravel.com'], kind: 'agency', name: 'Rennies Travel' },
  { domains: ['atlantiscorporate.co.za'], kind: 'agency', name: 'Atlantis Corporate' },
  { domains: ['mycwt.co.za'], kind: 'agency', name: 'CWT JNB' },
  { domains: ['nexustravel.co.za'], kind: 'agency', name: 'Nexus' },
  { domains: ['360travel.co.za'], kind: 'agency', name: '360 degrees Travel' },
  { domains: ['tourvest-mice.co.za', 'tourvestdm.com'], kind: 'company', name: 'Tourvest' },
  { domains: ['planettours.co.za'], kind: 'agency', name: 'Planet Africa' },
];

const LABELLED_LINES: ReadonlyArray<{
  pattern: RegExp;
  kind: PartyKind;
  source: PartyMention['source'];
}> = [
  {
    pattern: /^[\s*>\-•]{0,10}travel\s{1,5}agency\s{1,5}details\s{0,5}:(.{1,200})$/i,
    kind: 'agency',
    source: 'travel_agency_details',
  },
  {
    pattern: /^[\s*>\-•]{0,10}organi[sz]ation\s{1,5}details\s{0,5}:(.{1,200})$/i,
    kind: 'company',
    source: 'organization_details',
  },
];

// Every quantifier is bounded, and each line is cut to MAX_LINE_CHARS before any match, so hostile spacing cannot make
// matching slow. "... for Bidvest Facilities Management employees" names a company: the name starts with a capital
// letter, so "for 25 employees" and "for many employees" name nothing.
const MAX_LINE_CHARS = 300;
const MAX_NAME_CHARS = 120;
const EMPLOYEE_LINE = /\b[Ff]or\s{1,5}(\p{Lu}[^\n]{0,118}?)\s{1,5}[Ee]mployees?\b/u;
const NOT_A_PARTY_WORD =
  /^(all|any|our|the|my|your|their|his|her|its|this|that|these|those|each|some|staff|new|existing|other)$/i;
const MAX_BODY_CHARS = 20_000;

/** The host part of a sender address, lower-cased. Null when the text holds no usable host. */
function senderHost(sender: unknown): string | null {
  if (typeof sender !== 'string') return null;
  const at = sender.lastIndexOf('@');
  if (at < 0) return null;
  const host = sender
    .slice(at + 1)
    .trim()
    .match(/^[a-z0-9.-]+/i)?.[0]
    ?.toLowerCase()
    .replace(/\.+$/, '');
  return host || null;
}

function unverifiedSuggestion(kind: PartyKind, name: string): PartySuggestion {
  return { kind, name, nativeId: null, idStatus: 'unverified' };
}

function suggestionKey(kind: PartyKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}

/** Static domain alias only. Learned sender history is a separate rank. */
function suggestPartyFromDomain(sender: unknown): PartySuggestion | null {
  const host = senderHost(sender);
  if (!host) return null;
  const alias = SENDER_ALIASES.find((row) =>
    row.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
  return alias ? unverifiedSuggestion(alias.kind, alias.name) : null;
}

/** Suggests the party a sender's domain belongs to. Null when the domain is not in the table. */
export function suggestPartyFromSender(sender: unknown): PartySuggestion | null {
  const fromDomain = suggestPartyFromDomain(sender);
  if (fromDomain) return fromDomain;
  const host = senderHost(sender);
  if (!host) return null;
  const learned = lookupLearnedSenderParty(host);
  if (!learned) return null;
  return unverifiedSuggestion(learned.kind, learned.name);
}

function cleanPartyName(raw: string): string | null {
  const name = raw.slice(0, MAX_NAME_CHARS).replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim();
  if (name.length < 2 || !/\p{L}/u.test(name) || /[@<>]|https?:/i.test(name)) return null;
  return name;
}

/**
 * The company or agency names a mail body states: its "Travel Agency Details:" and "Organization Details:" lines, and
 * a "for X employees" phrase. Nothing is looked up or linked here. Staff confirm each name before it is used.
 */
export function extractPartyMentions(body: unknown): PartyMention[] {
  if (typeof body !== 'string') return [];
  const seen = new Set<string>();
  const out: PartyMention[] = [];
  const add = (kind: PartyKind, raw: string, source: PartyMention['source']) => {
    const name = cleanPartyName(raw);
    if (!name) return;
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name, source });
  };
  for (const raw of body.slice(0, MAX_BODY_CHARS).split(/\r?\n/)) {
    const line = raw.slice(0, MAX_LINE_CHARS);
    const labelled = LABELLED_LINES.map((row) => ({ row, match: line.match(row.pattern) })).find((hit) => hit.match);
    if (labelled) {
      if (labelled.match?.[1]) add(labelled.row.kind, labelled.match[1], labelled.row.source);
      continue;
    }
    const employee = line.match(EMPLOYEE_LINE);
    const phrase = employee?.[1];
    if (phrase && !NOT_A_PARTY_WORD.test(phrase.split(/\s+/)[0] ?? '')) {
      add('company', phrase, 'employee_line');
    }
  }
  return out;
}

export type PartySuggestionView = {
  source: 'sender' | 'body';
  kind: PartyKind;
  name: string;
  nativeId: null;
  idStatus: 'unverified';
};

/**
 * Suggestions for the picker, ranked body mention > learned sender history > domain alias. Domain is a suggestion
 * only and never carries an HMS id. A name from the body never carries one either; staff confirm it with Find in HMS.
 */
export function suggestPartiesFor(input: { sender?: string; body?: string }): PartySuggestionView[] {
  const out: PartySuggestionView[] = [];
  const seen = new Set<string>();
  const push = (row: PartySuggestionView) => {
    const key = suggestionKey(row.kind, row.name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };
  for (const mention of extractPartyMentions(input.body)) {
    push({ source: 'body', ...unverifiedSuggestion(mention.kind, mention.name) });
  }
  const host = senderHost(input.sender);
  if (host) {
    const history = lookupLearnedSenderHistory(host);
    if (history) push({ source: 'sender', ...unverifiedSuggestion(history.kind, history.name) });
    const fromDomain = suggestPartyFromDomain(input.sender);
    if (fromDomain) push({ source: 'sender', ...fromDomain });
  }
  return out;
}
