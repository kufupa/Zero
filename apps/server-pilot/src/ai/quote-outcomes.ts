import { and, desc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DB } from '../db/client.js';
import { mailExtraction } from '../db/schema/work.js';
import { workEvent, workItem } from '../db/schema/work.js';

export type QuoteOutcomeVersion = {
  version: 1; sourceMessageId: string; workflowRunId: string; revisionRef: string; action: 'quote_availability';
  extractedFields: Record<string, unknown> | null;
  fields: { groups: Array<{ id: string; arrivalDate: string; departureDate: string; quantity: number; adults: number;
    children: number; childAges: number[]; roomCode: string; board: string }>;
    contact: { name: string; email: string; phone: string } };
  party: { company?: { nativeId: string; name: string }; agency?: { nativeId: string; name: string } } | null;
  lines: Array<{ groupId: string; totalMinor: number; rateMinor: number; nights: number }>;
  totalMinor: number; currency: string;
};
export type QuoteOutcomeFinalOutput = { replyHtml: string;
  attachments: Array<{ fileName: string; mimeType: string; sizeBytes: number; sha256: string }>;
  insertedAt: string };

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
export function quoteOutcomeDiff(before: unknown, after: unknown): string[] {
  const changes: string[] = [];
  const visit = (left: unknown, right: unknown, path: string) => {
    if (stableJson(left) === stableJson(right)) return;
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
        visit((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    } else changes.push(path || '$');
  };
  visit(before, after, '');
  return changes.slice(0, 500);
}

export type QuoteOutcomeAgreement = { n: number; correct: number; pct: number | null };
export type QuoteOutcomeCase = { prepared: QuoteOutcomeVersion; staffFinal: QuoteOutcomeVersion;
  finalOutput?: QuoteOutcomeFinalOutput; action?: { model: string | null; owner: string | null } };
const agreement = (values: boolean[]): QuoteOutcomeAgreement => {
  const correct = values.filter(Boolean).length;
  return { n: values.length, correct, pct: values.length ? Math.round(correct / values.length * 10000) / 100 : null };
};
const canonical = (value: unknown) => stableJson(value ?? null);
const normalized = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : null;

function dateFacts(value: QuoteOutcomeVersion) {
  const extracted = value.extractedFields?.stays;
  if (!Array.isArray(extracted)) return null;
  const facts: Array<{ arrival: unknown; departure: unknown }> = [];
  for (const stay of extracted) {
    const requested = (stay as { requested?: unknown }).requested;
    if (!requested || typeof requested !== 'object') continue;
    const row = requested as Record<string, unknown>;
    facts.push({
      arrival: row.arrivalDate ?? row.arrival ?? row.checkIn ?? null,
      departure: row.departureDate ?? row.departure ?? row.checkOut ?? null,
    });
  }
  return [...new Map(facts.map((row) => [canonical(row), row])).values()]
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function occupancyFacts(value: QuoteOutcomeVersion) {
  const stays = value.extractedFields?.stays;
  if (!Array.isArray(stays)) return null;
  return stays.flatMap((raw) => {
    const rows = raw && typeof raw === 'object' ? (raw as { rows?: unknown }).rows : null;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      rooms: (row as { rooms?: unknown }).rooms ?? null,
      adults: (row as { adultsPerRoom?: unknown }).adultsPerRoom ?? null,
      childAges: (row as { childAges?: unknown }).childAges ?? [],
    }));
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function quoteDates(value: QuoteOutcomeVersion) {
  const facts = value.fields.groups.map(({ arrivalDate, departureDate }) => ({ arrival: arrivalDate, departure: departureDate }));
  return facts.filter((row, index, all) => all.findIndex((candidate) => canonical(candidate) === canonical(row)) === index)
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function quoteOccupancy(value: QuoteOutcomeVersion) {
  return value.fields.groups.map(({ quantity, adults, childAges }) => ({ rooms: quantity, adults, childAges }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function partyName(value: QuoteOutcomeVersion, kind: 'company' | 'agency') {
  const finalParty = value.party?.[kind]?.name;
  const extracted = value.extractedFields?.[kind === 'agency' ? 'agency' : 'endClient'];
  return normalized(finalParty ?? extracted);
}

/** Deterministic quote graders. Missing source facts do not count as agreement. */
export function scoreQuoteOutcomes(cases: readonly QuoteOutcomeCase[]) {
  const dates: boolean[] = [];
  const occupancy: boolean[] = [];
  const party: boolean[] = [];
  const contact: boolean[] = [];
  const lineTotals: boolean[] = [];
  const actions = new Map<string, boolean>();
  let finalOutputCaptured = 0;
  for (const item of cases) {
    const beforeDates = dateFacts(item.prepared);
    if (beforeDates?.length) dates.push(canonical(beforeDates) === canonical(quoteDates(item.staffFinal)));
    const beforeOccupancy = occupancyFacts(item.prepared);
    if (beforeOccupancy?.length) occupancy.push(canonical(beforeOccupancy) === canonical(quoteOccupancy(item.staffFinal)));
    for (const kind of ['company', 'agency'] as const) {
      const before = partyName(item.prepared, kind);
      const after = normalized(item.staffFinal.party?.[kind]?.name ?? null);
      if (before && after) party.push(before === after);
    }
    for (const key of ['name', 'email', 'phone'] as const) {
      const before = normalized(item.prepared.fields.contact[key]);
      const after = normalized(item.staffFinal.fields.contact[key]);
      if (before && after) contact.push(before === after);
    }
    if (item.prepared.lines.length || item.staffFinal.lines.length) {
      lineTotals.push(
        item.prepared.totalMinor === item.staffFinal.totalMinor &&
          canonical(item.prepared.lines.map((line) => ({ groupId: line.groupId, totalMinor: line.totalMinor }))) ===
          canonical(item.staffFinal.lines.map((line) => ({ groupId: line.groupId, totalMinor: line.totalMinor }))),
      );
    }
    if (item.action?.model && item.action.owner)
      actions.set(item.prepared.sourceMessageId, item.action.model === item.action.owner);
    if (item.finalOutput?.replyHtml !== undefined) finalOutputCaptured++;
  }
  return {
    cases: cases.length,
    action: agreement([...actions.values()]),
    dates: agreement(dates),
    occupancy: agreement(occupancy),
    contact: agreement(contact),
    party: agreement(party),
    lineTotals: agreement(lineTotals),
    finalOutput: { n: cases.length, captured: finalOutputCaptured, pct: cases.length ? Math.round((finalOutputCaptured / cases.length) * 10000) / 100 : null },
  };
}

/** Create or find the mail-linked work item; background quote preparation may precede pane opening. */
export async function ensureQuoteOutcomeWorkItem(
  db: DB,
  scope: { transportId: string; threadId: string; sourceMessageId: string },
): Promise<string> {
  const find = () => db.select({ id: workItem.id }).from(workItem).where(and(
    eq(workItem.transportId, scope.transportId),
    eq(workItem.threadId, scope.threadId),
    eq(workItem.kind, 'quote'),
    eq(workItem.sourceMessageId, scope.sourceMessageId),
  )).limit(1);
  const [existing] = await find();
  if (existing) return existing.id;
  const [extraction] = await db.select({ id: mailExtraction.id }).from(mailExtraction)
    .where(and(eq(mailExtraction.messageId, scope.sourceMessageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id)).limit(1);
  await db.insert(workItem).values({
    transportId: scope.transportId,
    threadId: scope.threadId,
    sourceMessageId: scope.sourceMessageId,
    kind: 'quote',
    extractionId: extraction?.id ?? null,
  }).onConflictDoNothing({ target: [workItem.threadId, workItem.kind, workItem.sourceMessageId] });
  const [created] = await find();
  if (!created) throw new Error('quote_work_item_missing');
  return created.id;
}

/** Append one Nava prepared version and its human-accepted pricing version. */
export async function recordPreparedQuoteOutcome(
  db: DB,
  input: {
    workItemId: string;
    actorUserId: string | null;
    workflowRunId: string;
    sourceMessageId: string;
    prepared: QuoteOutcomeVersion;
    staffFinal: QuoteOutcomeVersion;
  },
): Promise<void> {
  const payloadHash = createHash('sha256').update(stableJson({
    workflowRunId: input.workflowRunId,
    prepared: input.prepared,
    staffFinal: input.staffFinal,
  })).digest('hex');
  const [seen] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
    eq(workEvent.workItemId, input.workItemId),
    eq(workEvent.type, 'quote.prepared'),
    eq(workEvent.payloadHash, payloadHash),
  )).limit(1);
  if (seen) return;
  await db.insert(workEvent).values({
    workItemId: input.workItemId,
    actorKind: input.actorUserId ? 'user' : 'ai',
    actorUserId: input.actorUserId,
    type: 'quote.prepared',
    aiValue: input.prepared,
    value: input.staffFinal,
    aiSource: input.workflowRunId,
    payloadHash,
    evidence: { sourceMessageId: input.sourceMessageId, workflowRunId: input.workflowRunId },
  });
}

/** Persist exact reviewed output and link it back to the prepared/final quote snapshots. */
export async function recordFinalQuoteOutcome(
  db: DB,
  input: { workItemId: string; sourceMessageId: string; userId: string; output: QuoteOutcomeFinalOutput },
): Promise<boolean> {
  const [item] = await db.select({ id: workItem.id, sourceMessageId: workItem.sourceMessageId })
    .from(workItem).where(eq(workItem.id, input.workItemId)).limit(1);
  if (!item || item.sourceMessageId !== input.sourceMessageId) return false;
  const [prepared] = await db.select({ id: workEvent.id, aiValue: workEvent.aiValue, value: workEvent.value, aiSource: workEvent.aiSource })
    .from(workEvent).where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'quote.prepared')))
    .orderBy(desc(workEvent.at), desc(workEvent.id)).limit(1);
  if (!prepared) return false;
  const finalVersion = { version: 1, staffQuote: prepared.value, output: input.output };
  const payloadHash = createHash('sha256').update(stableJson({ preparedId: prepared.id, finalVersion })).digest('hex');
  const [seen] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
    eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'quote.finalized'), eq(workEvent.payloadHash, payloadHash),
  )).limit(1);
  if (seen) return true;
  const preparedValue = prepared.aiValue as QuoteOutcomeVersion;
  await db.insert(workEvent).values({
    workItemId: input.workItemId,
    actorKind: 'user',
    actorUserId: input.userId,
    type: 'quote.finalized',
    aiValue: prepared.aiValue,
    value: finalVersion,
    aiSource: prepared.aiSource,
    payloadHash,
    evidence: {
      preparedEventId: prepared.id,
      sourceMessageId: input.sourceMessageId,
      diff: [...quoteOutcomeDiff(preparedValue, prepared.value), 'output'],
    },
  });
  return true;
}

export function finalQuoteVersion(value: unknown): QuoteOutcomeVersion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<QuoteOutcomeVersion>;
  return row.version === 1 && typeof row.sourceMessageId === 'string' && Array.isArray(row.fields?.groups) &&
    Array.isArray(row.lines) && Number.isSafeInteger(row.totalMinor) ? row as QuoteOutcomeVersion : null;
}
