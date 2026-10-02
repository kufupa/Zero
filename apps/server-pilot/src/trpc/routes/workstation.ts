import { mailboxProcedure, privateProcedure, publicProcedure, router } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { QUOTE_MEALS } from '../../quote-proposal/description.js';
import { emailsMatch } from '../../quote-proposal/identity.js';
import { buildQuoteProposalPdf, ProposalInputError } from '../../quote-proposal/proposal-pdf.js';
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

export const workstationRouter = router({
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
      try {
        const { fileName, pdf } = await buildQuoteProposalPdf(
          input,
          { name: ctx.sessionUser.name?.trim() || '', email: ctx.sessionUser.email },
          gotenbergUrl,
        );
        return { fileName, pdfBase64: Buffer.from(pdf).toString('base64') };
      } catch (err) {
        throw new TRPCError({
          code: err instanceof ProposalInputError ? 'BAD_REQUEST' : 'BAD_GATEWAY',
          message: err instanceof Error ? err.message : 'gotenberg convert failed',
        });
      }
    }),
});
