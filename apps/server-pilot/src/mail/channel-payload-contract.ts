import { z } from 'zod';

export const MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_ID = 'mail_parse_channel_payload' as const;
export const MAIL_PARSE_CHANNEL_PAYLOAD_TOOL_VERSION = '1';

const opaqueArtifactRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected an opaque mail artifact reference');

export const mailParseChannelPayloadRequestSchema = z
  .object({
    artifactRef: opaqueArtifactRefSchema,
  })
  .strict();

export type MailParseChannelPayloadRequest = z.infer<typeof mailParseChannelPayloadRequestSchema>;

export const channelPayloadChannelSchema = z.enum([
  'webbeds',
  'ratetiger',
  'synxis',
  'unknown',
]);

export type ChannelPayloadChannel = z.infer<typeof channelPayloadChannelSchema>;

export const channelPayloadStayDatesSchema = z
  .object({
    arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const channelPayloadDataSchema = z
  .object({
    channel: channelPayloadChannelSchema,
    externalRef: z.string().min(1),
    stayDates: channelPayloadStayDatesSchema,
    guestLabel: z.string().min(1),
    cardHandleAbsent: z.boolean(),
  })
  .strict();

export type ChannelPayloadData = z.infer<typeof channelPayloadDataSchema>;

export type MailParseChannelPayloadOracle = ChannelPayloadData;

export type MailParseChannelPayloadActual = ChannelPayloadData;
