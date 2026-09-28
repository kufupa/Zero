/**
 * Body-only channel payload parser.
 *
 * This is intentionally not `parse-channel-payload-read.ts`: that adapter
 * dereferences an artifactRef and therefore belongs to the permanently
 * excluded mailbox-artifact path.  This tool accepts only the already supplied
 * incoming message body and emits a digest, never mailbox bytes.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MAIL_PARSE_CHANNEL_MAX_BYTES,
  parseChannelPayloadFromText,
} from '../../../../../../apps/server-pilot/src/mail/parse-channel-payload.js';
import type { ChannelPayloadData } from '../../../../../../apps/server-pilot/src/mail/channel-payload-contract.js';

export const mailParseChannelPayloadBodyInputSchema = z
  .object({ body: z.string().min(1) })
  .strict()
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(value.body, 'utf8') > MAIL_PARSE_CHANNEL_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: MAIL_PARSE_CHANNEL_MAX_BYTES, type: 'string', inclusive: true, path: ['body'], message: 'body exceeds parser bound' });
    }
  });

export type MailParseChannelPayloadBodyInput = z.infer<
  typeof mailParseChannelPayloadBodyInputSchema
>;

export type MailParseChannelPayloadBodyResult = {
  toolId: 'mail_parse_channel_payload';
  status: 'ok' | 'manual_required';
  data: ChannelPayloadData | null;
  unresolvedFields: string[];
  /** Digest binds the supplied body without returning or storing its bytes. */
  sourceHash: string;
};

export function parseChannelPayloadBody(
  input: MailParseChannelPayloadBodyInput,
): MailParseChannelPayloadBodyResult {
  const parsed = mailParseChannelPayloadBodyInputSchema.parse(input);
  const sourceHash = createHash('sha256').update(parsed.body, 'utf8').digest('hex');
  const outcome = parseChannelPayloadFromText(parsed.body);
  if (!outcome.ok) {
    return {
      toolId: 'mail_parse_channel_payload',
      status: 'manual_required',
      data: null,
      unresolvedFields: [outcome.reason],
      sourceHash,
    };
  }
  return {
    toolId: 'mail_parse_channel_payload',
    status: 'ok',
    data: outcome.data,
    unresolvedFields: [],
    sourceHash,
  };
}
