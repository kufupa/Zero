import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_CANARY_ADDRESS,
  NAVA_ADDRESS,
  buildRocketseedProbe,
  buildRocketseedProbeSummary,
  type RocketseedProbeInput,
} from '../scripts/rocketseed-probe.js';

const FAKE_SECRET = 'unit-only-secret-value';

function validInput(
  overrides: Partial<RocketseedProbeInput> = {},
): RocketseedProbeInput {
  return {
    host: 'relay.internal.example',
    port: 587,
    tlsServername: 'smtp.example.com',
    authUser: NAVA_ADDRESS,
    headerFrom: NAVA_ADDRESS,
    envelopeFrom: NAVA_ADDRESS,
    recipient: NAVA_ADDRESS,
    outboundId: 'outbound-123',
    subjectToken: 'probe-20260730-001',
    mode: 'autonomous-nava',
    includeSyntheticPdf: false,
    ...overrides,
  };
}

describe('buildRocketseedProbe', () => {
  it.each([
    ['host', 'SMTP host'],
    ['tlsServername', 'TLS server name'],
    ['authUser', 'SMTP auth user'],
    ['recipient', 'recipient'],
    ['headerFrom', 'Header From'],
    ['envelopeFrom', 'envelope From'],
    ['outboundId', 'outbound ID'],
    ['subjectToken', 'subject token'],
  ] as const)('rejects missing %s', (field, label) => {
    expect(() =>
      buildRocketseedProbe(validInput({ [field]: '   ' }), FAKE_SECRET),
    ).toThrow(`${label} required`);
  });

  it('rejects an invalid SMTP port', () => {
    expect(() =>
      buildRocketseedProbe(validInput({ port: 0 }), FAKE_SECRET),
    ).toThrow('SMTP port must be an integer from 1 to 65535');
  });

  it('rejects missing SMTP secret', () => {
    expect(() => buildRocketseedProbe(validInput(), '  ')).toThrow(
      'SMTP_PASSWORD or resolved SMTP_SECRET_ARN required',
    );
  });

  it('forces authenticated STARTTLS with certificate verification', () => {
    const plan = buildRocketseedProbe(validInput(), FAKE_SECRET);

    expect(plan.transport).toEqual({
      host: 'relay.internal.example',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: NAVA_ADDRESS,
        pass: FAKE_SECRET,
      },
      tls: {
        servername: 'smtp.example.com',
        rejectUnauthorized: true,
      },
    });
  });

  it('keeps Header From and envelope From independent in manual mode', () => {
    const plan = buildRocketseedProbe(
      validInput({
        mode: 'manual',
        authUser: 'relay-user@example.com',
        headerFrom: 'centurion@legacyhotels.co.za',
        envelopeFrom: 'bounce@legacyhotels.co.za',
        recipient: NAVA_ADDRESS,
      }),
      FAKE_SECRET,
    );

    expect(plan.message.from).toBe('centurion@legacyhotels.co.za');
    expect(plan.message.envelope).toEqual({
      from: 'bounce@legacyhotels.co.za',
      to: [NAVA_ADDRESS],
    });
  });

  it('stamps correlation headers and unique subject token', () => {
    const plan = buildRocketseedProbe(validInput(), FAKE_SECRET);
    const other = buildRocketseedProbe(
      validInput({ subjectToken: 'probe-20260730-002' }),
      FAKE_SECRET,
    );

    expect(plan.message.headers).toEqual({
      'X-Zero-Mailbox': NAVA_ADDRESS,
      'X-Zero-Outbound-Id': 'outbound-123',
    });
    expect(plan.message.subject).toContain('probe-20260730-001');
    expect(other.message.subject).toContain('probe-20260730-002');
    expect(other.message.subject).not.toBe(plan.message.subject);
  });

  it.each(['authUser', 'headerFrom', 'envelopeFrom'] as const)(
    'rejects non-Nava autonomous %s',
    (field) => {
      expect(() =>
        buildRocketseedProbe(
          validInput({ [field]: 'other@legacyhotels.co.za' }),
          FAKE_SECRET,
        ),
      ).toThrow(`autonomous-nava ${field} must be ${NAVA_ADDRESS}`);
    },
  );

  it.each([NAVA_ADDRESS, GMAIL_CANARY_ADDRESS])(
    'allows autonomous recipient %s',
    (recipient) => {
      expect(() =>
        buildRocketseedProbe(validInput({ recipient }), FAKE_SECRET),
      ).not.toThrow();
    },
  );

  it('rejects every other autonomous recipient', () => {
    expect(() =>
      buildRocketseedProbe(
        validInput({ recipient: 'someone@example.com' }),
        FAKE_SECRET,
      ),
    ).toThrow(
      `autonomous-nava recipient must be ${NAVA_ADDRESS} or ${GMAIL_CANARY_ADDRESS}`,
    );
  });

  it('generates one tiny synthetic PDF in memory for Nava self-send', () => {
    const plan = buildRocketseedProbe(
      validInput({ includeSyntheticPdf: true }),
      FAKE_SECRET,
    );

    expect(plan.message.attachments).toHaveLength(1);
    const attachment = plan.message.attachments?.[0];
    expect(attachment).toMatchObject({
      filename: 'zero-rocketseed-probe.pdf',
      contentType: 'application/pdf',
    });
    if (!attachment) throw new Error('expected synthetic PDF attachment');
    expect(attachment.content).toBeInstanceOf(Buffer);
    expect(attachment.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('forbids attachment on autonomous Gmail canary', () => {
    expect(() =>
      buildRocketseedProbe(
        validInput({
          recipient: GMAIL_CANARY_ADDRESS,
          includeSyntheticPdf: true,
        }),
        FAKE_SECRET,
      ),
    ).toThrow('autonomous Gmail canary forbids attachments');

    const plan = buildRocketseedProbe(
      validInput({
        recipient: GMAIL_CANARY_ADDRESS,
        includeSyntheticPdf: false,
      }),
      FAKE_SECRET,
    );
    expect(plan.message.attachments).toBeUndefined();
  });

  it('builds redacted output and never prints secret values', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const plan = buildRocketseedProbe(validInput(), FAKE_SECRET);
      const summary = buildRocketseedProbeSummary(plan, {
        response: `250 queued ${FAKE_SECRET}`,
        messageId: '<probe@example.com>',
        accepted: [NAVA_ADDRESS],
        rejected: [GMAIL_CANARY_ADDRESS],
      });
      const serialized = JSON.stringify(summary);

      expect(serialized).not.toContain(FAKE_SECRET);
      expect(serialized).not.toContain(NAVA_ADDRESS);
      expect(serialized).not.toContain(GMAIL_CANARY_ADDRESS);
      expect(summary.accepted).toEqual(['n***@legacyhotels.co.za']);
      expect(summary.rejected).toEqual(['a***@gmail.com']);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
