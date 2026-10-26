import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { MAIL_KINDS, workEvent, workItem } from '../db/schema/work.js';
import type { QuoteSalesStrategy, QuoteSalesStrategyCode } from '../hms/rate-catalogue.js';
import { getPropertyTransportIds } from '../../tooling/playwright-quote/property-registry.mjs';
import type { StaffQuoteParties } from './staff-quote-workflow.js';

const STRATEGY_CODES = new Set<string>(['BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER']);
const MAIL_KIND_SET = new Set<string>(MAIL_KINDS);
const NATIVE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ACTOR_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PROPERTY = /^[A-Z0-9_-]{2,16}$/;
const TRANSPORT = /^transport-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type OpaquePartyRef = { agencyNativeId?: string; companyNativeId?: string };
export type StaffRatePick = {
  strategy: QuoteSalesStrategyCode;
  property: string;
  transportId: string;
  partyRef: OpaquePartyRef | null;
  actorUserId: string;
  mailKind: (typeof MAIL_KINDS)[number];
};
export type LoggedStaffRatePick = StaffRatePick & { at: Date };
export type StaffRateRankContext = {
  property?: string;
  transportId?: string;
  partyRef?: OpaquePartyRef | null;
  picks?: readonly LoggedStaffRatePick[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nativeIdOf(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return NATIVE_ID.test(id) ? id : null;
}

export function staffRateStrategyCode(value: unknown): QuoteSalesStrategyCode | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase() === 'GOVERNMENT' ? 'GOV' : value.trim().toUpperCase();
  return STRATEGY_CODES.has(code) ? (code as QuoteSalesStrategyCode) : null;
}

function partyIds(agency: unknown, company: unknown): OpaquePartyRef | null {
  const agencyNativeId = nativeIdOf(agency);
  const companyNativeId = nativeIdOf(company);
  if (!agencyNativeId && !companyNativeId) return null;
  return { ...(agencyNativeId ? { agencyNativeId } : {}), ...(companyNativeId ? { companyNativeId } : {}) };
}

export function opaquePartyRef(parties: StaffQuoteParties | null | undefined): OpaquePartyRef | null {
  return partyIds(parties?.agency?.nativeId, parties?.company?.nativeId);
}

export function parseStaffRatePick(value: unknown): StaffRatePick | null {
  const row = record(value);
  if (!row) return null;
  const strategy = staffRateStrategyCode(row.strategy);
  const property = typeof row.property === 'string' ? row.property.trim().toUpperCase() : '';
  const transportId = typeof row.transportId === 'string' ? row.transportId.trim() : '';
  const actorUserId = typeof row.actorUserId === 'string' ? row.actorUserId.trim() : '';
  const mailKind = typeof row.mailKind === 'string' ? row.mailKind.trim() : '';
  if (
    !strategy ||
    !PROPERTY.test(property) ||
    !TRANSPORT.test(transportId) ||
    !ACTOR_ID.test(actorUserId) ||
    actorUserId.includes('@') ||
    !MAIL_KIND_SET.has(mailKind)
  ) {
    return null;
  }
  const party = record(row.partyRef);
  return {
    strategy,
    property,
    transportId,
    partyRef: partyIds(party?.agencyNativeId, party?.companyNativeId),
    actorUserId,
    mailKind: mailKind as StaffRatePick['mailKind'],
  };
}

export function buildStaffRatePick(input: {
  strategy: unknown;
  property: unknown;
  transportId: unknown;
  actorUserId: unknown;
  mailKind: unknown;
  parties?: StaffQuoteParties | null;
}): StaffRatePick | null {
  return parseStaffRatePick({
    strategy: input.strategy,
    property: input.property,
    transportId: input.transportId,
    actorUserId: input.actorUserId,
    mailKind: input.mailKind,
    partyRef: opaquePartyRef(input.parties),
  });
}

/** quote.prepared evidence/hash fields. No names, emails, or mail content. */
export function staffRatePickEvidence(pick: StaffRatePick): StaffRatePick {
  return parseStaffRatePick(pick)!;
}

/** BAR first when listed, then mailbox history, bound party history, then profile order. */
export function rankQuoteSalesStrategies(
  strategies: readonly QuoteSalesStrategy[],
  context: StaffRateRankContext = {},
): QuoteSalesStrategy[] {
  if (strategies.length === 0) return [];
  const byCode = new Map(strategies.map((strategy) => [strategy.code, strategy]));
  const placed = new Set<QuoteSalesStrategyCode>();
  const ranked: QuoteSalesStrategy[] = [];
  const take = (code: QuoteSalesStrategyCode | undefined) => {
    const strategy = code ? byCode.get(code) : undefined;
    if (!strategy || placed.has(strategy.code)) return;
    placed.add(strategy.code);
    ranked.push(strategy);
  };
  take(strategies.find((strategy) => strategy.code === 'BAR')?.code);
  const property = context.property?.trim().toUpperCase() ?? '';
  const transportId = context.transportId?.trim() ?? '';
  const picks = [...(context.picks ?? [])]
    .filter((pick) => pick.property === property && PROPERTY.test(property))
    .sort((left, right) => right.at.getTime() - left.at.getTime());
  if (TRANSPORT.test(transportId)) {
    for (const pick of picks) if (pick.transportId === transportId) take(pick.strategy);
  }
  if (context.partyRef) {
    for (const pick of picks) {
      const left = pick.partyRef;
      const right = context.partyRef;
      if (
        left &&
        ((left.agencyNativeId && left.agencyNativeId === right.agencyNativeId) ||
          (left.companyNativeId && left.companyNativeId === right.companyNativeId))
      ) {
        take(pick.strategy);
      }
    }
  }
  for (const strategy of strategies) take(strategy.code);
  return ranked;
}

export async function loadStaffRatePicks(db: DB, property: string): Promise<LoggedStaffRatePick[]> {
  const code = property.trim().toUpperCase();
  const transports = PROPERTY.test(code) ? getPropertyTransportIds(code) : [];
  if (transports.length === 0) return [];
  const rows = await db
    .select({ evidence: workEvent.evidence, at: workEvent.at })
    .from(workEvent)
    .innerJoin(workItem, eq(workItem.id, workEvent.workItemId))
    .where(and(eq(workEvent.type, 'quote.prepared'), inArray(workItem.transportId, transports)))
    .orderBy(desc(workEvent.at))
    .limit(500);
  return rows.flatMap((row) => {
    const pick = parseStaffRatePick(record(row.evidence)?.ratePick);
    return pick && pick.property === code ? [{ ...pick, at: row.at }] : [];
  });
}
