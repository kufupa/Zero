import { READ_TOOL_IDS, type ActiveReadToolId, type ReadToolId } from '../hms/read-tools.js';
import type { TriageHumanAction, TriageOverlay } from './triage.js';
import type { AiWorkflowPrimarySlug } from './categories.js';

type SuggestedToolFolder = AiWorkflowPrimarySlug | 'spam';
type OverlayInput = Partial<Record<TriageOverlay, boolean>> | readonly TriageOverlay[];

type SuggestedToolInput = {
  primaryFolder: SuggestedToolFolder;
  overlays: OverlayInput;
  humanAction: TriageHumanAction;
  /** Kept for callers carrying the full triage payload; planner ignores it. */
  automationState?: string;
  /** Compatibility seam for callers that already carry the spam signal. */
  isSpam?: boolean;
};

/**
 * Suggest read-only evidence tags. This function plans metadata only; it
 * never invokes or activates a tool.
 */
export function suggestReadTools(
  folder: SuggestedToolFolder,
  overlays: OverlayInput,
  humanAction: TriageHumanAction,
  isSpam?: boolean,
): ReadToolId[];
export function suggestReadTools(input: SuggestedToolInput): ReadToolId[];
export function suggestReadTools(
  folderOrInput: SuggestedToolFolder | SuggestedToolInput,
  overlays?: OverlayInput,
  humanAction?: TriageHumanAction,
  isSpam = false,
): ReadToolId[] {
  const folder = typeof folderOrInput === 'string' ? folderOrInput : folderOrInput.primaryFolder;
  const overlayInput =
    typeof folderOrInput === 'string' ? (overlays ?? {}) : folderOrInput.overlays;
  const action =
    typeof folderOrInput === 'string' ? (humanAction ?? 'none') : folderOrInput.humanAction;
  const spam = typeof folderOrInput === 'string' ? isSpam : (folderOrInput.isSpam ?? false);

  if (spam || folder === 'spam') return [];

  const hasOverlay = (overlay: TriageOverlay): boolean => {
    if (Array.isArray(overlayInput)) {
      return (overlayInput as readonly TriageOverlay[]).includes(overlay);
    }
    return (overlayInput as Partial<Record<TriageOverlay, boolean>>)[overlay] === true;
  };
  const hasQuote = hasOverlay('quote');
  const hasBooking = hasOverlay('booking');
  const hasPayment = hasOverlay('payment');
  const readTools: ReadToolId[] = [];
  const add = (tool: ReadToolId): void => {
    if (!readTools.includes(tool)) readTools.push(tool);
  };

  if (folder === 'groups-events') {
    return ['hms_group_block_read', 'hms_quote_stay'];
  }
  if (folder === 'money-billing') {
    return ['hms_read_folio', 'hms_find_reservation'];
  }
  if (folder === 'documents-delivery') {
    return ['hms_list_documents'];
  }
  if (folder === 'manage-stay' || folder === 'confirm-reconcile') {
    return ['hms_find_reservation'];
  }

  // Folder-neutral exceptions retain useful read tags. Ordering is stable:
  // reservation lookup precedes quote when both overlays are present.
  if (hasPayment || action === 'payment_or_finance') {
    add('hms_read_folio');
    add('hms_find_reservation');
  }
  if (action === 'document_or_delivery') {
    add('hms_list_documents');
  }
  if (
    hasBooking ||
    action === 'create_or_reconcile' ||
    action === 'verify_state' ||
    action === 'amend_or_cancel'
  ) {
    add('hms_find_reservation');
  }
  if (hasQuote || action === 'answer_or_quote') {
    add('hms_quote_stay');
  }

  // Keep static registry check close to planner output: tags must remain a
  // subset of the read-only registry even as the registry evolves.
  return readTools.filter((tool): tool is ActiveReadToolId =>
    (READ_TOOL_IDS as readonly string[]).includes(tool),
  );
}
