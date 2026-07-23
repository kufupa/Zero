import { buildReplyHeaders } from './smtp.js';

export type ReplyHeaderSource = {
  messageIdHeader: string | null;
  references: string[] | null;
};

export type ResolveReplyHeadersInput = {
  /** Row from replyToMessageId lookup (selected message). Highest priority. */
  selectedMessage?: ReplyHeaderSource | null;
  /** Explicit client inReplyTo / references. Used when no selected message. */
  explicitInReplyTo?: string | null;
  explicitReferences?: string[] | null;
  /** Latest-thread prior row. Fallback when neither selected nor explicit. */
  latestThreadPrior?: ReplyHeaderSource | null;
};

/**
 * Resolve SMTP In-Reply-To / References for an outbound reply.
 * Priority: selected message → explicit inReplyTo/references → latest-thread prior.
 */
export function resolveReplyHeaders(
  input: ResolveReplyHeadersInput,
): { inReplyTo: string | null; references: string[] } {
  if (input.selectedMessage) {
    return buildReplyHeaders(input.selectedMessage);
  }
  if (input.explicitInReplyTo) {
    return {
      inReplyTo: input.explicitInReplyTo,
      references: input.explicitReferences ?? [],
    };
  }
  if (input.latestThreadPrior) {
    return buildReplyHeaders(input.latestThreadPrior);
  }
  return { inReplyTo: null, references: [] };
}
