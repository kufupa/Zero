type RecipientLike = {
  email?: string | null;
};

type ReplyMessageLike = {
  sender?: RecipientLike | null;
  to?: ReadonlyArray<RecipientLike> | null;
  cc?: ReadonlyArray<RecipientLike> | null;
};

export type ReplyMode = 'reply' | 'replyAll' | 'forward' | null | undefined;

export type DerivedReplyRecipients = {
  to: string[];
  cc: string[];
};

const normalizeEmail = (email?: string | null): string => email?.trim().toLowerCase() ?? '';

const toEmailSet = (emails?: ReadonlyArray<string | null | undefined>): Set<string> => {
  const normalized = (emails ?? [])
    .map((email) => normalizeEmail(email))
    .filter((email) => email.length > 0);
  return new Set(normalized);
};

const pushUniqueRecipient = (
  list: string[],
  seen: Set<string>,
  recipient?: RecipientLike | null,
  excluded?: Set<string>,
) => {
  const rawEmail = recipient?.email?.trim();
  const normalized = normalizeEmail(rawEmail);

  if (!normalized || seen.has(normalized) || excluded?.has(normalized)) {
    return;
  }

  seen.add(normalized);
  list.push(rawEmail!);
};

/**
 * When every participant is "self", exclusion leaves To empty and Reply cannot send.
 * Prefer original To, then sender, then Cc — without excluding — so loopback/self-sent still autofills.
 */
const fillSelfOnlyFallback = (
  to: string[],
  seen: Set<string>,
  message: ReplyMessageLike,
) => {
  if (to.length > 0) return;

  for (const recipient of message.to ?? []) {
    pushUniqueRecipient(to, seen, recipient);
    if (to.length > 0) return;
  }

  pushUniqueRecipient(to, seen, message.sender);
  if (to.length > 0) return;

  for (const recipient of message.cc ?? []) {
    pushUniqueRecipient(to, seen, recipient);
    if (to.length > 0) return;
  }
};

export function deriveReplyRecipients(params: {
  mode: ReplyMode;
  message?: ReplyMessageLike | null;
  excludedEmails?: ReadonlyArray<string | null | undefined>;
}): DerivedReplyRecipients {
  const { mode, message, excludedEmails } = params;

  if (!message || mode === 'forward') {
    return { to: [], cc: [] };
  }

  const excluded = toEmailSet(excludedEmails);

  if (mode === 'reply') {
    const to: string[] = [];
    const seen = new Set<string>();

    pushUniqueRecipient(to, seen, message.sender, excluded);

    if (to.length === 0) {
      for (const recipient of message.to ?? []) {
        pushUniqueRecipient(to, seen, recipient, excluded);
        if (to.length > 0) break;
      }
    }

    if (to.length === 0) {
      for (const recipient of message.cc ?? []) {
        pushUniqueRecipient(to, seen, recipient, excluded);
        if (to.length > 0) break;
      }
    }

    fillSelfOnlyFallback(to, seen, message);

    return { to, cc: [] };
  }

  if (mode === 'replyAll') {
    const to: string[] = [];
    const cc: string[] = [];
    const toSeen = new Set<string>();
    const ccSeen = new Set<string>();

    pushUniqueRecipient(to, toSeen, message.sender, excluded);

    for (const recipient of message.to ?? []) {
      pushUniqueRecipient(to, toSeen, recipient, excluded);
    }

    for (const recipient of message.cc ?? []) {
      const normalized = normalizeEmail(recipient?.email);
      if (!normalized || excluded.has(normalized) || toSeen.has(normalized) || ccSeen.has(normalized)) {
        continue;
      }
      ccSeen.add(normalized);
      cc.push(recipient.email!.trim());
    }

    fillSelfOnlyFallback(to, toSeen, message);

    return { to, cc };
  }

  return { to: [], cc: [] };
}
