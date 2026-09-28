import { z } from 'zod';

/**
 * Private connected-runner packet. New corpus packets bind the real incoming
 * message ID directly; older packets may carry only metadata for a paired
 * hotel reply. A packet must have one or the other so read-service context
 * never receives an invented trigger ID.
 */
export const connectedCaseSchema = z
  .object({
    schemaVersion: z.literal('connected-read-case/v1'),
    caseId: z.string().min(1).max(200),
    propertyCode: z.literal('HRCEN'),
    incoming: z
      .object({
        body: z
          .string()
          .min(1)
          .max(64 * 1024),
        subject: z.string().max(500).default(''),
        sender: z.string().max(320).default(''),
        timestamp: z.string().datetime({ offset: true }),
        messageId: z.string().min(1).max(500).optional(),
      })
      .strict(),
    /** Metadata only; a reply body is never a runner input. */
    pairedReply: z
      .object({
        messageId: z.string().min(1).max(500),
        timestamp: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.incoming.messageId && !value.pairedReply) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['incoming', 'messageId'],
        message: 'incoming.messageId or pairedReply metadata is required',
      });
    }
    if (value.pairedReply) {
      const incomingAt = Date.parse(value.incoming.timestamp);
      const replyAt = Date.parse(value.pairedReply.timestamp);
      if (!Number.isFinite(incomingAt) || !Number.isFinite(replyAt) || replyAt < incomingAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pairedReply', 'timestamp'],
          message: 'pairedReply timestamp must follow incoming timestamp chronologically',
        });
      }
    }
  });

export type ConnectedCase = z.infer<typeof connectedCaseSchema>;

export function connectedCaseTriggerMessageId(input: ConnectedCase): string {
  const messageId = input.incoming.messageId ?? input.pairedReply?.messageId;
  if (!messageId) throw new Error('CONNECTED_CASE_TRIGGER_MISSING');
  return messageId;
}

export function connectedCasePairedReplyMessageIdSha256Input(input: ConnectedCase): string | null {
  return input.pairedReply?.messageId ?? null;
}
