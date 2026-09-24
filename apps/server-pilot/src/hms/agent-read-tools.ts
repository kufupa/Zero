/** Model-facing read-tool facade.
 *
 * Inputs are closed and opaque.  The implementation delegates to the trusted
 * executor; it never accepts URLs, selectors, scripts, or PMS record IDs.
 */
import {
  executeRead,
  type ReadExecutionContext,
} from './read-service.js';
import { reservationContextRequestSchema } from './reservation-context-contract.js';
import { quoteRequestSchema } from './quote-request-normalization.js';
import {
  eventReadRequestSchema,
  folioReadRequestSchema,
  groupBlockReadRequestSchema,
  hmsListDocumentsReadRequestSchema,
  hmsSentEmailAuditReadRequestSchema,
  hmsReadDocumentReadRequestSchema,
  notesTracesReadRequestSchema,
  readRefSchema,
  readResultSchema,
  companyAccountReadRequestSchema,
} from './read-service-contracts.js';
import { z } from 'zod';
import {
  mailParseChannelPayloadBodyInputSchema,
  parseChannelPayloadBody,
  type MailParseChannelPayloadBodyResult,
} from '../mail/channel-payload-tool.js';

/** Public tool inputs intentionally omit the dispatcher discriminator. */
export const hmsFindReservationInputSchema = z.object({ candidateId: readRefSchema }).strict();
export const hmsReadReservationInputSchema = reservationContextRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsQuoteStayInputSchema = z
  .object({
    quoteRequestRef: readRefSchema,
    detail: z.enum(['summary', 'detail']).default('summary'),
  })
  .strict();
export const hmsFolioInputSchema = folioReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsListDocumentsInputSchema = hmsListDocumentsReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsSentEmailAuditInputSchema = hmsSentEmailAuditReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsReadDocumentInputSchema = hmsReadDocumentReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsCompanyAccountInputSchema = companyAccountReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsGroupBlockInputSchema = groupBlockReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsEventInputSchema = eventReadRequestSchema
  .omit({ toolId: true, admission: true })
  .strict();
export const hmsNotesTracesInputSchema = notesTracesReadRequestSchema
  .innerType()
  .omit({ toolId: true, admission: true })
  .strict();
export const mailParseChannelPayloadInputSchema = mailParseChannelPayloadBodyInputSchema;
export const agentReadRequestSchema = z.union([
  hmsFindReservationInputSchema,
  hmsReadReservationInputSchema,
  hmsQuoteStayInputSchema,
  hmsFolioInputSchema,
  hmsListDocumentsInputSchema,
  hmsSentEmailAuditInputSchema,
  hmsReadDocumentInputSchema,
  hmsCompanyAccountInputSchema,
  hmsGroupBlockInputSchema,
  hmsEventInputSchema,
  hmsNotesTracesInputSchema,
  mailParseChannelPayloadInputSchema,
]);

export type AgentReadRequest =
  | z.infer<typeof hmsFindReservationInputSchema>
  | z.infer<typeof hmsReadReservationInputSchema>
  | z.infer<typeof hmsQuoteStayInputSchema>
  | z.infer<typeof hmsFolioInputSchema>
  | z.infer<typeof hmsListDocumentsInputSchema>
  | z.infer<typeof hmsSentEmailAuditInputSchema>
  | z.infer<typeof hmsReadDocumentInputSchema>
  | z.infer<typeof hmsCompanyAccountInputSchema>
  | z.infer<typeof hmsGroupBlockInputSchema>
  | z.infer<typeof hmsEventInputSchema>
  | z.infer<typeof hmsNotesTracesInputSchema>
  | z.infer<typeof mailParseChannelPayloadInputSchema>;

export type AgentReadToolResult =
  | Awaited<ReturnType<typeof executeRead>>
  | MailParseChannelPayloadBodyResult;

