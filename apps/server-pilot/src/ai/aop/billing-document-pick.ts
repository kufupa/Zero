import { z } from 'zod';

/**
 * Pure picker for AOP-3. No DB, HMS, network or LLM.
 * Rows are the list projection the agent would pass after hms_list_documents
 * (`id` / `filename` / optional `kind` / `createdAt`). The live driver in
 * `src/hms/live-document-list-driver.ts` does not export this shape.
 */

export const BILLING_DOCUMENT_ASK_KINDS = [
  'invoice',
  'pro_forma',
  'folio',
  'statement',
  'credit_note',
] as const;
export type BillingDocumentAskKind = (typeof BILLING_DOCUMENT_ASK_KINDS)[number];

const billingDocumentRefSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
});

export const billingDocumentRowSchema = billingDocumentRefSchema.extend({
  kind: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
});
export type BillingDocumentRow = z.infer<typeof billingDocumentRowSchema>;

export const pickBillingDocumentInputSchema = z.object({
  kind: z.enum(BILLING_DOCUMENT_ASK_KINDS),
  confirmationNumber: z.string().min(1).optional(),
  documents: z.array(billingDocumentRowSchema),
});
export type PickBillingDocumentInput = z.infer<typeof pickBillingDocumentInputSchema>;

export const pickBillingDocumentOutputSchema = z.object({
  status: z.enum(['one', 'many', 'none']),
  document: billingDocumentRefSchema.nullable(),
  candidates: z.array(billingDocumentRefSchema),
  todo: z.string().nullable(),
});
export type PickBillingDocumentOutput = z.infer<typeof pickBillingDocumentOutputSchema>;

export const pickBillingDocumentDescription = [
  'Pick the HMS document that matches a billing ask (invoice, pro forma, folio,',
  'statement, credit note). Call after hms_list_documents when available. Pass the',
  'ask kind, optional confirmation number, and list rows {id, filename, kind?,',
  'createdAt?}. Returns one match, many (staff pick), or none. A stated confirmation number matches whole tokens only (base matches its legs, base-N only that leg) and never falls back to other documents. Newest of the same',
  'kind wins only when exactly one kind matches. Never calls HMS.',
].join(' ');

const KIND_ALIASES: Record<BillingDocumentAskKind, readonly string[]> = {
  invoice: ['invoice', 'tax_invoice', 'tax-invoice', 'taxinvoice'],
  pro_forma: ['pro_forma', 'pro-forma', 'proforma', 'pro forma'],
  folio: ['folio', 'guest_folio', 'guest-folio', 'guestfolio'],
  statement: ['statement'],
  credit_note: ['credit_note', 'credit-note', 'creditnote', 'credit note', 'credit'],
};

const FILENAME_KIND_ORDER: readonly BillingDocumentAskKind[] = [
  'credit_note',
  'pro_forma',
  'statement',
  'folio',
  'invoice',
];

function compact(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function mapKindToken(raw: string | undefined): BillingDocumentAskKind | null {
  if (!raw) return null;
  const token = compact(raw);
  for (const ask of BILLING_DOCUMENT_ASK_KINDS) {
    if (KIND_ALIASES[ask].some((alias) => compact(alias) === token)) return ask;
  }
  return null;
}

function inferKindFromFilename(filename: string): BillingDocumentAskKind | null {
  const name = filename.toLowerCase();
  for (const ask of FILENAME_KIND_ORDER) {
    if (KIND_ALIASES[ask].some((alias) => name.includes(alias))) return ask;
  }
  return null;
}

function rowKind(row: BillingDocumentRow): BillingDocumentAskKind | null {
  return mapKindToken(row.kind) ?? inferKindFromFilename(row.filename);
}

function createdMs(row: BillingDocumentRow): number {
  if (!row.createdAt) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(row.createdAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function asRef(row: BillingDocumentRow): { id: string; filename: string } {
  return { id: row.id, filename: row.filename };
}

type StatedConf = { base: string; leg: string | null } | { raw: string };

function statedConf(confirmationNumber: string | undefined): StatedConf | null {
  const trimmed = confirmationNumber?.trim();
  if (!trimmed) return null;
  const m = /^(\d{6,10})(?:-(\d+))?$/.exec(trimmed);
  return m ? { base: m[1]!, leg: m[2] ?? null } : { raw: trimmed.toLowerCase() };
}

// Whole tokens only: a base matches its legs, base-N matches only that leg, so 9999901-1 never picks 9999901-10.
function rowHasConf(row: BillingDocumentRow, stated: StatedConf): boolean {
  const text = `${row.id} ${row.filename}`;
  if ('raw' in stated) {
    const escaped = stated.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9])(\d{6,10})(?:-(\d+))?(?![0-9])/g)) {
    if (m[1] !== stated.base) continue;
    if (stated.leg === null || m[2] === stated.leg) return true;
  }
  return false;
}

function result(input: {
  status: PickBillingDocumentOutput['status'];
  rows: BillingDocumentRow[];
  todo: string | null;
  document?: BillingDocumentRow | null;
}): PickBillingDocumentOutput {
  const candidates = input.rows.map(asRef);
  return pickBillingDocumentOutputSchema.parse({
    status: input.status,
    document: input.document ? asRef(input.document) : null,
    candidates,
    todo: input.todo,
  });
}

export function pickBillingDocument(input: PickBillingDocumentInput): PickBillingDocumentOutput {
  const parsed = pickBillingDocumentInputSchema.parse(input);
  const kindMatches = parsed.documents.filter((row) => rowKind(row) === parsed.kind);
  const stated = statedConf(parsed.confirmationNumber);
  // A stated confirmation number never falls back to other stays' documents of the same kind.
  const matches = stated ? kindMatches.filter((row) => rowHasConf(row, stated)) : kindMatches;
  if (stated && matches.length === 0 && kindMatches.length > 0) {
    return result({
      status: 'none',
      rows: [],
      todo: 'No document for the stated confirmation number: check conf# in HMS.',
    });
  }

  const newestFirst = [...matches].sort((a, b) => createdMs(b) - createdMs(a));

  if (newestFirst.length === 0) {
    return result({
      status: 'none',
      rows: [],
      todo: 'No matching document. Staff generate or pick from HMS.',
    });
  }
  if (newestFirst.length === 1) {
    return result({
      status: 'one',
      rows: newestFirst,
      document: newestFirst[0],
      todo: null,
    });
  }
  return result({
    status: 'many',
    rows: newestFirst,
    todo: 'Several matching documents. Staff pick which to attach.',
  });
}
