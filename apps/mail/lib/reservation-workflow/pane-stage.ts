import type { QuoteOutput } from './quote-output';
import type { ReservationPaneSnapshot, ReservationRequestProjection } from './types';
import { effectiveAt, record, requestPath, text } from './views';

type Kind = 'create' | 'quote' | 'amend' | 'cancel' | 'filing';
type StageInput = {
  snapshot: ReservationPaneSnapshot;
  request: ReservationRequestProjection & { kind: Kind };
  needsCheck: boolean;
  pendingAmendReview: boolean;
  amendCallback: boolean;
  cancelFeeReview: boolean;
  createPriceBlocked: boolean;
  extrasNeedReview: boolean;
  quoteDecline: boolean;
  quoteOutput: { operationId: string; inventoryDecline: boolean; hasCover: boolean; hasFiles: boolean; saveLabel: string } | null;
  savedQuoteOperation: string | null;
  blockedReason: string | null;
};
type Stage = { steps: Array<{ label: string; state: 'done' | 'current' | 'todo' }>;
  button: string; now: string; youGet: string; guestGets: string; showOutcomes: boolean };

const workflows: Record<Kind, { check: string; save: string; deliverable: string; guest: string }> = {
  create: { check: 'Check booking', save: 'Save in Infor', deliverable: 'An Infor confirmation number for each room, shown here.',
    guest: 'Infor sends a CMS confirmation to each room’s CMS Booker Email only if CMS Send Mail is ticked; otherwise nothing.' },
  quote: { check: 'Check quote', save: 'Generate unsent quote', deliverable: 'Requested quote files for download and an unsent reply to save to your Drafts folder.',
    guest: 'Nothing until you send the draft from your mail.' },
  amend: { check: 'Check details', save: 'Save in Infor', deliverable: 'The updated stay and result shown here.',
    guest: 'Infor sends its CMS confirmation to the CMS Booker Email only if CMS Send Mail is ticked; otherwise nothing.' },
  cancel: { check: 'Check details', save: 'Cancel in Infor', deliverable: 'The cancellation result shown here.', guest: 'Nava sends nothing.' },
  filing: { check: 'Check details', save: 'File PDF in Infor', deliverable: 'The PDF in the stay’s Infor Documents.', guest: 'Nava sends nothing.' },
};

export function quoteReplyLabel(output: Pick<QuoteOutput, 'inventoryDecline' | 'failures' | 'artifacts'>): string {
  return output.inventoryDecline ? 'Save unsent decline reply'
    : output.failures.length && !output.artifacts.length ? 'Save unsent reply without quotation files'
    : output.failures.length ? 'Save unsent reply with available files' : 'Save unsent reply';
}

function createPrice(snapshot: ReservationPaneSnapshot, requestId: string, ids: string[]): string | null {
  const prices = ids.map(id => snapshot.preparationViews.find(view => view.requestId === requestId && view.allocationId === id && view.current)?.price);
  if (!prices.length || prices.some(price => !price || typeof price.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(price.currency) || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(String(price.totalRate).trim()))) return null;
  const currency = prices[0]?.currency;
  if (prices.some(price => price?.currency !== currency)) return null;
  const total = prices.reduce<number>((sum, price) => {
    const [whole = '0', fraction = ''] = String(price?.totalRate).trim().replaceAll(',', '').split('.');
    return sum + Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }, 0);
  return Number.isSafeInteger(total) ? `${currency} ${(total / 100).toFixed(2)}` : null;
}

function createRecipients(snapshot: ReservationPaneSnapshot, requestId: string, body: Record<string, unknown>): string | null {
  const root = `${requestPath(requestId)}/body`;
  const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
  const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
  const recipients = allocations.map((room, index) => {
    const section = sections.findIndex(row => row.id === room.dateSectionId);
    const bases = [`${root}/allocations/${index}/overrides`, ...(section >= 0 ? [`${root}/dateSections/${section}/defaults`] : []), `${root}/shared`];
    for (const base of bases) {
      const path = `${base}/cmsRecipient`, override = snapshot.session.draft.fieldOverrides[path];
      if (override?.state === 'inherit') continue;
      if (override && ['none', 'clear', 'unknown'].includes(override.state)) return '';
      const value = effectiveAt(snapshot, path);
      if (value !== undefined && value !== null) return text(value).trim();
    }
    return '';
  });
  if (!recipients.length || recipients.some(value => !value)) return null;
  return [...new Set(recipients)].join(', ');
}

