/**
 * Sender-domain and mail-body hints for the pane's party picker. They are suggestions only: staff confirm them, and a
 * suggestion never sets a rate context by itself. An HMS id is carried only where the listed table gives one. Every
 * other suggestion is unverified, with no id, and staff find it with Find in HMS.
 */

export type PartyKind = 'company' | 'agency';

export type PartySuggestion = {
  kind: PartyKind;
  name: string;
  nativeId: string | null;
  idStatus: 'listed' | 'unverified';
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
  nativeId?: string;
};

// Listed ids come from the HMS data research: CWT JNB #290, Nexus #27, 360 degrees Travel #113, Tourvest #206.
const SENDER_ALIASES: readonly SenderAlias[] = [
  { domains: ['destinitravel.co.za'], kind: 'agency', name: 'Destini/Club Travel' },
  { domains: ['renniesbcdtravel.com'], kind: 'agency', name: 'Rennies Travel' },
  { domains: ['atlantiscorporate.co.za'], kind: 'agency', name: 'Atlantis Corporate' },
  { domains: ['mycwt.co.za'], kind: 'agency', name: 'CWT JNB', nativeId: '290' },
  { domains: ['nexustravel.co.za'], kind: 'agency', name: 'Nexus', nativeId: '27' },
  { domains: ['360travel.co.za'], kind: 'agency', name: '360 degrees Travel', nativeId: '113' },
  { domains: ['tourvest-mice.co.za', 'tourvestdm.com'], kind: 'company', name: 'Tourvest', nativeId: '206' },
  { domains: ['planettours.co.za'], kind: 'agency', name: 'Planet Africa' },
];

const LABELLED_LINES: ReadonlyArray<{
  pattern: RegExp;
  kind: PartyKind;
  source: PartyMention['source'];
}> = [
  {
    pattern: /^\s*[*>\-•]*\s*travel\s+agency\s+details\s*:\s*(.+?)\s*$/i,
    kind: 'agency',
    source: 'travel_agency_details',
  },
  {
    pattern: /^\s*[*>\-•]*\s*organi[sz]ation\s+details\s*:\s*(.+?)\s*$/i,
    kind: 'company',
    source: 'organization_details',
  },
];

// "... for Bidvest Facilities Management employees" names the company whose staff are travelling.
const EMPLOYEE_LINE = /\bfor\s+(.+?)\s+employees?\b/i;
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

/** Suggests the party a sender's domain belongs to. Null when the domain is not in the table. */
export function suggestPartyFromSender(sender: unknown): PartySuggestion | null {
  const host = senderHost(sender);
  if (!host) return null;
  const alias = SENDER_ALIASES.find((row) =>
    row.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
  if (!alias) return null;
  return {
    kind: alias.kind,
    name: alias.name,
    nativeId: alias.nativeId ?? null,
    idStatus: alias.nativeId ? 'listed' : 'unverified',
  };
}

function cleanPartyName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim();
  if (name.length < 2 || name.length > 120 || /[@<>]|https?:/i.test(name)) return null;
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
  for (const line of body.slice(0, MAX_BODY_CHARS).split(/\r?\n/)) {
    const labelled = LABELLED_LINES.find(({ pattern }) => pattern.test(line));
    if (labelled) {
      const match = line.match(labelled.pattern);
      if (match?.[1]) add(labelled.kind, match[1], labelled.source);
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
