/**
 * The quote follow-up card (R10, R18). The server keeps the follow-up it drafted on a quote thread as a candidate reply
 * draft. Staff can use it, which makes it the thread's reply draft, or dismiss it. Nothing here sends mail.
 */

/** The follow-up as the server returns it. The body is stored HTML, sanitised before it is shown or inserted. */
export type FollowUp = {
  state: 'suggested' | 'in_reply';
  id: string;
  subject: string | null;
  htmlBody: string;
  replyToMessageId: string | null;
};

/** `active_exists`: another reply draft holds the thread's slot. `gone`: the suggestion is no longer open. */
export type FollowUpUse =
  | { status: 'used'; followUp: FollowUp }
  | { status: 'active_exists' }
  | { status: 'gone' };

export type FollowUpClient = {
  find: (input: { internetMessageId: string }) => Promise<FollowUp | null>;
  use: (input: { draftId: string; replaceActive: boolean }) => Promise<FollowUpUse>;
  dismiss: (input: { draftId: string }) => Promise<'dismissed' | 'gone'>;
};

type TrpcFollowUpRoutes = {
  workItems?: {
    followUpByMessage?: { query: (input: { internetMessageId: string }) => Promise<FollowUp | null> };
    useFollowUp?: {
      mutate: (input: { draftId: string; replaceActive?: boolean }) => Promise<FollowUp>;
    };
    dismissFollowUp?: { mutate: (input: { draftId: string }) => Promise<unknown> };
  };
};

function trpcCode(error: unknown): string | null {
  return (error as { data?: { code?: string } | null } | null)?.data?.code ?? null;
}

/** Binds the three follow-up procedures off a tRPC client. Null when the routes are missing. */
export function followUpClientFromTrpc(trpc: unknown): FollowUpClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcFollowUpRoutes).workItems;
  const find = routes?.followUpByMessage;
  const use = routes?.useFollowUp;
  const dismiss = routes?.dismissFollowUp;
  if (!find || !use || !dismiss) return null;
  return {
    find: (input) => find.query(input),
    use: async (input) => {
      try {
        return { status: 'used', followUp: await use.mutate(input) };
      } catch (error) {
        if (trpcCode(error) === 'CONFLICT') return { status: 'active_exists' };
        if (trpcCode(error) === 'NOT_FOUND') return { status: 'gone' };
        throw error;
      }
    },
    dismiss: async (input) => {
      try {
        await dismiss.mutate(input);
        return 'dismissed';
      } catch (error) {
        if (trpcCode(error) === 'NOT_FOUND') return 'gone';
        throw error;
      }
    },
  };
}

export const FOLLOW_UP_COPY = {
  heading: 'Follow-up suggested (no reply in 3 business days)',
  caption:
    'Nava drafted this follow-up to the guest. Using it makes it the reply draft on this thread. Nothing is sent.',
  use: 'Use this follow-up',
  using: 'Making this the reply draft…',
  dismiss: 'Dismiss',
  replaceQuestion: 'Replace current draft?',
  replaceDetail: 'Another reply draft is open on this thread. Replacing it discards that draft.',
  replace: 'Replace current draft',
  keep: 'Keep current draft',
  gone: 'This follow-up is no longer open. The guest or staff replied first, or it was dismissed.',
  failed: "Nava couldn't update this follow-up. Try again.",
  inReply: 'This follow-up is the reply draft on this thread. It sends only when you send it.',
  insert: 'Insert draft in Outlook',
  inserting: 'Inserting the draft…',
  inserted: 'Draft inserted in Outlook Drafts.',
  insertFailed: 'Outlook did not confirm the draft. Check Outlook Drafts before trying again.',
  noInsert: 'This Outlook add-in cannot insert drafts. Update the add-in.',
  openReply: 'Open in reply box',
} as const;