export function derivePaneStage(input: StageInput): Stage {
  const { snapshot, request, needsCheck, pendingAmendReview, amendCallback, cancelFeeReview, quoteOutput } = input;
  const config = workflows[request.kind];
  const body = record(effectiveAt(snapshot, `${requestPath(request.id)}/body`));
  const rooms = Array.isArray(body.allocations) ? body.allocations.map(row => text(record(row).id)) : [];
  const roomCount = `${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'}`;
  const recipient = request.kind === 'create' ? createRecipients(snapshot, request.id, body) : null;
  const requestedOutputs = record(body.outputIntent).artifacts;
  const outputs = Array.isArray(requestedOutputs) ? requestedOutputs : [];
  const files = [outputs.includes('pdf_quote') ? 'PDF' : '', outputs.includes('xlsx_quote') ? 'Excel' : ''].filter(Boolean).join(' and ');
  const results = snapshot.operationResults.filter(row => row.requestId === request.id && row.workflow === request.kind);
  const latestResults = [...results].reverse().filter((row, index, rows) =>
    ['succeeded', 'unknown'].includes(text(row.status)) && !rows.slice(0, index).some(newer =>
      newer.allocationId === row.allocationId && ['succeeded', 'unknown'].includes(text(newer.status))));
  const saved = latestResults.some(row => row.status === 'succeeded');
  const uncertain = latestResults.some(row => row.status === 'unknown');
  const targets = request.kind === 'create' ? rooms : ['amend', 'cancel'].includes(request.kind) && Array.isArray(record(body.targets).include)
    ? (record(body.targets).include as unknown[]).map(row => text(record(row).id)) : [];
  const remaining = rooms.filter(id => !latestResults.some(row => row.allocationId === id && row.status === 'succeeded')).length;
  const allSaved = saved && (request.kind === 'filing' || targets.length > 0 && targets.every(id => latestResults.some(row =>
    row.allocationId === id && row.status === 'succeeded')));

  const button = needsCheck ? config.check : request.kind === 'quote' ? input.quoteDecline ? 'Generate unsent decline' : config.save
    : request.kind === 'amend' && pendingAmendReview ? 'Save reviewed stay in Infor'
    : request.kind === 'amend' && amendCallback ? 'Apply changes & check price' : config.save;
  const quoteSaved = Boolean(quoteOutput?.hasCover && input.savedQuoteOperation === quoteOutput.operationId);
  const generated = request.kind === 'quote' && quoteOutput !== null;
  const hasReplyStep = outputs.length === 0 || outputs.includes('email_quote') || input.quoteDecline || Boolean(quoteOutput?.inventoryDecline);
  const steps = request.kind === 'quote' ? ['Details', 'Check', 'Generate', ...(hasReplyStep && (!generated || quoteOutput?.hasCover) ? ['Draft', 'Send'] : ['Download'])]
    : request.kind === 'amend' && (amendCallback || pendingAmendReview) ? ['Details', 'Check', 'Apply', 'Review price', 'Saved']
    : request.kind === 'cancel' && cancelFeeReview ? ['Details', 'Check', 'Review fee', 'Cancel', 'Done']
    : ['Details', 'Check', request.kind === 'filing' ? 'File' : request.kind === 'cancel' ? 'Cancel' : 'Save',
      request.kind === 'create' ? 'Booked' : request.kind === 'amend' ? 'Saved' : 'Done'];
  // Completed results drive progress: a successful save or generation clears the check digest.
  const current = request.kind === 'quote' ? quoteSaved ? 4 : generated ? 3 : needsCheck ? 1 : 2
    : allSaved ? steps.length - 1 : needsCheck ? 1 : pendingAmendReview ? 3 : 2;
  const price = request.kind === 'create' && !needsCheck ? createPrice(snapshot, request.id, rooms) : null;
  const now = input.blockedReason ? input.blockedReason
    : uncertain ? request.kind === 'quote' ? 'Quote generation could not be confirmed. Check the result above before trying again.'
      : 'The save outcome is uncertain. Check the outcome above before trying again.'
    : allSaved && request.kind === 'create' ? `All rooms were booked. ${needsCheck ? 'Check booking checks the current details.' : 'Review the results above before using Save in Infor.'}`
    : allSaved ? 'Completed. Check the result above.'
    : quoteSaved ? 'Reply saved in your Drafts folder. Send it from your mail when ready.'
    : generated ? quoteOutput?.hasCover ? `${quoteOutput.hasFiles ? 'Files and reply are' : 'The unsent reply is'} ready above. Use ${quoteOutput.saveLabel} above${needsCheck ? `; use ${config.check} below only if you need fresh prices.` : '; the button below generates again.'}`
      : quoteOutput?.hasFiles ? 'Download the available files above.' : 'Quote output could not be completed. Check the results above.'
    : needsCheck ? `${config.check} checks the details${request.kind === 'create' ? ' and price' : ''}. ${request.kind === 'amend' && pendingAmendReview ? 'Details may already have changed in Infor.' : saved ? 'See earlier results above; this check does not save more changes.' : request.kind === 'quote' ? 'No quote or reply is sent by this check.' : 'This check does not save the stay or file in Infor.'}`
    : input.createPriceBlocked ? 'Resolve the customer and Infor prices above before saving.'
    : input.extrasNeedReview ? 'Review the extra charges above before generating the quote.'
    : price ? `Infor priced ${roomCount} · total ${price}. ${saved ? 'See saved rooms above.' : 'Nothing saved yet.'} Next: ${button} creates ${remaining} ${remaining === 1 ? 'booking' : 'bookings'}.`
    : pendingAmendReview ? 'Review the Infor price above, then Save reviewed stay in Infor.'
    : cancelFeeReview ? 'Review the cancellation policy and fee above, then choose Cancel in Infor if you approve.'
    : amendCallback ? 'Apply changes & check price may change Infor details. Review the new price before saving.'
    : request.kind === 'quote' ? `Check complete. Next: ${button} prepares the unsent ${input.quoteDecline ? 'decline reply' : 'quote files and reply'}.`
    : request.kind === 'create' ? `Check complete for ${roomCount}. Next: ${button} creates ${remaining} ${remaining === 1 ? 'booking' : 'bookings'}.`
    : `Check complete. Next: ${button} ${request.kind === 'cancel' ? 'cancels the stay' : request.kind === 'filing' ? 'files the PDF' : 'saves the changes'} in Infor.`;
  return { steps: steps.map((label, index) => ({ label, state: index < current ? 'done' : index === current ? 'current' : 'todo' })),
    button, now, showOutcomes: allSaved || request.kind === 'quote' && (quoteSaved || generated) || !needsCheck && !input.blockedReason,
    youGet: request.kind === 'quote' && (input.quoteDecline || quoteOutput?.inventoryDecline)
      ? `An unsent decline reply ${quoteSaved ? 'saved in' : 'to save to'} your Drafts folder; no quote files.`
      : request.kind === 'quote' && outputs.length ? ([generated ? quoteOutput?.hasFiles ? 'Available quote files for download' : '' : files ? `${files} quote files for download` : '',
        outputs.includes('email_quote') && (!generated || quoteOutput?.hasCover) ? `an unsent reply ${quoteSaved ? 'saved in' : 'to save to'} your Drafts folder` : ''].filter(Boolean).join(' and ') || 'No quote files or reply are available') + '.' : config.deliverable,
    guestGets: request.kind === 'quote' && !hasReplyStep ? 'Nava sends nothing. Share the downloaded files yourself.'
      : request.kind === 'create' && allSaved ? 'Check the saved booking’s CMS settings for confirmation details.'
      : recipient ? `Infor sends a CMS confirmation to ${recipient} only if CMS Send Mail is ticked for that room; otherwise nothing.` : config.guest };

}
