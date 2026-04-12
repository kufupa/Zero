import { z } from 'zod';

const participantSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

export const demoThreadFolderSchema = z.enum([
  'internal',
  'individual',
  'group',
  'travel-agents',
  'spam',
]);

export type DemoThreadFolder = z.infer<typeof demoThreadFolderSchema>;

export const demoMessageSchema = z.object({
  id: z.string().min(1),
  sender: participantSchema,
  to: z.array(participantSchema).min(1),
  cc: z.array(participantSchema).optional(),
  bcc: z.array(participantSchema).optional(),
  subject: z.string(),
  body: z.string(),
  receivedOn: z.string().min(1),
  unread: z.boolean(),
  isDraft: z.boolean().optional(),
});

export const demoThreadSchema = z
  .object({
    id: z.string().min(1),
    folder: demoThreadFolderSchema,
    urgent: z.boolean().default(false),
    llmIssueMessage: z.string().min(1).optional(),
    labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    messages: z.array(demoMessageSchema).min(1),
  })
  .superRefine((thread, ctx) => {
    const hasInboundMessage = thread.messages.some((message) => message.isDraft !== true);
    if (!hasInboundMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each thread needs at least one non-draft message',
        path: ['messages'],
      });
    }
  });

export const demoCorpusSchema = z.object({
  version: z.literal(1),
  threads: z.array(demoThreadSchema).min(10),
});

export type DemoMessage = z.infer<typeof demoMessageSchema>;
export type DemoThread = z.infer<typeof demoThreadSchema>;
export type DemoCorpus = z.infer<typeof demoCorpusSchema>;

export function parseDemoCorpus(data: unknown): DemoCorpus {
  return demoCorpusSchema.parse(data);
}
