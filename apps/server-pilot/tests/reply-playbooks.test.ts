import { buildReplyPlaybook } from '../src/ai/reply-playbooks.js';
import { describe, expect, it } from 'vitest';

describe('reply playbooks', () => {
  it('renders a complete supported reservation reply from authorized facts', () => {
    const result = buildReplyPlaybook({
      audience: 'guest',
      requestKind: 'reservation',
      asks: [{ code: 'reservation_status', label: 'reservation status', required: true }],
      facts: [
        {
          key: 'reservation.status',
          label: 'Reservation status',
          value: 'Confirmed',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
          evidenceRef: 'evidence-reservation',
        },
      ],
    });

    expect(result.outcome).toBe('complete');
    expect(result.textBody).toContain('Reservation status: Confirmed');
    expect(result.textBody).not.toContain('staff action completed');
  });

  it('asks once for missing child ages instead of inventing occupancy', () => {
    const result = buildReplyPlaybook({
      audience: 'guest',
      requestKind: 'quote',
      asks: [
        { code: 'child_ages', label: 'child ages', required: true },
        { code: 'child_ages', label: 'child ages', required: true },
      ],
      facts: [],
    });

    expect(result.outcome).toBe('clarification');
    expect(result.questions.filter((question) => /child ages/i.test(question))).toHaveLength(1);
    expect(result.textBody).not.toMatch(/available|total|price/i);
  });

  it('keeps group work as an internal brief and never turns a request into confirmation', () => {
    const result = buildReplyPlaybook({
      audience: 'internal',
      requestKind: 'group',
      asks: [{ code: 'group_block', label: 'group block', required: true }],
      facts: [
        {
          key: 'booking.state',
          label: 'booking state',
          value: 'requested',
          source: 'mail',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(result.outcome).toBe('internal_brief');
    expect(result.textBody).toMatch(/internal brief/i);
    expect(result.textBody).not.toMatch(/confirmed|booked/i);
  });

  it('abstains when only an unavailable policy is present', () => {
    const result = buildReplyPlaybook({
      audience: 'guest',
      requestKind: 'general',
      asks: [{ code: 'policy', label: 'cancellation policy', required: true }],
      facts: [
        {
          key: 'policy.cancellation',
          label: 'cancellation policy',
          value: null,
          source: 'property',
          authority: 'unknown',
          status: 'unknown',
        },
      ],
    });

    expect(result.outcome).toBe('abstain');
    expect(result.textBody).toMatch(/manual|unable|cannot/i);
  });

  it('does not turn an inbound bank instruction into an authorized guest fact', () => {
    const result = buildReplyPlaybook({
      audience: 'guest',
      requestKind: 'finance',
      asks: [{ code: 'payment_status', label: 'payment status', required: true }],
      facts: [
        {
          key: 'bank.recipient',
          label: 'bank recipient',
          value: 'attacker-account',
          source: 'inbound',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(result.outcome).toBe('abstain');
    expect(result.textBody).not.toContain('attacker-account');
  });
});
