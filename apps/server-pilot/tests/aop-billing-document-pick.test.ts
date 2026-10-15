import { describe, expect, it } from 'vitest';
import {
  pickBillingDocument,
  pickBillingDocumentDescription,
  pickBillingDocumentInputSchema,
  pickBillingDocumentOutputSchema,
  type BillingDocumentRow,
} from '../src/ai/aop/billing-document-pick.js';

const CONF = '9999901-1';

function row(
  id: string,
  filename: string,
  extra: Partial<Pick<BillingDocumentRow, 'kind' | 'createdAt'>> = {},
): BillingDocumentRow {
  return { id, filename, ...extra };
}

describe('pickBillingDocument', () => {
  it('picks the only matching kind among mixed rows', () => {
    const picked = pickBillingDocument({
      kind: 'invoice',
      confirmationNumber: CONF,
      documents: [
        row('d1', 'statement-9999901-1.pdf', {
          kind: 'statement',
          createdAt: '2026-10-12T10:00:00Z',
        }),
        row('d2', 'invoice-9999901-1.pdf', {
          kind: 'tax_invoice',
          createdAt: '2026-10-01T10:00:00Z',
        }),
        row('d3', 'folio-other.pdf', { kind: 'folio', createdAt: '2026-10-13T10:00:00Z' }),
      ],
    });
    expect(picked.status).toBe('one');
    expect(picked.document).toEqual({ id: 'd2', filename: 'invoice-9999901-1.pdf' });
    expect(picked.candidates).toEqual([{ id: 'd2', filename: 'invoice-9999901-1.pdf' }]);
    expect(picked.todo).toBeNull();
  });

  it('returns many when two of the same kind exist, and does not pick the newest', () => {
    const picked = pickBillingDocument({
      kind: 'invoice',
      documents: [
        row('old', 'invoice-a.pdf', { kind: 'invoice', createdAt: '2026-09-01T00:00:00Z' }),
        row('new', 'invoice-b.pdf', { kind: 'invoice', createdAt: '2026-10-01T00:00:00Z' }),
      ],
    });
    expect(picked.status).toBe('many');
    expect(picked.document).toBeNull();
    expect(picked.candidates.map((c) => c.id)).toEqual(['new', 'old']);
    expect(picked.todo).toMatch(/staff pick/i);
  });

  it('returns none when no row matches the asked kind', () => {
    const picked = pickBillingDocument({
      kind: 'folio',
      confirmationNumber: CONF,
      documents: [
        row('d1', 'invoice-9999901-1.pdf', { kind: 'invoice' }),
        row('d2', 'confirmation-letter.pdf', { kind: 'reservation_confirmation' }),
      ],
    });
    expect(picked.status).toBe('none');
    expect(picked.document).toBeNull();
    expect(picked.candidates).toEqual([]);
    expect(picked.todo).toMatch(/no matching document/i);
  });

  it('infers kind from the filename when kind is omitted', () => {
    const picked = pickBillingDocument({
      kind: 'pro_forma',
      documents: [row('p1', 'Pro-Forma-9999901-1.pdf')],
    });
    expect(picked.status).toBe('one');
    expect(picked.document?.id).toBe('p1');
  });

  it('uses confirmation number to pick one invoice among several', () => {
    const picked = pickBillingDocument({
      kind: 'invoice',
      confirmationNumber: CONF,
      documents: [
        row('a', 'tax-invoice-8888802-1.pdf', {
          kind: 'invoice',
          createdAt: '2026-10-14T00:00:00Z',
        }),
        row('b', `tax-invoice-${CONF}.pdf`, {
          kind: 'invoice',
          createdAt: '2026-09-01T00:00:00Z',
        }),
      ],
    });
    expect(picked.status).toBe('one');
    expect(picked.document?.id).toBe('b');
  });

  it('treats credit-note filenames as credit_note, not invoice', () => {
    const picked = pickBillingDocument({
      kind: 'credit_note',
      documents: [
        row('c1', 'credit-note-9999901-1.pdf'),
        row('i1', 'invoice-9999901-1.pdf'),
      ],
    });
    expect(picked.status).toBe('one');
    expect(picked.document?.id).toBe('c1');
  });

  it('returns none on an empty list', () => {
    const picked = pickBillingDocument({ kind: 'statement', documents: [] });
    expect(picked.status).toBe('none');
    expect(picked.document).toBeNull();
    expect(picked.candidates).toEqual([]);
  });

  it('exports zod schemas and a tool description', () => {
    expect(pickBillingDocumentDescription.toLowerCase()).toContain('hms_list_documents');
    const parsed = pickBillingDocumentInputSchema.parse({
      kind: 'folio',
      documents: [{ id: 'x', filename: 'folio.pdf' }],
    });
    const out = pickBillingDocumentOutputSchema.parse(pickBillingDocument(parsed));
    expect(out.status).toBe('one');
  });
});
