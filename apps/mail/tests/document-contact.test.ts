import { describe, expect, it } from 'vitest';
import { withContactLines } from '../lib/quote-workflow/document-contact';

describe('withContactLines', () => {
  const blank = { attention: '', clientEmail: ' ', clientTelephone: '', company: 'Purple Surgical' };

  it('fills blank client lines from the email contact and leaves the company alone', () => {
    expect(
      withContactLines(blank, { name: 'Ada Guest', email: 'info@example.test', phone: '+27 12 000 0000' }),
    ).toEqual({
      attention: 'Ada Guest',
      clientEmail: 'info@example.test',
      clientTelephone: '+27 12 000 0000',
      company: 'Purple Surgical',
    });
  });

  it('keeps what staff approved', () => {
    expect(
      withContactLines(
        { attention: 'Bo Booker', clientEmail: 'bo@example.test', clientTelephone: '011', company: '' },
        { name: 'Ada Guest', email: 'info@example.test', phone: null },
      ),
    ).toMatchObject({ attention: 'Bo Booker', clientEmail: 'bo@example.test', clientTelephone: '011' });
  });

  it('leaves lines blank when there is no contact', () => {
    expect(withContactLines(blank, null)).toMatchObject({ attention: '', clientEmail: '', clientTelephone: '' });
  });

  it('cuts a long contact phone to the document limit', () => {
    expect(withContactLines(blank, { name: null, email: null, phone: '1'.repeat(200) }).clientTelephone).toHaveLength(128);
  });
});