export type AgentReadTool = {
  id:
    | 'hms_find_reservation'
    | 'hms_read_reservation'
    | 'hms_quote_stay'
    | 'hms_read_folio'
    | 'hms_list_documents'
    | 'hms_sent_email_audit'
    | 'hms_read_document'
    | 'hms_company_account_read'
    | 'hms_group_block_read'
    | 'hms_event_read'
    | 'hms_read_notes_traces'
    | 'mail_parse_channel_payload';
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: AgentReadRequest) => Promise<AgentReadToolResult>;
};

export type AgentReadToolsOptions = Record<never, never>;

export function createAgentReadTools(
  context: ReadExecutionContext,
  _options: AgentReadToolsOptions = {},
): Readonly<Record<string, AgentReadTool>> {
  return {
    hms_find_reservation: {
      id: 'hms_find_reservation',
      description: 'Find a reservation from a trusted opaque candidate reference.',
      inputSchema: hmsFindReservationInputSchema,
      execute: (input) => hmsFindReservation(context, hmsFindReservationInputSchema.parse(input)),
    },
    hms_read_reservation: {
      id: 'hms_read_reservation',
      description:
        'Read entitled reservation sections from a trusted scoped reservation reference.',
      inputSchema: hmsReadReservationInputSchema,
      execute: (input) => hmsReadReservation(context, hmsReadReservationInputSchema.parse(input)),
    },
    hms_quote_stay: {
      id: 'hms_quote_stay',
      description:
        'Read trusted nightly quote facts from a producer-minted opaque request reference.',
      inputSchema: hmsQuoteStayInputSchema,
      execute: (input) => hmsQuoteStay(context, hmsQuoteStayInputSchema.parse(input)),
    },
    hms_read_folio: {
      id: 'hms_read_folio',
      description: 'Read scoped folio, deposit and transaction observations.',
      inputSchema: hmsFolioInputSchema,
      execute: (input) => hmsReadFolio(context, hmsFolioInputSchema.parse(input)),
    },
    hms_list_documents: {
      id: 'hms_list_documents',
      description: 'List scoped HMS document metadata without opening bytes or attachments.',
      inputSchema: hmsListDocumentsInputSchema,
      execute: (input) => hmsListDocuments(context, hmsListDocumentsInputSchema.parse(input)),
    },
    hms_sent_email_audit: {
      id: 'hms_sent_email_audit',
      description: 'Read the HMS sent-email audit rows for a scoped candidate.',
      inputSchema: hmsSentEmailAuditInputSchema,
      execute: (input) => hmsSentEmailAudit(context, hmsSentEmailAuditInputSchema.parse(input)),
    },
    hms_read_document: {
      id: 'hms_read_document',
      description: 'Read bytes of an existing PMS-stored document by trusted scoped reference.',
      inputSchema: hmsReadDocumentInputSchema,
      execute: (input) => hmsReadDocument(context, hmsReadDocumentInputSchema.parse(input)),
    },
    hms_company_account_read: {
      id: 'hms_company_account_read',
      description: 'Read reservation-linked company billing context only.',
      inputSchema: hmsCompanyAccountInputSchema,
      execute: (input) => hmsCompanyAccount(context, hmsCompanyAccountInputSchema.parse(input)),
    },
    hms_group_block_read: {
      id: 'hms_group_block_read',
      description: 'Read scoped group block summary, blocks and delegates.',
      inputSchema: hmsGroupBlockInputSchema,
      execute: (input) => hmsGroupBlock(context, hmsGroupBlockInputSchema.parse(input)),
    },
    hms_event_read: {
      id: 'hms_event_read',
      description: 'Read a scoped HMS event summary.',
      inputSchema: hmsEventInputSchema,
      execute: (input) => hmsEvent(context, hmsEventInputSchema.parse(input)),
    },
    hms_read_notes_traces: {
      id: 'hms_read_notes_traces',
      description: 'Read bounded notes and traces with explicit audience and state filters.',
      inputSchema: hmsNotesTracesInputSchema,
      execute: (input) => hmsNotesTraces(context, hmsNotesTracesInputSchema.parse(input)),
    },
    mail_parse_channel_payload: {
      id: 'mail_parse_channel_payload',
      description: 'Parse channel-manager fields from the supplied message body only; never read mailbox artifacts.',
      inputSchema: mailParseChannelPayloadInputSchema,
      execute: async (input) =>
        parseChannelPayloadBody(mailParseChannelPayloadInputSchema.parse(input)),
    },
  };
}

