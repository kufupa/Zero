import {
  redactStagehandCapture,
  type StagehandCaptureKind,
} from '../src/hms/stagehand-capture-redaction.js';
import { persistStagehandCapture } from '../src/hms/stagehand-capture-persistence.js';
import { buildNarrowRequestProjection } from '../src/hms/request-signature-projection.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function redact(value: unknown, kind: StagehandCaptureKind = 'request-part') {
  return redactStagehandCapture(value, kind);
}

function syntheticLuhnPan(): string {
  const prefix = '987654321012345';
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${prefix}${check}`;
    let total = 0;
    let double = false;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      let digit = Number(candidate[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      total += digit;
      double = !double;
    }
    if (total % 10 === 0) return candidate;
  }
  throw new Error('synthetic PAN construction failed');
}

describe('Stagehand capture redaction', () => {
  it('does not treat unsupported request bodies as field names', () => {
    for (const contentType of ['text/plain', 'application/octet-stream']) {
      const projection = buildNarrowRequestProjection({
        kind: 'runtime-request-projection',
        url: 'https://pms.example/web/base/OSACCT',
        method: 'POST',
        resourceType: 'xhr',
        headers: { 'content-type': contentType },
        rawBody: 'SYNTH_UNSTRUCTURED_SECRET',
      });

      expect(projection.bodyFieldNames).toEqual([]);
      expect(projection.otherFieldHashes).toEqual({});
      expect(projection.bodyByteLength).toBeGreaterThan(0);
      expect(JSON.stringify(projection)).not.toContain('SYNTH_UNSTRUCTURED_SECRET');
    }
  });

  it('redacts nested credential and payment-card keys while retaining financial facts', () => {
    const result = redact({
      fields: {
        amount: '125.00',
        currency: 'ZAR',
        confirmationnumber: 'SYNTH-CONF',
        account: 'SYNTH-ACCOUNT',
        nested: [
          {
            authorization: 'Bearer SYNTH-AUTH',
            csrfToken: 'SYNTH-CSRF',
            paymentCardNumber: 'SYNTH-PAN',
          },
        ],
      },
      query: {
        amount: '125.00',
        sessionId: 'SYNTH-SESSION',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      fields: {
        amount: '125.00',
        currency: 'ZAR',
        confirmationnumber: 'SYNTH-CONF',
        account: 'SYNTH-ACCOUNT',
        nested: [
          {
            authorization: '[REDACTED]',
            csrfToken: '[REDACTED]',
            paymentCardNumber: '[REDACTED]',
          },
        ],
      },
      query: { amount: '125.00', sessionId: '[REDACTED]' },
    });
    expect(result.redactedPaths).toEqual(
      expect.arrayContaining([
        '$.fields.nested[0].authorization',
        '$.fields.nested[0].csrfToken',
        '$.fields.nested[0].paymentCardNumber',
        '$.query.sessionId',
      ]),
    );
  });

  it('scrubs secrets inside URL-encoded nested JSON without discarding ordinary facts', () => {
    const payload = encodeURIComponent(
      JSON.stringify({
        amount: '80.00',
        currency: 'ZAR',
        details: [{ sessionToken: 'SYNTH-SESSION', paid: '80.00' }],
      }),
    );
    const result = redact({ body: `payload=${payload}&amount=80.00` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = String((result.value as { body: string }).body);
    expect(body).not.toContain('SYNTH-SESSION');
    expect(body).toContain('amount=80.00');
    expect(decodeURIComponent(new URLSearchParams(body).get('payload') ?? '')).toContain(
      '"amount":"80.00"',
    );
    expect(decodeURIComponent(new URLSearchParams(body).get('payload') ?? '')).toContain(
      '"sessionToken":"[REDACTED]"',
    );
  });

  it('scrubs secrets in a directly percent-encoded JSON request body', () => {
    const encoded = encodeURIComponent(
      JSON.stringify({ csrfToken: 'SYNTH-ENCODED-SECRET', amount: '12.00' }),
    );
    const result = redact(encoded, 'request-part');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeURIComponent(String(result.value));
    expect(decoded).not.toContain('SYNTH-ENCODED-SECRET');
    expect(decoded).toContain('"csrfToken":"[REDACTED]"');
    expect(decoded).toContain('"amount":"12.00"');
  });

  it('scrubs secrets in a nested percent-encoded JSON request field', () => {
    const encoded = encodeURIComponent(
      JSON.stringify({ csrfToken: 'SYNTH-ENCODED-SECRET', amount: '12.00' }),
    );
    const result = redact({ payload: encoded }, 'request-part');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = String((result.value as { payload: string }).payload);
    const decoded = decodeURIComponent(payload);
    expect(decoded).not.toContain('SYNTH-ENCODED-SECRET');
    expect(decoded).toContain('"csrfToken":"[REDACTED]"');
    expect(decoded).toContain('"amount":"12.00"');
  });

  it('scrubs observed HMS response text and unkeyed synthetic PANs while retaining deposit rows', () => {
    const pan = syntheticLuhnPan();
    const body = JSON.stringify({
      classPath: 'osledg_dld',
      pageData: {
        values: {
          amount: '125.00',
          currency: 'ZAR',
          paymentcardnumber: 'SYNTH-PAN',
          activitytype_display: 'Deposit Payment',
        },
        grid: {
          GRIDRESULT: {
            GRID: {
              DATA: [
                {
                  confirmationnumber: 'SYNTH-CONF',
                  amount: '125.00',
                  activitytype_display: 'Deposit Payment',
                  csrfToken: 'SYNTH-CSRF',
                },
              ],
            },
          },
        },
      },
      note: `PAN ${pan}`,
    });

    const result = redact(body, 'response-body');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('"amount":"125.00"');
    expect(result.value).toContain('"activitytype_display":"Deposit Payment"');
    expect(result.value).toContain('"confirmationnumber":"SYNTH-CONF"');
    expect(result.value).not.toContain('SYNTH-PAN');
    expect(result.value).not.toContain('SYNTH-CSRF');
    expect(result.value).not.toContain(pan);
  });

  it('canonicalizes a bounded non-strict HMS pageData response before redaction', () => {
    const result = redact(
      '{"classPath":"osledg_dld","pageData":{values:{amount:"125.00",currency:"ZAR",csrfToken:"SYNTH-CSRF"},grid:{GRIDRESULT:{GRID:{DATA:[]}}}}}',
      'response-body',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('"amount":"125.00"');
    expect(result.value).toContain('"currency":"ZAR"');
    expect(result.value).not.toContain('SYNTH-CSRF');
    expect(result.value).toContain('[REDACTED]');
  });

  it('retains null card fields and authorization metadata while scrubbing form secrets', () => {
    const response = redact(
      '{"paymentcardnumber":null,"authorizationPresent":true,"amount":"20.00"}',
      'response-body',
    );
    expect(response).toEqual({
      ok: true,
      value: '{"paymentcardnumber":null,"authorizationPresent":true,"amount":"20.00"}',
      redactedPaths: [],
    });

    const request = redact({ body: 'csrfToken=SYNTH-CSRF&amount=20.00' });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect((request.value as { body: string }).body).toContain('csrfToken=%5BREDACTED%5D');
    expect((request.value as { body: string }).body).toContain('amount=20.00');
  });

  it('fails closed when an encoded secret-bearing payload cannot be parsed safely', () => {
    const result = redact(
      'payload=%7B%22csrfToken%22%3A%22SYNTH-CSRF',
      'request-part',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed when a response secret marker has no value', () => {
    const result = redact('{"authorization":', 'response-body');

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed for unsupported HTML that declares a secret-bearing input', () => {
    const result = redact(
      '<html><form><input type="hidden" name="csrfToken" value="SYNTHETIC_CSRF_SECRET_123"></form></html>',
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('redacts descriptor values when the descriptor name is sensitive', () => {
    const result = redact({
      fields: [
        { name: 'csrfToken', value: 'SYNTHETIC_CSRF_SECRET_123' },
        { name: 'amount', value: '100.00' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      fields: [
        { name: 'csrfToken', value: '[REDACTED]' },
        { name: 'amount', value: '100.00' },
      ],
    });
  });

  it('fails closed when a sensitive descriptor has no value to scrub', () => {
    const result = redact({ fields: [{ name: 'csrfToken' }] });

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('does not treat ordinary company fields as payment-card keys', () => {
    const result = redact({ company: 'Synthetic Acme', amount: '100.00' });

    expect(result).toEqual({
      ok: true,
      value: { company: 'Synthetic Acme', amount: '100.00' },
      redactedPaths: [],
    });
  });

  it('fails closed for unsupported non-strict response descriptors', () => {
    const result = redact(
      '{"pageData":{values:{fields:[{name:"csrfToken",value:"SYNTHETIC_CSRF_SECRET_123",defaultValue:"SYNTHETIC_CSRF_DEFAULT"}]}}}',
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed for strict descriptors whose secret is under an unsupported key', () => {
    const result = redact(
      JSON.stringify({
        fields: [{ name: 'csrfToken', defaultValue: 'SYNTHETIC_CSRF_SECRET_123' }],
      }),
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('redacts sensitive values in request tuple pairs without losing ordinary fields', () => {
    const result = redact({
      body: [
        ['csrfToken', 'SYNTH-CSRF-TUPLE'],
        ['amount', '20.00'],
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        body: [
          ['csrfToken', '[REDACTED]'],
          ['amount', '20.00'],
        ],
      },
      redactedPaths: ['$.body[0][1]'],
    });
  });

  it('fails closed for an unsupported sensitive tuple with extra siblings', () => {
    const result = redact({
      body: [['csrfToken', 'SYNTH-CSRF-TUPLE', 'unexpected-metadata']],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('redacts sensitive values in message tuple pairs', () => {
    const result = redact(
      {
        kind: 'requestfailed',
        details: [['x-api-key', 'SYNTH-API-KEY-TUPLE'], ['code', 'SYNTH-CODE']],
      },
      'message',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      details: [['x-api-key', '[REDACTED]'], ['code', 'SYNTH-CODE']],
    });
    expect(result.redactedPaths).toContain('$.details[0][1]');
  });

  it('fails closed when a sensitive descriptor carries a second value-bearing sibling', () => {
    const result = redact(
      JSON.stringify({
        fields: [
          {
            name: 'csrfToken',
            value: 'SYNTH-CSRF-DESCRIPTOR',
            defaultValue: 'SYNTH-CSRF-DESCRIPTOR-DEFAULT',
          },
        ],
      }),
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed for a directly malformed encoded request body', () => {
    const result = redact('%7B%22csrfToken%22%3A%22SYNTH-CSRF%', 'request-part');

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed for malformed encoded nested response transport', () => {
    const result = redact(
      JSON.stringify({
        amount: '20.00',
        confirmationnumber: 'SYNTH-CONF',
        nested: 'payload=%7B%22csrfToken%22%3A%22SYNTH-NESTED-CSRF%ZZ',
      }),
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed for malformed encoded transport in an ordinary response field', () => {
    const result = redact(
      JSON.stringify({
        pageData: {
          values: {
            display: 'payload=%7B%22csrfToken%22%3A%22SYNTH-NESTED-CSRF%ZZ',
          },
        },
      }),
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('retains a sanitized source-faithful response shape with literal-percent fields', () => {
    const result = redact(
      JSON.stringify({
        pageData: {
          values: {
            amount: '125.00',
            account: 'SYNTH-ACCOUNT',
            confirmationnumber: 'SYNTH-CONF',
            roomtypechargeratereason: {
              option: [{ display: 'Rate 50% off' }],
            },
          },
          grid: {
            GRIDRESULT: {
              GRID: {
                FIELDS: { FIELD: [{ label: 'Discount 25%' }] },
                DATA: [{ transdesc: 'Deposit 10% adjustment' }],
              },
              TOOLBAR: {
                FIELDVALUES: {
                  ROW: { filterfields_options: [{ display: 'Tax 15%' }] },
                },
              },
            },
          },
        },
      }),
      'response-body',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Rate 50% off');
    expect(result.value).toContain('Discount 25%');
    expect(result.value).toContain('Deposit 10% adjustment');
    expect(result.value).toContain('Tax 15%');
    expect(result.value).toContain('125.00');
    expect(result.value).toContain('SYNTH-ACCOUNT');
    expect(result.value).toContain('SYNTH-CONF');
  });

  it('fails closed for malformed HMS text that cannot be structurally parsed', () => {
    const result = redact(
      '{"csrfToken" "SYNTH-CSRF",amount:"20.00"}',
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('fails closed when deeply nested encoded content exceeds the safe bound', () => {
    let encoded = JSON.stringify({ csrfToken: 'SYNTH-CSRF-DEEP' });
    for (let index = 0; index < 40; index += 1) encoded = encodeURIComponent(encoded);

    const result = redact(encoded, 'request-part');

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('redacts API-key headers while preserving safe header metadata', () => {
    const objectResult = redact({
      headers: {
        'x-api-key': 'SYNTH-API-KEY',
        'content-type': 'application/json',
      },
    });
    expect(objectResult).toEqual({
      ok: true,
      value: {
        headers: {
          'x-api-key': '[REDACTED]',
          'content-type': 'application/json',
        },
      },
      redactedPaths: ['$.headers.x-api-key'],
    });

    const textResult = redact('x-api-key=SYNTH-API-KEY&amount=20.00');
    expect(textResult.ok).toBe(true);
    if (!textResult.ok) return;
    expect(decodeURIComponent(String(textResult.value))).toContain('[REDACTED]');
  });

  it('redacts secrets in a direct strict JSON request body', () => {
    const result = redact(
      JSON.stringify({ csrfToken: 'SYNTH-CSRF-JSON', amount: '20.00' }),
      'request-part',
    );

    expect(result).toEqual({
      ok: true,
      value: JSON.stringify({ csrfToken: '[REDACTED]', amount: '20.00' }),
      redactedPaths: ['$.csrfToken'],
    });
  });

  it('retains typed numeric identifiers and safe card metadata', () => {
    const result = redact({
      confirmationnumber: '4111111111111111',
      account: '4000000000000002',
      cardType: 'VISA',
      cardBrand: 'Visa',
      cardPresent: true,
      amount: '20.00',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        confirmationnumber: '4111111111111111',
        account: '4000000000000002',
        cardType: 'VISA',
        cardBrand: 'Visa',
        cardPresent: true,
        amount: '20.00',
      },
      redactedPaths: [],
    });
  });

  it('scrubs a card number only when free text labels it as a PAN', () => {
    const result = redact(
      JSON.stringify({ note: 'PAN 4111111111111111', confirmationnumber: '4111111111111111' }),
      'response-body',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('[REDACTED]');
    expect(result.value).toContain('"confirmationnumber":"4111111111111111"');
  });

  it('scrubs a labeled PAN even when the same text contains another secret', () => {
    const result = redact(
      JSON.stringify({ note: 'PAN 4111111111111111 csrfToken=SYNTH-CSRF' }),
      'response-body',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('4111111111111111');
    expect(result.value).not.toContain('SYNTH-CSRF');
    expect(result.value).toContain('[REDACTED]');
  });

  it('rejects raw arbitrary message text instead of guessing it is safe', () => {
    const result = redact('SYNTHETIC arbitrary page failure', 'message');

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('rejects arbitrary request-failure text while retaining the caller metadata path', () => {
    const result = redact(
      {
        kind: 'requestfailed',
        path: '/web/base/OSRESS.search',
        error: 'SYNTHETIC arbitrary transport failure',
      },
      'request-part',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('rejects raw response error text instead of accepting a whole transport record', () => {
    const result = redact(
      {
        kind: 'requestfailed',
        path: '/web/base/OSRESS.search',
        error: 'SYNTHETIC arbitrary transport failure',
      },
      'response-body',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('rejects unsupported raw request text instead of returning it unchanged', () => {
    const result = redact('SYNTHETIC arbitrary request text', 'request-part');

    expect(result).toEqual({
      ok: false,
      reason: 'UNSAFE_SECRET_CONTENT',
    });
  });

  it('persists a narrow request signature beside a sanitized financial body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-stagehand-capture-'));
    const path = join(root, 'network.json');
    try {
      const result = await persistStagehandCapture(
        path,
        [
          {
            kind: 'browser-request-projection',
            at: '2099-01-15T00:00:00.000Z',
            path: '/web/base/OSACCT',
            method: 'POST',
            bodyFieldNames: ['amount', 'paymentcardnumber'],
            queryKeys: ['FUNCTION_CLASS'],
            safeTransportFields: { FUNCTION_CLASS: 'OSACCT' },
            otherFieldHashes: { amount: 'a'.repeat(64), paymentcardnumber: 'b'.repeat(64) },
            queryFieldHashes: { FUNCTION_CLASS: 'c'.repeat(64) },
            bodyPayloadSha256: 'd'.repeat(64),
            bodyByteLength: 131,
            requestHeaderNames: ['content-type'],
            authorizationPresent: false,
          },
          {
            kind: 'response',
            body: JSON.stringify({
              classPath: 'osledg_dld',
              pageData: {
                values: {
                  amount: '125.00',
                  currency: 'ZAR',
                  paymentcardnumber: 'SYNTH-PAN',
                  activitytype_display: 'Deposit Payment',
                },
              },
            }),
          },
        ],
        'response-body',
      );

      expect(result.ok).toBe(true);
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
      expect(persisted[0]).toMatchObject({
        kind: 'browser-request-projection',
        path: '/web/base/OSACCT',
        bodyByteLength: 131,
        safeTransportFields: { FUNCTION_CLASS: 'OSACCT' },
      });
      expect(persisted[1]?.body).toContain('"amount":"125.00"');
      expect(persisted[1]?.body).toContain('"activitytype_display":"Deposit Payment"');
      expect(JSON.stringify(persisted)).not.toContain('SYNTH-PAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
