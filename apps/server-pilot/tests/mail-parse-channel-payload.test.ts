import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ToolResultSchema } from '../src/ai/draft-evidence.js';
import {
  compareMailChannelPayload,
  type MailChannelPayloadCompareV1,
} from '../src/mail/mail-channel-payload-compare.js';
import {
  MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_ID,
  MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_VERSION,
  channelPayloadDataSchema,
} from '../src/mail/channel-payload-contract.js';
import {
  extractChannelQuotedBlock,
  parseChannelPayloadFromBytes,
  parseChannelPayloadFromText,
} from '../src/mail/parse-channel-payload.js';
import { readMailParseChannelPayload } from '../src/mail/parse-channel-payload-read.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const webbedsFixturePath = join(here, 'fixtures/channel-fw-webbeds-synthetic.txt');
const webbedsFixtureBody = readFileSync(webbedsFixturePath);
const ratetigerFixturePath = join(here, 'fixtures/channel-fw-ratetiger-synthetic.txt');
const ratetigerFixtureBody = readFileSync(ratetigerFixturePath);
const synxisFixturePath = join(here, 'fixtures/channel-fw-synxis-synthetic.txt');
const synxisFixtureBody = readFileSync(synxisFixturePath);

const WEBBEDS_ORACLE = channelPayloadDataSchema.parse({
  channel: 'webbeds',
  externalRef: 'WB-TEST-12345',
  stayDates: { arrival: '2026-10-15', departure: '2026-10-18' },
  guestLabel: 'TESTGUEST, Sample',
  cardHandleAbsent: true,
});

const RATETIGER_ORACLE = channelPayloadDataSchema.parse({
  channel: 'ratetiger',
  externalRef: 'RT-TEST-99881',
  stayDates: { arrival: '2026-11-01', departure: '2026-11-04' },
  guestLabel: 'SAMPLEGUEST, RateTiger',
  cardHandleAbsent: true,
});

const SYNXIS_ORACLE = channelPayloadDataSchema.parse({
  channel: 'synxis',
  externalRef: 'SYX-TEST-55442',
  stayDates: { arrival: '2026-12-15', departure: '2026-12-18' },
  guestLabel: 'SYNTEST, Guest',
  cardHandleAbsent: true,
});

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('parseChannelPayloadFromText', () => {
  it('parses synthetic WebBeds channel_fw forward with see-below quoted OTA', () => {
    const outcome = parseChannelPayloadFromText(webbedsFixtureBody.toString('utf8'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual(WEBBEDS_ORACLE);
  });

  it('parses synthetic RateTiger channel_fw forward', () => {
    const outcome = parseChannelPayloadFromText(ratetigerFixtureBody.toString('utf8'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual(RATETIGER_ORACLE);
  });

  it('parses synthetic SynXis channel_fw forward (DMY dates)', () => {
    const outcome = parseChannelPayloadFromText(synxisFixtureBody.toString('utf8'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual(SYNXIS_ORACLE);
  });

  it('extractChannelQuotedBlock keeps OTA lines after human cover', () => {
    const block = extractChannelQuotedBlock(webbedsFixtureBody.toString('utf8'));
    expect(block).toMatch(/WebBeds Booking Notification/i);
    expect(block).toMatch(/WB-TEST-12345/);
  });

  it('rejects empty body', () => {
    expect(parseChannelPayloadFromText('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects non-channel spam without see-below marker', () => {
    const outcome = parseChannelPayloadFromText('Buy cheap watches now.');
    expect(outcome.ok).toBe(false);
  });
});

describe('readMailParseChannelPayload', () => {
  const artifactRef = 'mail-artifact-ref-wb-test-001';

  it('returns ok ToolResult with hash-bound mail evidence for authorized fixture ref', async () => {
    const body = webbedsFixtureBody;
    const result = await readMailParseChannelPayload({
      request: { artifactRef },
      authorizedArtifactRefs: new Set([artifactRef]),
      resolveArtifactBytes: async () => ({
        body,
        sha256: sha256Hex(body),
      }),
    });

    expect(result.status).toBe('ok');
    expect(result.data).toEqual(WEBBEDS_ORACLE);
    expect(result.evidence.toolId).toBe(MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_ID);
    expect(result.evidence.toolVersion).toBe(MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_VERSION);
    expect(result.evidence.attachmentId).toBe(artifactRef);
    expect(ToolResultSchema.safeParse(result).success).toBe(true);
  });

  it('blocks unauthorized artifactRef before resolve', async () => {
    const resolve = vi.fn(async () => null);
    const result = await readMailParseChannelPayload({
      request: { artifactRef: 'foreign-ref' },
      authorizedArtifactRefs: new Set([artifactRef]),
      resolveArtifactBytes: resolve,
    });
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('artifactRef.authorized');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('mail_parse_channel_payload compare (Wave A11 fixture)', () => {
  it('compare.v1 all-required-pass for fixture oracle vs parse result', () => {
    const parsed = parseChannelPayloadFromBytes(webbedsFixtureBody);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const compare: MailChannelPayloadCompareV1 = compareMailChannelPayload(
      WEBBEDS_ORACLE,
      parsed.data,
    );
    expect(compare.toolId).toBe('mail_parse_channel_payload');
    expect(compare.allRequiredPass).toBe(true);
    expect(compare.rows.every((row) => !row.required || row.pass)).toBe(true);
  });

  it('compare.v1 all-required-pass for RateTiger + SynXis fixtures', () => {
    for (const [body, oracle] of [
      [ratetigerFixtureBody, RATETIGER_ORACLE],
      [synxisFixtureBody, SYNXIS_ORACLE],
    ] as const) {
      const parsed = parseChannelPayloadFromBytes(body);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const compare = compareMailChannelPayload(oracle, parsed.data);
      expect(compare.allRequiredPass).toBe(true);
    }
  });
});
