import { outlookSyncRouter } from './outlook-sync.js';
import { mailboxProcedure, privateProcedure, publicProcedure, router } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { proposalDescription, QUOTE_MEALS } from '../../quote-proposal/description.js';
import { HOTEL_TELEPHONE, quotePdfFileName } from '../../quote-proposal/filename.js';
import { convertXlsxWithGotenberg } from '../../quote-proposal/gotenberg.js';
import { emailsMatch } from '../../quote-proposal/identity.js';
import { patchProposalWorkbook } from '../../quote-proposal/patch-template.js';
import { getDb } from '../../db/client.js';
import { BridgeTicketDeniedError, issueBridgeTicket } from '../../outlook-security/authorization.js';

export const workstationPingInput = z.object({
  workstationUser: z.string().default('unknown'),
  outlookEmail: z.string().default('unknown'),
  outlookVersion: z.string().default('unknown'),
});

const quoteProposalLineInput = z.object({
  dateLabel: z.string().min(1),
  qty: z.number().int().positive(),
  roomCode: z.string().min(1),
  meal: z.enum(QUOTE_MEALS),
  nights: z.number().int().positive(),
  rate: z.number().nonnegative(),
});

export const quoteProposalPdfInput = z.object({
  outlookEmail: z.string().min(1),
  attention: z.string().default(''),
  company: z.string().default(''),
  clientEmail: z.string().default(''),
  clientTelephone: z.string().default(''),
  agency: z.string().min(1),
  dateLabel: z.string().min(1),
  lines: z.array(quoteProposalLineInput).min(1).max(7),
});

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../fixtures/centurion-quotation-template.xlsx', import.meta.url),
);

export const workstationRouter = router({
  outlookSync: outlookSyncRouter,
  bridgeTicket: publicProcedure.input(z.object({
    deviceId: z.string().uuid(), paneChallenge: z.string().length(43), action: z.string().min(1).max(64),
    storeId: z.string().min(1).max(512).optional(), operationId: z.string().min(1).max(128).optional(),
    resources: z.array(z.string().min(1).max(512)).max(25).optional(),
    sourceFolderId: z.string().min(1).max(512).optional(), destinationFolderId: z.string().min(1).max(512).optional(),
  }).strict()).mutation(async ({ input, ctx }) => {
    // Public procedure deliberately skips the test-only injected sessionUser shortcut.
    // A real Better Auth cookie and original live DB session are mandatory.
    const transportId = ctx.reqHeaders.get('x-zero-active-transport');
    if (!transportId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Bridge ticket denied' });
    try {
      return await issueBridgeTicket(getDb(), ctx.auth, ctx.reqHeaders, { ...input, transportId });
    } catch (error) {
      if (error instanceof BridgeTicketDeniedError) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Bridge ticket denied' });
      }
      // Main's onError logger sees this category, not the underlying database
      // error (which may contain a connection string or request parameters).
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Bridge ticket unavailable' });
    }
  }),
  ping: privateProcedure.input(workstationPingInput).mutation(async ({ input }) => {
    return {
      status: 'ok' as const,
      receivedUser: input.workstationUser,
      receivedEmail: input.outlookEmail,
      serverTime: new Date().toISOString(),
    };
  }),
  quoteProposalPdf: mailboxProcedure
    .input(quoteProposalPdfInput)
    .mutation(async ({ input, ctx }) => {
      // Resolve the selected transport through the same mailbox-access guard
      // as other mail routes. Access to a *different* shared mailbox must not
      // let a pane mix that address into the current quotation workflow.
      if (!emailsMatch(ctx.transportEmail, input.outlookEmail)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'OUTLOOK_EMAIL_MISMATCH',
        });
      }
      const gotenbergUrl = process.env.GOTENBERG_URL?.trim();
      if (!gotenbergUrl) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'GOTENBERG_URL missing',
        });
      }
      let descriptions: string[];
      try {
        descriptions = input.lines.map((line) => proposalDescription(line.roomCode, line.meal));
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'unknown room code',
        });
      }
      const template = readFileSync(TEMPLATE_PATH);
      const xlsx = patchProposalWorkbook(template, {
        attention: input.attention,
        company: input.company,
        clientEmail: input.clientEmail,
        clientTelephone: input.clientTelephone,
        signerName: ctx.sessionUser.name?.trim() || '',
        signerEmail: ctx.sessionUser.email,
        signerTelephone: HOTEL_TELEPHONE,
        lines: input.lines.map((line, index) => ({
          dateLabel: line.dateLabel,
          qty: line.qty,
          description: descriptions[index]!,
          nights: line.nights,
          rate: line.rate,
        })),
      });
      let pdf: Uint8Array;
      try {
        pdf = await convertXlsxWithGotenberg(xlsx, { url: gotenbergUrl });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: err instanceof Error ? err.message : 'gotenberg convert failed',
        });
      }
      return {
        fileName: quotePdfFileName(input.agency, input.dateLabel),
        pdfBase64: Buffer.from(pdf).toString('base64'),
      };
    }),
});
