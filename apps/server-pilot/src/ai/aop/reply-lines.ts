import { z } from 'zod';

export const REPLY_CODES = ['K', 'C', 'B', 'S', 'R'] as const;
export type ReplyCode = (typeof REPLY_CODES)[number];

export const REPLY_DONE = ['amended', 'cancelled', 'released'] as const;
export type ReplyDone = (typeof REPLY_DONE)[number];

/** Agent workflow → visible-reply code. Other workflows stay silent (empty replyDraft). */
export const REPLY_CODE_FOR_WORKFLOW = {
  acknowledge: 'K',
  payment_ack: 'K',
  amend: 'C',
  cancel: 'C',
  create: 'B',
  send_document: 'S',
  forward_to_partner: 'R',
} as const satisfies Record<string, ReplyCode>;

export const pickReplyLineInputSchema = z
  .object({
    code: z.enum(REPLY_CODES),
    done: z.enum(REPLY_DONE).optional(),
    documentKind: z.string().optional(),
    redirectTo: z.string().optional(),
    confirmationNumber: z.string().optional(),
  })
  .strict();

export const pickReplyLineOutputSchema = z
  .object({
    code: z.enum(REPLY_CODES),
    line: z.string().min(1),
  })
  .strict();

export type PickReplyLineInput = z.infer<typeof pickReplyLineInputSchema>;
export type PickReplyLineOutput = z.infer<typeof pickReplyLineOutputSchema>;

export const pickReplyLineDescription =
  'Build the Centurion one-line staff reply for a visible-reply move. Call when workflow is acknowledge, payment_ack, amend, cancel, create, send_document or forward_to_partner and staff would send a one-liner rather than stay silent. Pass code K (received), C (amended/cancelled/released), B (booked + pro forma to follow), S (please see attached), or R (please contact dest). Output.line is replyDraft; no sign-off — the pane adds the signature.';

function booking(confirmationNumber?: string): string {
  const conf = confirmationNumber?.trim();
  return conf ? `booking ${conf}` : 'the booking';
}

function sentence(code: ReplyCode, input: PickReplyLineInput): string {
  const conf = input.confirmationNumber?.trim();
  switch (code) {
    case 'K':
      return conf
        ? `Good day, correspondence for booking ${conf} has been received.`
        : 'Good day, your correspondence has been received.';
    case 'C': {
      const done = input.done ?? 'amended';
      return `Good day, ${booking(conf)} has been ${done} as per your request.`;
    }
    case 'B':
      return `Good day, ${booking(conf)} has been made and a pro forma will follow.`;
    case 'S': {
      const kind = input.documentKind?.trim();
      return kind
        ? `Good day, please see attached the ${kind}.`
        : 'Good day, please see attached.';
    }
    case 'R': {
      const dest = input.redirectTo?.trim() || 'the relevant department';
      return `Good day, please contact ${dest}.`;
    }
  }
}

/** Pure one-line Centurion reply. No DB, HMS, or LLM. */
export function pickReplyLine(input: PickReplyLineInput): PickReplyLineOutput {
  const parsed = pickReplyLineInputSchema.parse(input);
  return pickReplyLineOutputSchema.parse({
    code: parsed.code,
    line: sentence(parsed.code, parsed),
  });
}
