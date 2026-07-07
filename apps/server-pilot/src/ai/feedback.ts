export const FEEDBACK_LABELS = [
  'tone',
  'factual',
  'recipient',
  'subject',
  'missing_info',
  'no_edit',
] as const;

export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];

export interface DraftRevisionSnapshot {
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}

export interface DraftFeedbackResult {
  labels: FeedbackLabel[];
  metrics: Record<string, unknown>;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function addressesChanged(before: string[], after: string[]): boolean {
  const left = [...before].map((v) => v.toLowerCase()).sort();
  const right = [...after].map((v) => v.toLowerCase()).sort();
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function extractDraftFeedbackLabels(input: {
  aiGenerated: DraftRevisionSnapshot;
  sent: DraftRevisionSnapshot;
}): DraftFeedbackResult {
  const labels = new Set<FeedbackLabel>();

  if (
    normalize(input.aiGenerated.textBody) === normalize(input.sent.textBody) &&
    normalize(input.aiGenerated.htmlBody) === normalize(input.sent.htmlBody) &&
    normalize(input.aiGenerated.subject) === normalize(input.sent.subject) &&
    !addressesChanged(input.aiGenerated.toAddresses, input.sent.toAddresses) &&
    !addressesChanged(input.aiGenerated.ccAddresses, input.sent.ccAddresses) &&
    !addressesChanged(input.aiGenerated.bccAddresses, input.sent.bccAddresses)
  ) {
    labels.add('no_edit');
    return { labels: ['no_edit'], metrics: { edited: false } };
  }

  if (normalize(input.aiGenerated.subject) !== normalize(input.sent.subject)) {
    labels.add('subject');
  }
  if (
    addressesChanged(input.aiGenerated.toAddresses, input.sent.toAddresses) ||
    addressesChanged(input.aiGenerated.ccAddresses, input.sent.ccAddresses) ||
    addressesChanged(input.aiGenerated.bccAddresses, input.sent.bccAddresses)
  ) {
    labels.add('recipient');
  }
  if (normalize(input.aiGenerated.textBody) !== normalize(input.sent.textBody)) {
    labels.add('tone');
    if ((input.sent.textBody ?? '').length > (input.aiGenerated.textBody ?? '').length + 40) {
      labels.add('missing_info');
    }
  }
  if (normalize(input.aiGenerated.htmlBody) !== normalize(input.sent.htmlBody)) {
    labels.add('factual');
  }

  return {
    labels: [...labels],
    metrics: {
      edited: true,
      labelCount: labels.size,
    },
  };
}
