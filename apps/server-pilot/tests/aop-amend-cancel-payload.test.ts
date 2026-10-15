import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  amendCancelPayload,
  amendCancelPayloadDescription,
  amendCancelPayloadInputSchema,
  amendCancelPayloadOutputSchema,
  buildAmendCancelPayload,
} from '../src/ai/aop/amend-cancel-payload.js';

const CONF = '9999901-1';
const LAST = 'Labtest';

function flagMap(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (!flag.startsWith('--')) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      map.set(flag, '');
      continue;
    }
    map.set(flag, next);
    i += 1;
  }
  return map;
}

describe('buildAmendCancelPayload', () => {
  it('is the tool entry the main driver wraps', () => {
    expect(amendCancelPayload).toBe(buildAmendCancelPayload);
    expect(amendCancelPayloadDescription).toMatch(/hms_amend_reservation|amend-stay/i);
    expect(amendCancelPayloadInputSchema.parse({ kind: 'cancel', confirmationNumber: CONF, lastName: LAST }).kind).toBe(
      'cancel',
    );
  });

  it('builds preview amend argv for amend-stay.mjs without executing', () => {
    const out = buildAmendCancelPayload({
      kind: 'amend',
      confirmationNumber: CONF,
      lastName: LAST,
      changes: [
        { field: 'arrival', to: '2027-09-14' },
        { field: 'roomType', to: 'STQN' },
      ],
    });
    const parsed = amendCancelPayloadOutputSchema.parse(out);
    expect(parsed).toMatchObject({
      tool: 'hms_amend_reservation',
      script: 'amend-stay.mjs',
      requiresApproval: true,
      screenshotReview: true,
      executed: false,
      refusals: [],
    });
    const flags = flagMap(parsed.args);
    expect(flags.get('--mode')).toBe('preview');
    expect(flags.has('--out')).toBe(true);
    expect(flags.get('--request')).toBe('amend-request.json');
    expect(flags.has('--digest')).toBe(false);
    expect(parsed.args).not.toContain('--allow-real-guest');
    expect(parsed.args).not.toContain('--confirmation');
    expect(parsed.request).toEqual({
      confirmation: CONF,
      expectedLastName: LAST,
      fields: { arrival: '2027-09-14', roomType: 'STQN' },
    });
  });

  it('binds each amend confirmation and change set onto the request body the wrapper writes', () => {
    const a = buildAmendCancelPayload({
      kind: 'amend',
      confirmationNumber: CONF,
      lastName: LAST,
      changes: [{ field: 'adults', to: 2 }],
    });
    const b = buildAmendCancelPayload({
      kind: 'amend',
      confirmationNumber: '9999902-1',
      lastName: LAST,
      changes: [
        { field: 'arrival', to: '2027-11-01' },
        { field: 'departure', to: '2027-11-04' },
      ],
    });
    expect(a.request).toEqual({ confirmation: CONF, expectedLastName: LAST, fields: { adults: 2 } });
    expect(b.request).toEqual({
      confirmation: '9999902-1',
      expectedLastName: LAST,
      fields: { arrival: '2027-11-01', departure: '2027-11-04' },
    });
    expect(a.request).not.toEqual(b.request);
    expect(a.args).toContain('--request');
    expect(b.args).toContain('--request');
  });

  it('builds preview cancel argv matching cancel-stay.mjs flags', () => {
    const out = buildAmendCancelPayload({
      kind: 'cancel',
      confirmationNumber: CONF,
      lastName: LAST,
      changes: [{ field: 'arrival', to: '2027-09-14' }],
    });
    expect(out).toMatchObject({
      tool: 'hms_cancel_reservation',
      script: 'cancel-stay.mjs',
      requiresApproval: true,
      screenshotReview: true,
      executed: false,
      refusals: [],
    });
    const flags = flagMap(out.args);
    expect(flags.get('--confirmation')).toBe(CONF);
    expect(flags.get('--arrival')).toBe('2027-09-14');
    expect(flags.get('--mode')).toBe('preview');
    expect(flags.get('--last-name')).toBe(LAST);
    expect(flags.has('--out')).toBe(true);
    expect(flags.has('--reason')).toBe(true);
    expect(out.args).not.toContain('--allow-real-guest');
    expect(out.args).not.toContain('--expect-stay');
    expect(out.request).toBeNull();
  });

  it('refuses two cancel arrivals instead of picking the last date', () => {
    const out = buildAmendCancelPayload({
      kind: 'cancel',
      confirmationNumber: CONF,
      lastName: LAST,
      changes: [
        { field: 'arrival', to: '2027-09-14' },
        { field: 'arrival', to: '2027-10-01' },
      ],
    });
    expect(out.args).toEqual([]);
    expect(out.request).toBeNull();
    expect(out.refusals).toContain('repeated_field:arrival');
  });

  it('treats a confirmation number as a whole token, never a substring', () => {
    const embedded = buildAmendCancelPayload({
      kind: 'cancel',
      confirmationNumber: `x${CONF}`,
      lastName: LAST,
      changes: [{ field: 'arrival', to: '2027-09-14' }],
    });
    expect(embedded.args).toEqual([]);
    expect(embedded.refusals.some((row) => /confirm/i.test(row))).toBe(true);

    const trailing = buildAmendCancelPayload({
      kind: 'amend',
      confirmationNumber: `${CONF}x`,
      lastName: LAST,
      changes: [{ field: 'arrival', to: '2027-09-14' }],
    });
    expect(trailing.args).toEqual([]);
    expect(trailing.request).toBeNull();
  });

  it('refuses a missing or invalid confirmation number', () => {
    const missing = buildAmendCancelPayload({ kind: 'cancel', confirmationNumber: '', lastName: LAST });
    expect(missing.args).toEqual([]);
    expect(missing.refusals.length).toBeGreaterThan(0);
    expect(missing.executed).toBe(false);

    const short = buildAmendCancelPayload({ kind: 'amend', confirmationNumber: '99999-1', lastName: LAST });
    expect(short.args).toEqual([]);
    expect(short.refusals.some((row) => /confirm/i.test(row))).toBe(true);

    const wide = buildAmendCancelPayload({
      kind: 'cancel',
      confirmationNumber: '12345678901-1',
      lastName: LAST,
    });
    expect(wide.args).toEqual([]);
  });

  it('refuses a blank occupancy count instead of requesting zero', () => {
    const out = buildAmendCancelPayload({
      kind: 'amend',
      confirmationNumber: CONF,
      lastName: LAST,
      changes: [{ field: 'children', to: '' }],
    });
    expect(out.args).toEqual([]);
    expect(out.refusals.length).toBeGreaterThan(0);
  });

  it('refuses unsupported change fields and leaves args empty', () => {
    const out = buildAmendCancelPayload({
      kind: 'amend',
      confirmationNumber: CONF,
      lastName: LAST,
      changes: [{ field: 'ratePlan', to: 'BAR' }],
    });
    expect(out.args).toEqual([]);
    expect(out.refusals.some((row) => /unsupported/i.test(row))).toBe(true);
    expect(out.tool).toBe('hms_amend_reservation');
  });

  it('is pure string building: no process or playwright-quote script import', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/ai/aop/amend-cancel-payload.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process|spawn\(|execFile|execSync|fork\(/);
    expect(source).not.toMatch(/playwright-quote\/(?:amend|cancel)-stay/);
    expect(source).not.toMatch(/from ['"].*amend-stay/);
    expect(source).not.toMatch(/require\(['"].*(?:amend|cancel)-stay/);
  });
});
