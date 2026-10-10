import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ReservationistSourceFreshnessProof } from '../ai/draft-approval.js';

export type Board = 'room_only' | 'breakfast' | 'dinner_bed_breakfast';
export type RoomRequest = {
  id: string;
  quantity: number;
  adults: number;
  children: number;
  childAges: number[];
  required?: { roomCodes?: string[]; rateCodes?: string[]; boardBases?: string[] };
};
export type NativeNight = {
  date: string;
  inventory: number;
  price: { amount: string; currency: string };
};
export type NativeOption = {
  id: string;
  room: { code: string; label: string; buildingCode: string | null };
  rate: { code: string; label: string; bundleLabels?: {code?:string;label:string}[] };
  board: string | null;
  appliedContext: Record<string, unknown>;
  /** From the Rate Shop read: 'contextual' only for a row HMS flags as negotiated (isNegotiatedRate). */
  rateScope?: 'public' | 'contextual' | 'unknown';
  eligibility: string;
  availability: string;
  matchStatus: string;
  held: false;
  totals: { taxInclusive: boolean | null };
  nightly: NativeNight[];
};
export type QuoteSourceRecord = {
  ref: string;
  sha256: string;
  toolVersion: string;
  observedAt: string;
  request: {
    propertyCode: string;
    arrivalDate: string;
    departureDate: string;
    rooms: RoomRequest[];
    requestedCurrency: string;
    rateContext?: Record<string, unknown>;
  };
  result: {
    outcome: string;
    propertyCode: string;
    groups: {
      id: string;
      request: RoomRequest;
      completeness: { search: string; requiredFacts: string };
      options: NativeOption[];
    }[];
  };
};
export type InclusionPolicy = {
  ref: string;
  propertyCode: string;
  sourceHashes: string[];
  authoredDates: string[];
  // Original source publication timestamps are distinct from printed invoice-authored dates.
  sourcePublications?: {sourceHash: string; publishedAt: string}[];
  families: { rateCode: string; board: Board }[];
  vat: 'included';
  levy: 'included';
  bundleLabels?: string[];
  restrictions?: { status: 'supported' | 'conflicting' | 'unresolved'; sourceRefs: string[] };
  childMealEntitlement?: {
    status: 'supported' | 'unresolved';
    sourceRefs: string[];
    childAges: number[];
  };
};
export type SelectedQuoteGroup = {
  id: string;
  sourceRef: string;
  sourceHash: string;
  toolVersion: string;
  observedAt: string;
  arrivalDate: string;
  departureDate: string;
  quantity: number;
  adults: number;
  children: number;
  childAges: number[];
  optionId: string;
  roomCode: string;
  roomLabel: string;
  rateCode: string;
  rateLabel: string;
  board: Board;
  currency: string;
  context: Record<string, unknown>;
  // An imported original offer can establish prices without historical stock.
  nightly: { date: string; amountMinor: number; inventory: number | null }[];
  perRoomMinor: number;
  totalMinor: number;
  nativeTaxInclusive: boolean | null;
  nativeBundleLabels?: {code?:string;label:string}[];
  inclusions: {
    policyRef: string;
    sourceHashes: string[];
    authoredDates: string[];
    sourcePublications?: {sourceHash: string; publishedAt: string}[];
    bundleLabels: string[];
    restrictions: InclusionPolicy['restrictions'];
    childMealEntitlement: InclusionPolicy['childMealEntitlement'];
    vat: 'included';
    levy: 'included';
  };
  poolId: string;
};
export type QuoteRevision = {
  version: 1;
  id: string;
  scopeDigest: string;
  propertyCode: string;
  authoredDate: string;
  validity: { days: 3; anchor: 'authored_date'; cutoff: 'unresolved' };
  sourceFreshness?: ReservationistSourceFreshnessProof;
  groups: SelectedQuoteGroup[];
  currency: string;
  totalMinor: number;
  held: false;
  authorizationId: string;
  inventoryStatus: 'observed_not_held' | 'unproven';
};

