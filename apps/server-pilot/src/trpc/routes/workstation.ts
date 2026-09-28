import { privateProcedure, router } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { QUOTE_MEALS } from '../../quote-proposal/description.js';
import { emailsMatch } from '../../quote-proposal/identity.js';
import { buildQuoteProposalPdf, ProposalInputError } from '../../quote-proposal/proposal-pdf.js';

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
  ping: privateProcedure.input(workstationPingInput).mutation(async ({ input }) => {
    return {
      status: 'ok' as const,
      receivedUser: input.workstationUser,
      receivedEmail: input.outlookEmail,
      serverTime: new Date().toISOString(),
    };
  }),
  quoteProposalPdf: privateProcedure
    .input(quoteProposalPdfInput)
    .mutation(async ({ input, ctx }) => {
      if (!emailsMatch(ctx.sessionUser.email, input.outlookEmail)) {
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
