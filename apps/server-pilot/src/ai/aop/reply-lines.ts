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

function oneLine(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export const pickReplyLineInputSchema = z
  .object({
    code: z.enum(REPLY_CODES),
    done: z.enum(REPLY_DONE).optional(),
    documentKind: z.string().optional(),
    redirectTo: z.string().optional(),
    partnerDestination: z.string().optional(),
    confirmationNumber: z.string().optional(),
    attached: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.code === 'C' && !value.done) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'code C requires done (amended, cancelled, or released)',
      });
    }
    if (value.code === 'B' && !oneLine(value.confirmationNumber)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'code B requires confirmationNumber',
      });
    }
    if (value.code === 'S' && value.attached !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'code S requires attached: true',
      });
    }
  });

export const pickReplyLineOutputSchema = z
  .object({
    code: z.enum(REPLY_CODES),
    line: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.line.includes('\n') || value.line.includes('\r')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'line must be a single sentence',
      });
    }
  });

export type PickReplyLineInput = z.input<typeof pickReplyLineInputSchema>;
export type PickReplyLineOutput = z.infer<typeof pickReplyLineOutputSchema>;

export const pickReplyLineDescription =
  'Build the Centurion one-line staff reply for a visible-reply move. Call when workflow is acknowledge, payment_ack, amend, cancel, create, send_document or forward_to_partner and staff would send a one-liner rather than stay silent. Pass code K (received), C (requires done: amended/cancelled/released), B (requires confirmationNumber; booked + pro forma to follow), S (requires attached:true; documentKind only names it), or R (please contact dest; redirectTo or partnerDestination). Do not call B/C/S unless the HMS write saved or the document is attached. Output.line is replyDraft; no sign-off — the pane adds the signature.';

function booking(confirmationNumber?: string): string {
  const conf = oneLine(confirmationNumber);
  return conf ? `booking ${conf}` : 'the booking';
}

function sentence(code: ReplyCode, input: PickReplyLineInput): string {
  const conf = oneLine(input.confirmationNumber) || undefined;
  switch (code) {
    case 'K':
      return conf
        ? `Good day, correspondence for booking ${conf} has been received.`
        : 'Good day, your correspondence has been received.';
    case 'C': {
      const done = input.done;
      if (!done) throw new Error('code C requires done');
      return `Good day, ${booking(conf)} has been ${done} as per your request.`;
    }
    case 'B':
      return `Good day, ${booking(conf)} has been made and a pro forma will follow.`;
    case 'S': {
      const kind = oneLine(input.documentKind);
      return kind
        ? `Good day, please see attached the ${kind}.`
        : 'Good day, please see attached.';
    }
    case 'R': {
      const dest =
        oneLine(input.redirectTo) || oneLine(input.partnerDestination) || 'the relevant department';
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
