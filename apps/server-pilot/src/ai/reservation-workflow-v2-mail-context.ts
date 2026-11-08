export const RESERVATION_WORKFLOW_V2_MAIL_CANDIDATE_LIMIT = 10;

export type ReservationWorkflowV2MailQuery = {
  transportId: string;
  excludedThreadId: string;
  cutoff: Date;
  matchKind: unknown;
  confirmation: string | null;
  guestName: string | null;
  date: { arrivalRaw: string; departureRaw: string } | null;
  searchAnchor: string;
  pattern: string;
  participants: string[];
  limit: number;
  candidateLimit: number;
  fieldScope: readonly ['subject', 'textBody'];
  visibility: { messageHistoryOnly: false; threadHistoryOnly: false; threadTrashedAt: null; threadSpamAt: null };
  order: readonly ['arrivedAt_desc', 'id_desc'];
};

export type ReservationWorkflowV2MailRow = {
  id: string; threadId: string; direction?: string; subject?: string | null; textBody?: string | null;
  fromAddress: string; toAddresses?: string[] | null; ccAddresses?: string[] | null; arrivedAt: unknown;
  sourceProvenance?: { attention?: unknown } | null;
};

type MailCandidateRow = {
  id: string; threadId: string; direction?: string; subject?: string; excerpt?: string; arrivedAt: string;
  participantOverlap: boolean; confirmationMatch: boolean; guestDatesMatch: boolean; matchEligible: boolean; reviewReason?: string;
};

export function buildReservationWorkflowV2MailQuery(
  criteria: Record<string, unknown>,
  context: { transportId: string; source: { threadId: string; arrivedAt: string }; participants?: string[] },
): ReservationWorkflowV2MailQuery | null {
  const matchKind = criteria.matchKind;
  const confirmation = typeof criteria.confirmation === 'string' ? criteria.confirmation : null;
  const term = typeof criteria.guestName === 'string' ? criteria.guestName.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
  const guestName = term.length >= 3 ? term : null;
  const dates = Array.isArray(criteria.dates) ? criteria.dates as Array<Record<string, unknown>> : [];
  const date = dates.find((row) => typeof row.arrivalRaw === 'string' && row.arrivalRaw.trim() &&
    typeof row.departureRaw === 'string' && row.departureRaw.trim());
  const searchAnchor = matchKind === 'exact_confirmation' && confirmation ? confirmation :
    matchKind === 'guest_plus_dates' ? guestName : null;
  if (!searchAnchor) return null;
  return {
    transportId: context.transportId, excludedThreadId: context.source.threadId, cutoff: new Date(context.source.arrivedAt),
    matchKind, confirmation, guestName,
    date: date ? { arrivalRaw: String(date.arrivalRaw), departureRaw: String(date.departureRaw) } : null,
    searchAnchor, pattern: `%${searchAnchor.replace(/[\\%_]/g, '\\$&')}%`, participants: context.participants ?? [],
    limit: RESERVATION_WORKFLOW_V2_MAIL_CANDIDATE_LIMIT + 1, candidateLimit: RESERVATION_WORKFLOW_V2_MAIL_CANDIDATE_LIMIT,
    fieldScope: ['subject', 'textBody'],
    visibility: { messageHistoryOnly: false, threadHistoryOnly: false, threadTrashedAt: null, threadSpamAt: null },
    order: ['arrivedAt_desc', 'id_desc'],
  };
}

export function selectReservationWorkflowV2MailCandidates(
  query: ReservationWorkflowV2MailQuery,
  rows: ReservationWorkflowV2MailRow[],
  storeCoverage?: { complete?: boolean; notes?: string[] },
) {
  const { confirmation, guestName, date, cutoff, candidateLimit } = query;
  const sourceParticipants = new Set(query.participants.map((item) => item.trim().toLowerCase()).filter(Boolean));
  const exactConfirmation = new RegExp(`(?<![A-Za-z0-9-])${(confirmation ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`, 'i');
  const candidates: MailCandidateRow[] = [];
  for (const row of rows) {
    if (row.sourceProvenance?.attention != null || !(row.arrivedAt instanceof Date)) continue;
    const text = `${row.subject ?? ''}\n${row.textBody ?? ''}`;
    const confirmationMatch = Boolean(confirmation && exactConfirmation.test(text));
    const guestNameMatch = Boolean(guestName && text.toLowerCase().includes(guestName.toLowerCase()));
    const guestDatesMatch = Boolean(guestNameMatch && date && [date.arrivalRaw, date.departureRaw]
      .every((term) => text.toLowerCase().includes(term.trim().toLowerCase())));
    const participants = [row.fromAddress, ...(row.toAddresses ?? []), ...(row.ccAddresses ?? [])]
      .map((item) => item.trim().toLowerCase()).filter(Boolean);
    const participantOverlap = participants.some((item) => sourceParticipants.has(item));
    if (confirmationMatch || guestDatesMatch && participantOverlap) {
      const index = guestNameMatch ? text.toLowerCase().indexOf(guestName!.toLowerCase()) : 0;
      candidates.push({ id: row.id, threadId: row.threadId, direction: row.direction, subject: row.subject ?? '',
        excerpt: text.slice(Math.max(0, index - 120), Math.min(text.length, index + 500)), arrivedAt: row.arrivedAt.toISOString(),
        participantOverlap, confirmationMatch, guestDatesMatch, matchEligible: true });
      continue;
    }
    // A name-only lead still requires attachment/native review; it is not a booking match.
    if (guestNameMatch && participantOverlap) candidates.push({ id: row.id, threadId: row.threadId,
      arrivedAt: row.arrivedAt.toISOString(), participantOverlap, confirmationMatch: false, guestDatesMatch: false,
      matchEligible: false, reviewReason: date ? 'date_phrases_not_both_in_subject_or_body' : 'source_dates_unavailable' });
  }
  const matches = candidates.filter((row) => row.matchEligible).slice(0, candidateLimit);
  const reviewCandidates = candidates.filter((row) => !row.matchEligible).slice(0, candidateLimit);
  const truncated = candidates.length > candidateLimit || rows.length > candidateLimit;
  const complete = matches.length > 0 && reviewCandidates.length === 0 && !truncated && storeCoverage?.complete !== false;
  const queryNote = confirmation
    ? 'Narrow query: exact confirmation searched only in cross-thread subject/body before the selected-message cutoff.'
    : 'Narrow query: source-grounded guest-name substring searched only in cross-thread subject/body before the selected-message cutoff.';
  const notes = [queryNote,
    'A verified match requires an exact confirmation or exact guest name plus both source date phrases and participant overlap.',
    'Attachments/PDF text and alternate date formats were not searched; zero matches is not evidence that no related booking exists.',
    ...(reviewCandidates.length ? [`${reviewCandidates.length} guest-name candidate(s) need attachment/native review and are not eligible target matches.`] : []),
    ...(truncated ? [`Search was capped at ${candidateLimit} candidate messages.`] : []),
    ...(storeCoverage?.notes ?? [])];
  return { status: complete ? 'complete' as const : 'partial' as const,
    result: { matches, reviewCandidates, truncated,
      searched: { fieldScope: ['subject', 'textBody'], cutoff: cutoff.toISOString(),
        anchor: confirmation ? 'exact_confirmation' : 'guest_name', attachmentTextSearched: false } },
    coverage: { complete, notes } };
}