export function quoteDigest(value: unknown): string {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
/**
 * 'property_room_type' when rows of 2+ room types were pooled property-wide because HMS gave no building: HMS proves
 * each type's availability, not that the types can be booked together, so staff check that in HMS. Else null.
 */
export function propertyPoolBasis(revision: Pick<QuoteRevision, 'propertyCode' | 'groups'>): 'property_room_type' | null {
  const pooled = revision.groups.some((g) => g.poolId === `${revision.propertyCode}:property:${g.roomCode}`);
  return pooled && new Set(revision.groups.map((g) => g.roomCode)).size > 1 ? 'property_room_type' : null;
}
export function occupiedDates(arrival: string, departure: string): string[] {
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('invalid_calendar');
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== s)
      throw new Error('invalid_calendar');
    return d.valueOf();
  };
  const a = parse(arrival),
    b = parse(departure);
  if (b <= a || b - a > 366 * 86400000) throw new Error('invalid_calendar_order');
  return Array.from({ length: (b - a) / 86400000 }, (_, i) =>
    new Date(a + i * 86400000).toISOString().slice(0, 10),
  );
}
export function exactMinor(amount: string): number {
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error('invalid_money_precision');
  const [whole, part] = amount.split('.');
  const n = BigInt(whole) * 100n + BigInt(part);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('money_overflow');
  return Number(n);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const nativeContractPath = fileURLToPath(
  new URL('../../tooling/playwright-quote/quote-contract.mjs', import.meta.url),
);
/** Sources/policies must be resolved by authorized server storage, never accepted from model slots. */
export async function resolveQuoteRevision(input: {
  propertyCode: string;
  authoredDate: string;
  selections: { sourceRef: string; groupId: string; optionId: string }[];
  resolveSource: (ref: string) => Promise<QuoteSourceRecord>;
  resolvePolicy: (property: string, rate: string, board: Board) => Promise<InclusionPolicy | null>;
  admission: {
    authorizationId: string;
    sourceEvaluationAt: string;
    maxSourceAgeMs: number;
    expectedRequests: Record<string, QuoteSourceRecord['request']>;
    authorizeSource: (ref: string, authorizationId: string) => Promise<boolean>;
  };
}): Promise<QuoteRevision> {
  if (
    !input.admission ||
    !input.admission.authorizationId ||
    !Number.isSafeInteger(input.admission.maxSourceAgeMs) ||
    input.admission.maxSourceAgeMs < 0 ||
    !input.admission.authorizeSource
  )
    throw new Error('authorization_admission_required');
  occupiedDates(
    input.authoredDate,
    new Date(new Date(`${input.authoredDate}T00:00:00Z`).valueOf() + 86400000)
      .toISOString()
      .slice(0, 10),
  );
  if (!input.selections.length || input.selections.length > 64)
    throw new Error('selection_required');
  const native = (await import(pathToFileURL(nativeContractPath).href)) as {
    sumDisplayedRates: (
      n: { date: string; amount: string; currency: string }[],
      q: number,
    ) => { ok: boolean; perRoom?: { amount: string }; forQuantity?: { amount: string } };
  };
  const groups: SelectedQuoteGroup[] = [],
    seen = new Set<string>(),
    unbuilt = new Set<string>();
  for (const selection of input.selections) {
    const key = `${selection.sourceRef}|${selection.groupId}`;
    if (seen.has(key)) throw new Error('duplicate_selection');
    seen.add(key);
    const s = await input.resolveSource(selection.sourceRef);
    if (
      s.ref !== selection.sourceRef ||
      !/^[a-f0-9]{64}$/.test(s.sha256) ||
      !s.toolVersion ||
      !Number.isFinite(Date.parse(s.observedAt))
    )
      throw new Error('invalid_source_provenance');
    if (input.admission) {
      if (!(await input.admission.authorizeSource(s.ref, input.admission.authorizationId)))
        throw new Error('source_unauthorized');
      const expected = input.admission.expectedRequests[s.ref];
      if (!expected || quoteDigest(expected) !== quoteDigest(s.request))
        throw new Error('authorized_request_mismatch');
      const age = Date.parse(input.admission.sourceEvaluationAt) - Date.parse(s.observedAt);
      if (!Number.isFinite(age) || age < 0 || age > input.admission.maxSourceAgeMs)
        throw new Error('source_time_out_of_scope');
    }
    if (
      s.request.propertyCode !== input.propertyCode ||
      s.result.propertyCode !== input.propertyCode
    )
      throw new Error('wrong_property');
    if (s.result.outcome !== 'quote') throw new Error('incomplete_quote');
    const matches = s.result.groups.filter((g) => g.id === selection.groupId),
      requests = s.request.rooms.filter((g) => g.id === selection.groupId);
    if (matches.length !== 1 || requests.length !== 1) throw new Error('group_identity');
    const g = matches[0],
      req = requests[0];
    if (quoteDigest(g.request) !== quoteDigest(req)) throw new Error('request_identity');
    if (
      !Number.isSafeInteger(req.quantity) ||
      req.quantity < 1 ||
      !Number.isSafeInteger(req.adults) ||
      req.adults < 1 ||
      req.children !== req.childAges.length ||
      req.childAges.some((a) => !Number.isInteger(a) || a < 0 || a > 17)
    )
      throw new Error('invalid_occupancy');
    if (g.completeness.search !== 'complete' || g.completeness.requiredFacts !== 'complete')
      throw new Error('incomplete_source');
    const options = g.options.filter((o) => o.id === selection.optionId);
    if (options.length !== 1) throw new Error('option_identity');
    const o = options[0];
    if (
      o.eligibility !== 'verified' ||
      o.availability !== 'available' ||
      o.matchStatus !== 'match' ||
      o.held !== false
    )
      throw new Error('unqualified_option');
    if (
      (req.required?.roomCodes && !req.required.roomCodes.includes(o.room.code)) ||
      (req.required?.rateCodes && !req.required.rateCodes.includes(o.rate.code))
    )
      throw new Error('wrong_room_rate');
    const board: Board | undefined = (
      {
        'Room Only R': 'room_only',
        'Bed & Breakfast R': 'breakfast',
        'Dinner Bed & Breakfast R': 'dinner_bed_breakfast',
        'Dinner, Bed & Breakfast R': 'dinner_bed_breakfast',
        'Dinner, Bed, Breakfast & Beverage R': 'dinner_bed_breakfast',
      } as Record<string, Board>
    )[o.board ?? ''];
    if (!board) throw new Error('unknown_board');
    if (req.required?.boardBases && !req.required.boardBases.includes(board))
      throw new Error('wrong_board');
    for (const [kind, ref] of Object.entries(s.request.rateContext ?? {})) {
      const evidence = o.appliedContext[kind] as Record<string, unknown> | undefined,
        requested = ref as Record<string, unknown>;
      if (
        !evidence ||
        (requested.nativeId
          ? String(evidence.id) !== String(requested.nativeId)
          : (requested.code && evidence.code !== requested.code) ||
            (requested.name && evidence.name !== requested.name))
      )
        throw new Error('context_entitlement');
    }
    const dates = occupiedDates(s.request.arrivalDate, s.request.departureDate);
    if (
      o.nightly.length !== dates.length ||
      new Set(o.nightly.map((n) => n.date)).size !== dates.length ||
      o.nightly.some((n) => !dates.includes(n.date))
    )
      throw new Error('night_coverage');
    const currency = o.nightly[0]?.price.currency;
    if (
      !currency ||
      currency !== s.request.requestedCurrency ||
      !/^[A-Z]{3}$/.test(currency) ||
      o.nightly.some((n) => n.price.currency !== currency)
    )
      throw new Error('mixed_currency');
    const nightly = dates.map((date) => {
      const n = o.nightly.find((n) => n.date === date)!;
      const amountMinor = exactMinor(n.price.amount);
      if (amountMinor <= 0) throw new Error('unexplained_zero');
      if (!Number.isInteger(n.inventory) || n.inventory < req.quantity)
        throw new Error('insufficient_inventory');
      return { date, amountMinor, inventory: n.inventory };
    });
    const sums = native.sumDisplayedRates(
      o.nightly.map((n) => ({ date: n.date, ...n.price })),
      req.quantity,
    );
    if (!sums.ok || !sums.perRoom || !sums.forQuantity) throw new Error('native_sum_failure');
    const policy = await input.resolvePolicy(input.propertyCode, o.rate.code, board);
    if (
      !policy ||
      policy.propertyCode !== input.propertyCode ||
      !policy.sourceHashes.length ||
      policy.sourceHashes.some((h) => !/^[a-f0-9]{64}$/.test(h)) ||
      (!policy.authoredDates.length && (!policy.sourcePublications?.length || policy.sourceHashes.some(h=>!policy.sourcePublications!.some(p=>p.sourceHash===h)))) ||
      (policy.sourcePublications?.some(p=>!policy.sourceHashes.includes(p.sourceHash)||!Number.isFinite(Date.parse(p.publishedAt))||Date.parse(p.publishedAt)>Date.parse(input.admission.sourceEvaluationAt))??false) ||
      policy.vat !== 'included' ||
      policy.levy !== 'included' ||
      !policy.families.some((f) => f.rateCode === o.rate.code && f.board === board) ||
      o.totals.taxInclusive === false
    )
      throw new Error('unqualified_inclusions');
    for (const date of policy.authoredDates)
      occupiedDates(
        date,
        new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10),
      );
    if (
      policy.restrictions &&
      (policy.restrictions.status !== 'supported' || !policy.restrictions.sourceRefs.length)
    )
      throw new Error('restriction_unproven');
    if (
      req.children > 0 &&
      board !== 'room_only' &&
      (!policy.childMealEntitlement ||
        policy.childMealEntitlement.status !== 'supported' ||
        !policy.childMealEntitlement.sourceRefs.length ||
        req.childAges.some((age) => !policy.childMealEntitlement!.childAges.includes(age)))
    )
      throw new Error('child_meal_entitlement_unproven');
    if (!o.room.buildingCode && o.room.buildingCode!==null) throw new Error('inventory_pool_unknown');
    groups.push({
      id: selection.groupId,
      sourceRef: s.ref,
      sourceHash: s.sha256,
      toolVersion: s.toolVersion,
      observedAt: s.observedAt,
      arrivalDate: s.request.arrivalDate,
      departureDate: s.request.departureDate,
      quantity: req.quantity,
      adults: req.adults,
      children: req.children,
      childAges: [...req.childAges],
      optionId: o.id,
      roomCode: o.room.code,
      roomLabel: o.room.label,
      rateCode: o.rate.code,
      rateLabel: o.rate.label,
      board,
      currency,
      context: structuredClone(o.appliedContext),
      nightly,
      perRoomMinor: exactMinor(sums.perRoom.amount),
      totalMinor: exactMinor(sums.forQuantity.amount),
      nativeTaxInclusive: o.totals.taxInclusive,
      ...(o.rate.bundleLabels?.length ? {nativeBundleLabels:structuredClone(o.rate.bundleLabels)} : {}),
      inclusions: {
        policyRef: policy.ref,
        sourceHashes: [...policy.sourceHashes],
        authoredDates: [...policy.authoredDates],
        ...(policy.sourcePublications?.length?{sourcePublications:structuredClone(policy.sourcePublications)}:{}),
        bundleLabels: [...(policy.bundleLabels ?? [])],
        restrictions: structuredClone(policy.restrictions),
        childMealEntitlement: structuredClone(policy.childMealEntitlement),
        vat: policy.vat,
        levy: policy.levy,
      },
      // No HMS building: one row keeps its own source pool; several rows share one pool per room type.
      poolId: o.room.buildingCode?`${input.propertyCode}:${o.room.buildingCode}:${o.room.code}`:input.selections.length===1?`${input.propertyCode}:source:${s.ref}:${selection.groupId}:${o.room.code}`:`${input.propertyCode}:property:${o.room.code}`,
    });
    if (o.room.buildingCode === null) unbuilt.add(o.room.code);
  }
  // A room type HMS gave no building for on any selected row is one property-wide pool for every row of that type.
  if (input.selections.length > 1)
    for (const g of groups) if (unbuilt.has(g.roomCode)) g.poolId = `${input.propertyCode}:property:${g.roomCode}`;
  const pools = new Map<string, { demand: number; supply: number }>();
  for (const g of groups)
    for (const n of g.nightly) {
      if (n.inventory === null) throw new Error('native_inventory_unproven');
      const key = `${g.poolId}|${n.date}`,
        old = pools.get(key);
      if (old && old.supply !== n.inventory) throw new Error('inventory_observations_disagree');
      pools.set(key, { demand: (old?.demand ?? 0) + g.quantity, supply: n.inventory });
    }
  if ([...pools.values()].some((p) => p.demand > p.supply))
    throw new Error('joint_inventory_insufficient');
  if (new Set(groups.map((g) => g.currency)).size !== 1) throw new Error('mixed_currency');
  const totalMinor = groups.reduce((n, g) => n + g.totalMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) throw new Error('money_overflow');
  const scopeDigest = quoteDigest(
    groups.map((g) => ({
      arrival: g.arrivalDate,
      departure: g.departureDate,
      quantity: g.quantity,
      adults: g.adults,
      childAges: g.childAges,
      room: g.roomCode,
      rate: g.rateCode,
      board: g.board,
      currency: g.currency,
      context: g.context,
    })),
  );
  const oldestObservation = Math.min(...groups.map(group => Date.parse(group.observedAt)));
  const freshnessExpiry = oldestObservation + input.admission.maxSourceAgeMs;
  if (!Number.isFinite(freshnessExpiry) || Math.abs(freshnessExpiry) > 8640000000000000) throw new Error('source_time_out_of_scope');
  const data = {
    sourceFreshness: {
      authorizationId: input.admission.authorizationId,
      sourceRefs: [...new Set(groups.map(group => group.sourceRef))],
      observedAt: new Date(oldestObservation).toISOString(),
      expiresAt: new Date(freshnessExpiry).toISOString(),
      purpose: 'offer_source' as const,
    },
    authorizationId: input.admission.authorizationId,
    inventoryStatus: 'observed_not_held' as const,
    version: 1 as const,
    propertyCode: input.propertyCode,
    authoredDate: input.authoredDate,
    validity: { days: 3 as const, anchor: 'authored_date' as const, cutoff: 'unresolved' as const },
    scopeDigest,
    groups,
    currency: groups[0].currency,
    totalMinor,
    held: false as const,
  };
  return freeze({ ...data, id: `quote:${quoteDigest(data)}` });
}
export function assessQuoteAcceptance(input: {
  revision: QuoteRevision;
  acceptedAt: string;
  sourceEvaluationAt?: string;
  scopeDigest: string;
  availabilityVerified?: boolean;
  currentTotalMinor?: number;
  superseded?: boolean;
  sentProof?: {
    revisionId: string;
    authorizationId: string;
    sentAt: string;
    sourceRef: string;
    sourceHash: string;
  };
  inventoryEvidence?: {
    revisionId: string;
    scopeDigest: string;
    authorizationId: string;
    observedAt: string;
    available: boolean;
    maxAgeMs: number;
  };
}): { status: string; agreedTotalMinor?: number } {
  if (input.superseded) return { status: 'superseded' };
  if (input.scopeDigest !== input.revision.scopeDigest) return { status: 'scope_changed' };
  const authored = Date.parse(`${input.revision.authoredDate}T00:00:00Z`);
  if (
    !Number.isFinite(authored) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.revision.authoredDate) ||
    new Date(authored).toISOString().slice(0, 10) !== input.revision.authoredDate
  )
    return { status: 'invalid_time' };
  const { id, ...revisionData } = input.revision;
  if (id !== `quote:${quoteDigest(revisionData)}`) return { status: 'invalid_revision' };
  const time = Date.parse(input.acceptedAt);
  if (!Number.isFinite(time)) return { status: 'invalid_time' };
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
  const elapsed =
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${input.revision.authoredDate}T00:00:00Z`)) /
    86400000;
  if (elapsed < 0) return { status: 'invalid_time' };
  if (elapsed > 3) return { status: 'expired' };
  if (elapsed === 3) return { status: 'boundary_check' };
  const sent = input.sentProof,
    stock = input.inventoryEvidence;
  if (
    !sent ||
    sent.revisionId !== input.revision.id ||
    sent.authorizationId !== input.revision.authorizationId ||
    !sent.sourceRef ||
    !/^[a-f0-9]{64}$/.test(sent.sourceHash) ||
    !Number.isFinite(Date.parse(sent.sentAt)) ||
    Date.parse(sent.sentAt) > time
  )
    return { status: 'sent_offer_unproven' };
  const stockEvaluation = input.sourceEvaluationAt === undefined ? time : Date.parse(input.sourceEvaluationAt);
  if (!Number.isFinite(stockEvaluation) || stockEvaluation < time) return { status: 'invalid_time' };
  const stockAge = stock ? stockEvaluation - Date.parse(stock.observedAt) : NaN;
  if (
    !stock ||
    stock.revisionId !== input.revision.id ||
    stock.scopeDigest !== input.revision.scopeDigest ||
    stock.authorizationId !== input.revision.authorizationId ||
    stock.available !== true ||
    !Number.isSafeInteger(stock.maxAgeMs) ||
    stock.maxAgeMs < 0 ||
    !Number.isFinite(stockAge) ||
    stockAge < 0 ||
    stockAge > stock.maxAgeMs
  )
    return { status: 'availability_unproven' };
  return { status: 'accepted', agreedTotalMinor: input.revision.totalMinor };
}

export type ImportedOfferSource = {
  sourceFreshness?: import('../ai/draft-approval.js').ReservationistSourceFreshnessProof;
  ref: string;
  sourceHash: string;
  authorizationId: string;
  scopeDigest: string;
  propertyCode: string;
  currency: string;
  printedDate: string;
  sentAt: string;
  validUntil: string;
  terms: string;
  lines: { id: string; page: number; quote: string; amount: string }[];
};
export type ImportedOffer = ImportedOfferSource & {
  id: string;
  kind: 'imported_offer';
  totalMinor: number;
  inventoryStatus: 'unproven';
  held: false;
};
function assertDate(date: string): void {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== date
  )
    throw new Error('invalid_calendar');
}
/** Source storage owns original-line verification and authorization; no fabricated source nights. */
export async function resolveImportedOffer(input: {
  ref: string;
  authorizationId: string;
  evaluationAt: string;
  resolveSource: (ref: string) => Promise<ImportedOfferSource>;
  authorizeSource: (ref: string, authorizationId: string) => Promise<boolean>;
}): Promise<ImportedOffer> {
  const s = structuredClone(await input.resolveSource(input.ref));
  if (
    !input.authorizationId ||
    s.ref !== input.ref ||
    s.authorizationId !== input.authorizationId ||
    !(await input.authorizeSource(s.ref, input.authorizationId)) ||
    !/^[a-f0-9]{64}$/.test(s.sourceHash) ||
    !/^[a-f0-9]{64}$/.test(s.scopeDigest)
  )
    throw new Error('unauthorized_imported_offer');
  assertDate(s.printedDate);
  assertDate(s.validUntil);
  const observed = Date.parse(s.sentAt),
    evaluation = Date.parse(input.evaluationAt);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(evaluation) ||
    observed > evaluation ||
    s.validUntil < s.printedDate ||
    !s.propertyCode ||
    !/^[A-Z]{3}$/.test(s.currency) ||
    !s.terms.trim() ||
    s.terms.length > 4096 ||
    s.lines.length < 1 ||
    s.lines.length > 64
  )
    throw new Error('invalid_imported_offer');
  const ids = new Set<string>();
  let totalMinor = 0;
  for (const line of s.lines) {
    if (
      !line.id ||
      ids.has(line.id) ||
      !Number.isInteger(line.page) ||
      line.page < 1 ||
      line.page > 50 ||
      !line.quote.trim() ||
      line.quote.length > 4096
    )
      throw new Error('invalid_imported_line');
    ids.add(line.id);
    totalMinor += exactMinor(line.amount);
  }
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0)
    throw new Error('invalid_imported_total');
  const data = {
    ...s,
    kind: 'imported_offer' as const,
    totalMinor,
    inventoryStatus: 'unproven' as const,
    held: false as const,
  };
  return freeze({ ...data, id: `offer:${quoteDigest(data)}` });
}
export type QuoteOverrideApproval = {
  ref: string;
  authorizationId: string;
  revisionId: string;
  sourceHash: string;
  actorRef: string;
  reason: string;
  approvedAt: string;
  amount: string;
  currency: string;
};
/** Separate adjustment packet retains source revision; native quote renderer must not synthesize nights from it. */
export async function resolveApprovedOverride(input: {
  revision: QuoteRevision;
  ref: string;
  evaluationAt: string;
  resolveApproval: (ref: string) => Promise<QuoteOverrideApproval>;
  authorizeActor: (approval: QuoteOverrideApproval) => Promise<boolean>;
}): Promise<
  QuoteOverrideApproval & {
    id: string;
    kind: 'approved_override';
    originalTotalMinor: number;
    approvedTotalMinor: number;
    sourceRevision: QuoteRevision;
  }
> {
  const { id: revisionId, ...revisionData } = input.revision;
  if (revisionId !== `quote:${quoteDigest(revisionData)}`) throw new Error('invalid_revision');
  const approval = structuredClone(await input.resolveApproval(input.ref));
  const time = Date.parse(approval.approvedAt),
    evaluation = Date.parse(input.evaluationAt);
  if (
    approval.ref !== input.ref ||
    approval.authorizationId !== input.revision.authorizationId ||
    approval.revisionId !== input.revision.id ||
    !/^[a-f0-9]{64}$/.test(approval.sourceHash) ||
    !approval.actorRef ||
    !approval.reason.trim() ||
    approval.reason.length > 1024 ||
    !Number.isFinite(time) ||
    !Number.isFinite(evaluation) ||
    time > evaluation ||
    approval.currency !== input.revision.currency ||
    !(await input.authorizeActor(approval))
  )
    throw new Error('unauthorized_override');
  const approvedTotalMinor = exactMinor(approval.amount),
    data = {
      ...approval,
      kind: 'approved_override' as const,
      originalTotalMinor: input.revision.totalMinor,
      approvedTotalMinor,
      sourceRevision: structuredClone(input.revision),
    };
  return freeze({ ...data, id: `override:${quoteDigest(data)}` });
}
