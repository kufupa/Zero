import { z } from 'zod';

const participantSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const corpusMessageSchema = z.object({
  id: z.string().min(1),
  from: participantSchema,
  to: z.array(participantSchema).min(1),
  cc: z.array(participantSchema).optional(),
  receivedOn: z.string().min(1),
  subject: z.string(),
  bodyText: z.string(),
  bodyIsHtml: z.boolean().optional().default(false),
  unread: z.boolean(),
  isDraft: z.boolean().optional().default(false),
});

const draftSchema = z.object({
  bodyText: z.string(),
  bodyIsHtml: z.boolean().optional().default(false),
  depth: z.enum(['full', 'minimal']),
});

const centurionCorpusThreadSchema = z
  .object({
    id: z.string().min(1),
    folder: z.literal('inbox').default('inbox'),
    labels: z.array(z.object({ id: z.string(), name: z.string() })).optional().default([]),
    messages: z.array(corpusMessageSchema).min(1),
    draft: draftSchema,
  })
  .refine((thread) => thread.messages.some((m) => !m.isDraft), {
    message: 'Each thread needs at least one non-draft inbound message',
  });

export const CenturionCorpusFileSchema = z.object({
  version: z.literal(1),
  threads: z.array(centurionCorpusThreadSchema).min(15).max(30),
});

export type CenturionCorpusFile = z.infer<typeof CenturionCorpusFileSchema>;
export type CenturionCorpusThread = z.infer<typeof centurionCorpusThreadSchema>;
