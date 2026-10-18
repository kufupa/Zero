import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAIL_ACTIONS, type MailAction } from '../src/mail/action-labels.js';
import {
  MONEY_ACTIONS,
  PRECISION_BAR,
  computeOwnerGoldMetrics,
  parseOwnerGoldEvalArgs,
  type OwnerGoldCase,
} from '../scripts/eval-owner-action-labels.js';

const SCRIPT = fileURLToPath(new URL('../scripts/eval-owner-action-labels.ts', import.meta.url));

function caseRow(
  index: number,
  ownerAction: MailAction,
  predictedAction: MailAction | null,
  extra: Partial<OwnerGoldCase> = {},
): OwnerGoldCase {
  return {
    id: `gold-${String(index).padStart(2, '0')}`,
    messageId: `msg-${String(index).padStart(2, '0')}`,
    ownerAction,
    predictedAction,
    updatedAt: new Date(Date.UTC(2026, 9, 1 + index)),
    ...extra,
  };
}

describe('owner-gold held-out metrics', () => {
  it('scores money-class precision on the last 20% only', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => caseRow(i, 'cancel', 'billing')),
      caseRow(8, 'quote_availability', 'quote_availability'),
      caseRow(9, 'new_booking', 'new_booking'),
    ];

    const result = computeOwnerGoldMetrics(rows);

    expect(result.ownerRows).toBe(10);
    expect(result.heldOutRows).toBe(2);
    expect(result.heldOut).toEqual([
      {
        messageId: 'msg-08',
        owner: 'quote_availability',
        predicted: 'quote_availability',
        miss: false,
      },
      { messageId: 'msg-09', owner: 'new_booking', predicted: 'new_booking', miss: false },
    ]);
    expect(result.moneyPrecision).toEqual({
      quote_availability: 1,
      new_booking: 1,
      amend: 0,
      cancel: 0,
    });
    expect(result.meetsBar.quote_availability).toBe(true);
    expect(result.meetsBar.new_booking).toBe(true);
    expect(result.meetsBar.amend).toBe(false);
    expect(result.meetsBar.cancel).toBe(false);
    expect(result.bar).toBe(PRECISION_BAR);
    expect(PRECISION_BAR).toBe(0.95);
  });

  it('returns coverage 0 and finite zeros when there are no owner rows', () => {
    const result = computeOwnerGoldMetrics([]);
    expect(result.ownerRows).toBe(0);
    expect(result.heldOutRows).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.missingPredictions).toBe(0);
    expect(result.heldOut).toEqual([]);
    expect(result.moneyPrecision).toEqual({
      quote_availability: 0,
      new_booking: 0,
      amend: 0,
      cancel: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  it('counts a missing payload.action as a miss and keeps the held-out row', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => caseRow(i, 'amend', 'amend')),
      caseRow(8, 'quote_availability', 'quote_availability'),
      caseRow(9, 'quote_availability', null),
    ];

    const result = computeOwnerGoldMetrics(rows);

    expect(result.heldOutRows).toBe(2);
    expect(result.missingPredictions).toBe(1);
    expect(result.heldOut).toEqual([
      {
        messageId: 'msg-08',
        owner: 'quote_availability',
        predicted: 'quote_availability',
        miss: false,
      },
      { messageId: 'msg-09', owner: 'quote_availability', predicted: null, miss: true },
    ]);
    expect(result.moneyPrecision.quote_availability).toBe(1);
    expect(result.coverage).toBe(0.5);
  });
});

describe('owner-gold eval CLI is SELECT-only', () => {
  it('rejects --write and unknown flags', () => {
    expect(() => parseOwnerGoldEvalArgs(['--write'])).toThrow('Invalid eval options');
    expect(() => parseOwnerGoldEvalArgs(['--out', 'x.json'])).toThrow('Invalid eval options');
    expect(parseOwnerGoldEvalArgs([], { HMS_MAILBOX_TRANSPORT_ID: ' env ' })).toEqual({
      transportId: 'env',
    });
    expect(parseOwnerGoldEvalArgs(['--transport', 'explicit'], {})).toEqual({
      transportId: 'explicit',
    });
    expect(parseOwnerGoldEvalArgs([], {})).toEqual({});
  });

  it('keeps the script SELECT-only and off the R3/D paths', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/SET TRANSACTION READ ONLY/);
    expect(source).toMatch(/payload}->>'action'/);
    expect(source).not.toMatch(/--write/);
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(source).not.toMatch(/usage\.classifier/);
    expect(source).not.toMatch(/action-labels-r3/);
    expect(source).not.toMatch(/extract\.ts|workflow-folders\.ts/);
    expect(MONEY_ACTIONS).toEqual(['quote_availability', 'new_booking', 'amend', 'cancel']);
    expect(MAIL_ACTIONS).toContain('quote_availability');
  });
});
