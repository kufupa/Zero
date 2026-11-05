import { sendableArrival, type StayRecordWire } from './amend-find';

export type SavedStayAmendDraft = {
  arrival: string;
  departure: string;
  nights: string;
  adults: string;
  children: string;
  childAges: string;
};

/** Not an approval. The server must bind identity, source, preimage and proposal to a durable grant. */
export type SavedStayAmendProposal = {
  confirmation: string;
  changes: {
    arrival?: string;
    departure?: string;
    adults?: number;
    children?: number;
    childAges?: number[];
  };
};

export type SavedStayAmendEditorIdentity = {
  propertyCode: string; threadId: string; messageId: string; mailboxEmail: string; sourceHash: string;
};

export type SavedStayAmendDraftUpdate = {
  identity: SavedStayAmendEditorIdentity;
  confirmation: string;
  extractionRevision: string;
  /** Local comparison only. Not an HMS freshness proof or a write grant. */
  basis: string | null;
  proposal: SavedStayAmendProposal | null;
  errors: string[];
};

/** Compare the full displayed stay and extracted dates. This string contains stay data, not a security hash. */
export type SavedStayAmendRequest = { arrival?: string | null; departure?: string | null;
  adults?: number | null; children?: number | null; childAges?: number[] | null;
  cleared?: Partial<Record<'arrival' | 'departure' | 'adults' | 'children', boolean>> };

export function savedStayAmendReviewBasis(stay: StayRecordWire,
  request: SavedStayAmendRequest, extractionRevision: string): string {
  const fields = Object.entries(stay).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => [key, typeof value, value]);
  return JSON.stringify([extractionRevision, request, fields]);
}

/** Candidate only: the server must resolve property/ownership, re-read the preimage and issue the grant. */
export type SavedStayCloudWriteCandidate = {
  executor: 'cloud-write/v1';
  action: 'amend';
  propertyCode: string;
  payload: {
    source: { threadId: string; messageId: string; mailboxEmail: string; sourceHash: string };
    extractionRevision: string;
    /** Local UI comparison, not a replacement for the server-owned preimage. */
    basis: string;
    proposal: SavedStayAmendProposal;
    preimageRef: string;
  };
};

/** This result must come from a durable writer and an independently reopened, identity-checked stay. */
export type SavedStayAmendResult = {
  propertyCode: string;
  threadId: string;
  messageId: string;
  mailboxEmail: string;
  sourceHash: string;
  extractionRevision: string;
  basis: string;
  confirmation: string;
  state: 'not_dispatched' | 'needs_check' | 'verified';
  proposal: SavedStayAmendProposal;
  readback?: { arrival: string | null; departure: string | null; adults: number | null; children: number | null;
    childAges: number[] | null; averageRate: string | null; grandTotal: string | null };
  screenshotRef?: { runId: string; name: string } | null;
};

export function amendmentReadbackDifferences(result: SavedStayAmendResult): string[] {
  const readback = result.readback;
  if (!readback) return ['HMS read-back not available.'];
  const changes = result.proposal.changes;
  const differences: string[] = [];
  for (const field of ['arrival', 'departure', 'adults', 'children'] as const) {
    if (changes[field] !== undefined && changes[field] !== readback[field]) {
      differences.push(`${field}: HMS read-back differs from the request or is not shown.`);
    }
  }
  if (changes.childAges && JSON.stringify(changes.childAges) !== JSON.stringify(readback.childAges)) {
    differences.push('Child ages: HMS read-back differs from the request or is not shown.');
  }
  return differences;
}

export function initialSavedStayAmendDraft(stay: StayRecordWire, request: SavedStayAmendRequest): SavedStayAmendDraft {
  const arrival = request.cleared?.arrival ? '' : request.arrival ?? stay.arrival ?? '';
  const departure = request.cleared?.departure ? '' : request.departure ?? stay.departure ?? '';
  const nights = (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000;
  return {
    arrival, departure,
    nights: Number.isInteger(nights) && nights > 0 ? String(nights) : '',
    adults: request.cleared?.adults ? '' : request.adults == null ? (stay.adults == null ? '' : String(stay.adults)) : String(request.adults),
    children: request.cleared?.children ? '' : request.children == null ? (stay.children == null ? '' : String(stay.children)) : String(request.children),
    childAges: request.childAges?.join(', ') ?? stay.childAges?.join(', ') ?? '',
  };
}

function count(value: string, minimum: number, maximum: number): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= minimum && n <= maximum ? n : null;
}

/** Build a request, not a rate calculation, approval or dispatch decision. */
export function savedStayAmendProposal(confirmation: string, stay: StayRecordWire, draft: SavedStayAmendDraft): {
  proposal: SavedStayAmendProposal | null; errors: string[];
} {
  const errors: string[] = [];
  if (!stay.confirmation || confirmation.trim() !== stay.confirmation.trim()) {
    return { proposal: null, errors: ['The selected booking does not match the HMS record.'] };
  }
  const changes: SavedStayAmendProposal['changes'] = {};
  const arrival = sendableArrival(draft.arrival), departure = sendableArrival(draft.departure);
  if (!arrival || !departure || arrival >= departure) errors.push('Enter valid arrival and departure dates, with departure after arrival.');
  else {
    if (arrival !== stay.arrival) changes.arrival = arrival;
    if (departure !== stay.departure) changes.departure = departure;
  }
  const adults = count(draft.adults, 1, 16), children = count(draft.children, 0, 9);
  if (adults === null) errors.push('Enter the number of adults (1–16).');
  else if (adults !== stay.adults) changes.adults = adults;
  if (children === null) errors.push('Enter the number of children (0–9).');
  else if (children !== stay.children) changes.children = children;

  const agesText = draft.childAges.trim();
  if (agesText || (children === 0 && changes.children !== undefined)) {
    const parts = agesText ? agesText.split(',').map((part) => part.trim()) : [];
    const ages = parts.map((part) => count(part, 0, 17));
    if (children === null || ages.some((age) => age === null) || ages.length !== children) {
      errors.push('Enter one age from 0–17 for each child.');
    } else {
      if (changes.children !== undefined || !Array.isArray(stay.childAges) ||
          JSON.stringify(ages) !== JSON.stringify(stay.childAges)) {
        changes.children = children;
        changes.childAges = ages as number[];
      }
    }
  } else if ((changes.children !== undefined && children !== 0) || (stay.childAges?.length ?? 0) > 0) {
    errors.push('Enter one age for each child.');
  }

  if (!Object.keys(changes).length) errors.push('Choose a change to the booking.');
  if (!confirmation.trim()) errors.push('Select the booking first.');
  return { proposal: errors.length ? null : { confirmation, changes }, errors };
}
