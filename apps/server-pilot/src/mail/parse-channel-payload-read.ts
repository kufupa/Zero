/**
 * Authorized mail_parse_channel_payload reads — bounded body bytes by opaque artifactRef.
 * Mirrors mail_read_artifact authorization patterns without HMS release kernel wiring.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import {
  MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_ID,
  MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_VERSION,
  mailParseChannelPayloadRequestSchema,
  type ChannelPayloadData,
  type MailParseChannelPayloadRequest,
} from './channel-payload-contract.js';
import {
  MAIL_PARSE_CHANNEL_MAX_BYTES,
  parseChannelPayloadFromBytes,
} from './parse-channel-payload.js';

export type AuthorizedMailArtifactBytes = {
  body: Buffer;
  sha256: string;
};

export type ResolveMailArtifactBytes = (
  artifactRef: string,
) => Promise<AuthorizedMailArtifactBytes | null>;

export type MailParseChannelPayloadResult = ToolResult<ChannelPayloadData | null> & {
  evidence: Extract<ToolResult<ChannelPayloadData>['evidence'], { kind: 'mail_attachment' }>;
};

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function emptyMailEvidence(
  artifactRef: string,
  sourceHash: string | null,
  now: Date,
): MailParseChannelPayloadResult['evidence'] {
  return {
    kind: 'mail_attachment',
    id: randomUUID(),
    toolId: MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_ID,
    toolVersion: MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_VERSION,
    attachmentId: artifactRef,
    observedAt: now.toISOString(),
    sourceHash: sourceHash ?? '0'.repeat(64),
    claimKeys: [],
  };
}

function manualResult(args: {
  artifactRef: string;
  sourceHash: string | null;
  now: Date;
  unresolvedFields: string[];
}): MailParseChannelPayloadResult {
  return {
    status: 'manual_required',
    draftReady: false,
    data: null,
    unresolvedFields: args.unresolvedFields,
    evidence: emptyMailEvidence(args.artifactRef, args.sourceHash, args.now),
  };
}

function okResult(args: {
  artifactRef: string;
  data: ChannelPayloadData;
  sourceHash: string;
  now: Date;
}): MailParseChannelPayloadResult {
  return {
    status: 'ok',
    draftReady: false,
    data: args.data,
    unresolvedFields: [],
    evidence: {
      ...emptyMailEvidence(args.artifactRef, args.sourceHash, args.now),
      claimKeys: [
        'channel',
        'externalRef',
        'stayDates.arrival',
        'stayDates.departure',
        'guestLabel',
        'cardHandleAbsent',
      ],
    },
  };
}

function reasonToUnresolved(
  reason: 'empty' | 'unrecognized_channel_fw' | 'missing_required_fields',
): string[] {
  switch (reason) {
    case 'empty':
      return ['artifact.body'];
    case 'unrecognized_channel_fw':
      return ['channel_fw.recognized'];
    case 'missing_required_fields':
      return ['channel', 'externalRef', 'stayDates', 'guestLabel'];
    default:
      return ['parse'];
  }
}

export async function readMailParseChannelPayload(input: {
  request: MailParseChannelPayloadRequest;
  authorizedArtifactRefs: ReadonlySet<string>;
  resolveArtifactBytes: ResolveMailArtifactBytes;
  now?: Date;
  signal?: AbortSignal;
}): Promise<MailParseChannelPayloadResult> {
  const parsedRequest = mailParseChannelPayloadRequestSchema.parse(input.request);
  const now = input.now ?? new Date();
  if (input.signal?.aborted) {
    throw Object.assign(new Error('read was aborted'), { name: 'AbortError' });
  }
  const { artifactRef } = parsedRequest;
  if (!input.authorizedArtifactRefs.has(artifactRef)) {
    return manualResult({
      artifactRef,
      sourceHash: null,
      now,
      unresolvedFields: ['artifactRef.authorized'],
    });
  }

  const resolved = await input.resolveArtifactBytes(artifactRef);
  if (!resolved) {
    return manualResult({
      artifactRef,
      sourceHash: null,
      now,
      unresolvedFields: ['artifactRef.resolved'],
    });
  }

  if (resolved.body.byteLength > MAIL_PARSE_CHANNEL_MAX_BYTES) {
    return manualResult({
      artifactRef,
      sourceHash: resolved.sha256,
      now,
      unresolvedFields: ['artifact.too_large'],
    });
  }

  const digest = sha256Hex(resolved.body);
  if (digest !== resolved.sha256) {
    return manualResult({
      artifactRef,
      sourceHash: digest,
      now,
      unresolvedFields: ['artifact.integrity'],
    });
  }

  const outcome = parseChannelPayloadFromBytes(resolved.body);
  if (!outcome.ok) {
    return manualResult({
      artifactRef,
      sourceHash: digest,
      now,
      unresolvedFields: reasonToUnresolved(outcome.reason),
    });
  }

  return okResult({
    artifactRef,
    data: outcome.data,
    sourceHash: digest,
    now,
  });
}

export const MAIL_PARSE_CHANNEL_PAYLOAD_READ_EXPORTS = {
  toolId: MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_ID,
  toolVersion: MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_VERSION,
} as const;