export async function hmsFindReservation(
  context: ReadExecutionContext,
  input: z.input<typeof hmsFindReservationInputSchema>,
) {
  const parsed = hmsFindReservationInputSchema.parse(input);
  return executeRead(context, { toolId: 'hms_find_reservation', candidateId: parsed.candidateId });
}

export async function hmsReadReservation(
  context: ReadExecutionContext,
  input: z.input<typeof hmsReadReservationInputSchema>,
) {
  const parsed = hmsReadReservationInputSchema.parse(input);
  return executeRead(context, { toolId: 'hms_read_reservation', ...parsed });
}

export async function hmsQuoteStay(
  context: ReadExecutionContext,
  input: z.input<typeof hmsQuoteStayInputSchema>,
) {
  const parsed = hmsQuoteStayInputSchema.parse(input);
  const quoteRequest = context.quoteRequests?.get(parsed.quoteRequestRef);
  if (!quoteRequest) {
    // A body-only connected case may not contain enough authored fields to
    // mint a producer-owned quote request.  Keep this a typed read outcome;
    // never turn missing input into an exception or invented quote.
    return readResultSchema.parse({
      toolId: 'hms_quote_stay',
      schemaVersion: 'hms-read/1',
      status: 'manual_required',
      data: null,
      completeness: 'unknown',
      unavailableSections: [{ section: 'quote', reasonCode: 'INPUT_MISSING' }],
      scopeRef: parsed.quoteRequestRef,
      evidence: [],
      page: null,
      issues: [
        {
          code: 'INPUT_MISSING',
          retryable: false,
          safeNextAction: 'request_input',
        },
      ],
    }) as Awaited<ReturnType<typeof executeRead>>;
  }
  return executeRead(context, {
    toolId: 'hms_quote_stay',
    quoteRequestRef: parsed.quoteRequestRef,
    quoteRequest: quoteRequestSchema.parse(quoteRequest),
    detail: parsed.detail,
  });
}

export async function hmsReadFolio(
  context: ReadExecutionContext,
  input: z.input<typeof hmsFolioInputSchema>,
) {
  const parsed = hmsFolioInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_read_folio',
    ...parsed,
  });
}

export async function hmsListDocuments(
  context: ReadExecutionContext,
  input: z.input<typeof hmsListDocumentsInputSchema>,
) {
  const parsed = hmsListDocumentsInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_list_documents',
    ...parsed,
  });
}

export async function hmsSentEmailAudit(
  context: ReadExecutionContext,
  input: z.input<typeof hmsSentEmailAuditInputSchema>,
) {
  const parsed = hmsSentEmailAuditInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_sent_email_audit',
    ...parsed,
  });
}

export async function hmsReadDocument(
  context: ReadExecutionContext,
  input: z.input<typeof hmsReadDocumentInputSchema>,
) {
  const parsed = hmsReadDocumentInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_read_document',
    ...parsed,
  });
}

export async function hmsCompanyAccount(
  context: ReadExecutionContext,
  input: z.input<typeof hmsCompanyAccountInputSchema>,
) {
  const parsed = hmsCompanyAccountInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_company_account_read',
    ...parsed,
  });
}

export async function hmsGroupBlock(
  context: ReadExecutionContext,
  input: z.input<typeof hmsGroupBlockInputSchema>,
) {
  const parsed = hmsGroupBlockInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_group_block_read',
    ...parsed,
  });
}

export async function hmsEvent(
  context: ReadExecutionContext,
  input: z.input<typeof hmsEventInputSchema>,
) {
  const parsed = hmsEventInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_event_read',
    ...parsed,
  });
}

export async function hmsNotesTraces(
  context: ReadExecutionContext,
  input: z.input<typeof hmsNotesTracesInputSchema>,
) {
  const parsed = hmsNotesTracesInputSchema.parse(input);
  return executeRead(context, {
    toolId: 'hms_read_notes_traces',
    ...parsed,
  });
}
