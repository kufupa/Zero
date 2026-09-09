import {
  AI_DURABLE_PRIMARY_CATEGORY_SLUGS,
  AI_MANAGED_CATEGORY_SLUGS,
  AI_PRIMARY_CATEGORY_SLUGS,
  AI_WORKFLOW_PRIMARY_SLUGS,
} from './categories.js';
import {
  AUTO_TRIAGE_NEVER_SPAM_DOMAINS,
  AUTO_TRIAGE_NEVER_SPAM_EMAILS,
  isAutoTriageNeverSpam,
  normalizeEmailAddress,
} from './never-spam.js';
import { getLatestInboundFromAddress, getSenderPreference } from '../mail/sender-preference.js';
import { mailCategory, mailLabel, mailThread, mailThreadCategory } from '../db/schema/mail.js';
import { READ_TOOL_IDS } from '../hms/read-tools.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { z } from 'zod';

export const TRIAGE_CATEGORIES = [...AI_PRIMARY_CATEGORY_SLUGS, 'spam'] as const;

/** Versioned lineage labels carried into the mail request projection. */
export const TRIAGE_CLASSIFIER_VERSION = 'triage-v6';
export const TRIAGE_REVIEWER_VERSION = 'none';

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** Canonical Phase 1 workflow priorities. */
export const WORKFLOW_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] as const;
export type WorkflowPriority = (typeof WORKFLOW_PRIORITIES)[number];

/** Thin overlays carried in metrics; Urgent remains a separate boolean. */
export const TRIAGE_OVERLAYS = ['booking', 'quote', 'payment'] as const;
export type TriageOverlay = (typeof TRIAGE_OVERLAYS)[number];

export const TRIAGE_SOURCE_SCOPES = ['external', 'internal_property'] as const;
export type TriageSourceScope = (typeof TRIAGE_SOURCE_SCOPES)[number];

export const TRIAGE_AUTOMATION_STATES = [
  'excluded_internal',
  'unknown',
  'candidate',
  'routine_candidate',
  'exception_candidate',
] as const;
export type TriageAutomationState = (typeof TRIAGE_AUTOMATION_STATES)[number];

export const TRIAGE_HUMAN_ACTIONS = [
  'none',
  'monitor',
  'verify_state',
  'answer_or_quote',
  'create_or_reconcile',
  'amend_or_cancel',
  'payment_or_finance',
  'document_or_delivery',
  'security_or_incident',
  'review_required',
  'other',
] as const;
export type TriageHumanAction = (typeof TRIAGE_HUMAN_ACTIONS)[number];

const triageOverlaysSchema = z
  .object({
    booking: z.boolean().optional(),
    quote: z.boolean().optional(),
    payment: z.boolean().optional(),
  })
  .strict()
  .default({});

/**
 * Canonical workflow payload. Spam is an orthogonal signal: `primaryFolder`
 * always remains one of the eleven workflow folders, never `spam`.
 *
 * `suggestedTools` is deliberately an enum of read-only tool IDs. Tags are
 * metadata only; this schema never authorizes invocation.
 */
export const workflowTriageOutputSchema = z
  .object({
    primaryFolder: z.enum(AI_WORKFLOW_PRIMARY_SLUGS),
    priority: z.enum(WORKFLOW_PRIORITIES),
    urgent: z.boolean().default(false),
    overlays: triageOverlaysSchema,
    isSpam: z.boolean(),
    suggestedTools: z.array(z.enum(READ_TOOL_IDS)).default([]),
    sourceScope: z.enum(TRIAGE_SOURCE_SCOPES).default('external'),
    automationState: z.enum(TRIAGE_AUTOMATION_STATES).default('unknown'),
    humanAction: z.enum(TRIAGE_HUMAN_ACTIONS),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
    policyFlags: z.array(z.string()).default([]),
    abstainReason: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.isSpam && value.suggestedTools.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggestedTools'],
        message: 'spam output cannot carry suggested tool tags',
      });
    }
  });

export type WorkflowTriageOutput = z.infer<typeof workflowTriageOutputSchema>;
export type WorkflowTriageOutputInput = z.input<typeof workflowTriageOutputSchema>;

export type TriageSemanticHints = {
  classifierVersion: typeof TRIAGE_CLASSIFIER_VERSION;
  primaryFolder: WorkflowTriageOutput['primaryFolder'];
  sourceScope: WorkflowTriageOutput['sourceScope'];
  automationState: WorkflowTriageOutput['automationState'];
  humanAction: WorkflowTriageOutput['humanAction'];
  isSpam: boolean;
};

/** Keep triage lineage available to analytics without making folders stateful. */
export function triageOutputSemanticHints(output: WorkflowTriageOutput): TriageSemanticHints {
  return {
    classifierVersion: TRIAGE_CLASSIFIER_VERSION,
    primaryFolder: output.primaryFolder,
    sourceScope: output.sourceScope,
    automationState: output.automationState,
    humanAction: output.humanAction,
    isSpam: output.isSpam,
  };
}

/**
 * Legacy v5 shape retained for the pre-v6 workflow/refine/apply callers.
 * It is intentionally separate from the canonical schema; new writes must
 * use `WorkflowTriageOutput`.
 */
export const legacyTriageOutputSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  urgent: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  policyFlags: z.array(z.string()).default([]),
});

export type LegacyTriageOutput = z.infer<typeof legacyTriageOutputSchema>;

/** Legacy schema export retained for direct v5 consumers. */
export const triageOutputSchema = legacyTriageOutputSchema;

/** @deprecated Use `WorkflowTriageOutput` after the v6 workflow cutover. */
export type TriageOutput = LegacyTriageOutput;

export function validateWorkflowTriageOutput(raw: unknown): WorkflowTriageOutput {
  return workflowTriageOutputSchema.parse(raw);
}

export function validateLegacyTriageOutput(raw: unknown): LegacyTriageOutput {
  return legacyTriageOutputSchema.parse(raw);
}

/**
 * Transitional dispatcher: typed workflow callers retain the canonical v6
 * payload; legacy callers retain the v5 shape until the worker migrates.
 */
export function validateTriageOutput(raw: LegacyTriageOutput): LegacyTriageOutput;
export function validateTriageOutput(raw: WorkflowTriageOutputInput): WorkflowTriageOutput;
/** Existing model/security adapters expose a generic JSON object; keep them v5-compatible. */
export function validateTriageOutput(raw: Record<string, unknown>): LegacyTriageOutput;
/** Mastra's optional legacy result is still consumed by the v5 worker path. */
export function validateTriageOutput(
  raw: Record<string, unknown> | null | undefined,
): LegacyTriageOutput;
export function validateTriageOutput(raw: unknown): WorkflowTriageOutput | LegacyTriageOutput;
export function validateTriageOutput(raw: unknown): WorkflowTriageOutput | LegacyTriageOutput {
  if (typeof raw === 'object' && raw !== null && 'primaryFolder' in raw) {
    return validateWorkflowTriageOutput(raw);
  }
  return validateLegacyTriageOutput(raw);
}

const WORKFLOW_TO_LEGACY_CATEGORY: Record<
  (typeof AI_WORKFLOW_PRIMARY_SLUGS)[number],
  TriageCategory
> = {
  bookings: 'new-bookings',
  'groups-events': 'groups-events',
  'manage-stay': 'ops',
  'confirm-reconcile': 'ops',
  'money-billing': 'ops',
  'documents-delivery': 'ops',
  'exceptions-recovery': 'at-risk',
  'guest-experience': 'new-bookings',
  'internal-partner': 'ops',
  'automated-channel': 'ops',
  'unknown-review': 'ops',
};

/** Map a workflow primary to the old category only for dual-read callers. */
export function toLegacyCategory(
  primaryFolder: (typeof AI_WORKFLOW_PRIMARY_SLUGS)[number],
): TriageCategory {
  return WORKFLOW_TO_LEGACY_CATEGORY[primaryFolder];
}

/** Convert a canonical payload for a legacy metrics/read path. */
export function toLegacyTriageOutput(output: WorkflowTriageOutput): LegacyTriageOutput {
  return {
    category: output.isSpam ? 'spam' : toLegacyCategory(output.primaryFolder),
    urgent: output.urgent,
    confidence: output.confidence,
    rationale: output.rationale,
    policyFlags: output.policyFlags,
  };
}

/**
 * Centurion-scoped property-name subjects that prefer work over spam when
 * the subject is property-leading. Named allowlist — do not silently expand
 * to arbitrary hotel brands without an explicit entry + contract test.
 */
export const PROPERTY_SUBJECT_PREFER_WORK_ALLOWLIST = [
  'centurion lake hotel',
  'centurion hotel',
] as const;

export interface ShadowTriageResult {
  threadId: string;
  transportId: string;
  output: TriageOutput;
  metrics: Record<string, unknown>;
}

type AddressListInput = string | readonly string[] | undefined;

export interface ThreadSignals {
  legacyHotelsOutboundResponse?: boolean;
  reserveCloudStaffOutbound?: boolean;
  reserveCloudStaffOutboundFrom?: string;
  reserveCloudStaffOutboundRecipients?: AddressListInput;
}

/** Alias retained for callers that name causal context as triage signals. */
export type TriageThreadSignals = ThreadSignals;

export interface TriageRefineInput {
  from: string;
  body: string;
  subject?: string;
  asOf?: string;
  threadSignals?: ThreadSignals;
  /** Optional parsed recipients used for the ReserveCloud staff discriminator. */
  to?: AddressListInput;
  cc?: AddressListInput;
  bcc?: AddressListInput;
  recipients?: AddressListInput;
  toAddresses?: AddressListInput;
  ccAddresses?: AddressListInput;
  bccAddresses?: AddressListInput;
  reserveCloudStaffOutboundFrom?: string;
  reserveCloudStaffOutboundRecipients?: AddressListInput;
}

export interface StaffConversationSignals extends ThreadSignals {
  from?: string;
  to?: AddressListInput;
  cc?: AddressListInput;
  bcc?: AddressListInput;
  recipients?: AddressListInput;
  toAddresses?: AddressListInput;
  ccAddresses?: AddressListInput;
  bccAddresses?: AddressListInput;
  threadSignals?: ThreadSignals;
}

const RESERVE_CLOUD_PENNY_EMAIL = 'pmbobo@eu.mail.reservecloud.com';
const LEGACY_PENNY_EMAIL = 'pmbobo@legacyhotels.co.za';
const NOREPLY_RESERVE_CLOUD_EMAIL = 'noreply@noreply.reservecloud.com';

function addressList(value: AddressListInput): string[] {
  if (!value) return [];
  const values: readonly string[] = typeof value === 'string' ? value.split(/[,;]/) : value;
  return values.map((part) => normalizeEmailAddress(part)).filter(Boolean);
}

function isReserveCloudStaffSend(signals: StaffConversationSignals): boolean {
  if (normalizeEmailAddress(signals.from ?? '') !== RESERVE_CLOUD_PENNY_EMAIL) {
    return false;
  }
  const recipients = [
    ...addressList(signals.to),
    ...addressList(signals.cc),
    ...addressList(signals.bcc),
    ...addressList(signals.recipients),
    ...addressList(signals.toAddresses),
    ...addressList(signals.ccAddresses),
    ...addressList(signals.bccAddresses),
  ];
  // SCS wrapper has only Penny's Legacy address. Empty recipients are not
  // enough to prove a staff outbound message.
  return recipients.some((address) => address !== LEGACY_PENNY_EMAIL);
}

/** Shared R22 staff-outbound predicate; wrapper remains false here. */
function staffOutboundResponseNotSpam(signals: StaffConversationSignals): boolean {
  const threadSignals = signals.threadSignals;
  if (threadSignals?.legacyHotelsOutboundResponse || signals.legacyHotelsOutboundResponse) {
    return true;
  }

  const from = normalizeEmailAddress(signals.from ?? '');
  // Noreply SCS is system mail, never staff response.
  if (from === NOREPLY_RESERVE_CLOUD_EMAIL) return false;

  const threadReserveCloudMetadata = threadSignals
    ? isReserveCloudStaffSend({
        from: threadSignals.reserveCloudStaffOutboundFrom,
        recipients: threadSignals.reserveCloudStaffOutboundRecipients,
      })
    : false;
  const directReserveCloudMetadata = isReserveCloudStaffSend({
    from: signals.reserveCloudStaffOutboundFrom,
    recipients: signals.reserveCloudStaffOutboundRecipients,
  });
  if (
    threadReserveCloudMetadata ||
    directReserveCloudMetadata ||
    (signals.reserveCloudStaffOutbound && isReserveCloudStaffSend(signals))
  ) {
    return true;
  }
  return isReserveCloudStaffSend(signals);
}

/**
 * Shared R22/R23 not-spam predicate. Includes never-spam sender identity plus
 * causal staff response; callers needing the outbound discriminator use the
 * internal predicate above so SCS wrappers never become outbound gold.
 */
export function staffConversationNotSpam(signals: StaffConversationSignals): boolean {
  return isAutoTriageNeverSpam(signals.from ?? '') || staffOutboundResponseNotSpam(signals);
}

function isHotelNeverSpamAddress(fromRaw: string): boolean {
  const email = normalizeEmailAddress(fromRaw);
  const atIndex = email.lastIndexOf('@');
  return atIndex !== -1 && AUTO_TRIAGE_NEVER_SPAM_DOMAINS.has(email.slice(atIndex + 1));
}

function isPilotNeverSpamAddress(fromRaw: string): boolean {
  return (
    AUTO_TRIAGE_NEVER_SPAM_EMAILS.has(normalizeEmailAddress(fromRaw)) &&
    !isHotelNeverSpamAddress(fromRaw) &&
    normalizeEmailAddress(fromRaw) !== RESERVE_CLOUD_PENNY_EMAIL
  );
}

function addPolicyFlag(flags: string[], flag: string): string[] {
  return flags.includes(flag) ? flags : [...flags, flag];
}

function workflowExceptionFolder(
  input: TriageRefineInput,
  staff: boolean,
): WorkflowTriageOutput['primaryFolder'] {
  const from = normalizeEmailAddress(input.from);
  const isReserveCloudPenny = from === RESERVE_CLOUD_PENNY_EMAIL;
  const haystack = `${input.subject ?? ''}\n${input.body}`;
  if (
    isReserveCloudPenny &&
    staff &&
    /event\s+(?:proposal|contract)|\b(?:conference|banquet|function|wedding)\b/i.test(haystack)
  ) {
    return 'groups-events';
  }
  if (isHotelNeverSpamAddress(input.from) || isReserveCloudPenny || staff) {
    return 'internal-partner';
  }
  if (isPilotNeverSpamAddress(input.from)) return 'bookings';
  return 'unknown-review';
}

function workflowApplyExceptionFolder(
  requested: WorkflowTriageOutput['primaryFolder'],
  fromRaw: string,
  staff: boolean,
): WorkflowTriageOutput['primaryFolder'] {
  if (isPilotNeverSpamAddress(fromRaw)) return 'bookings';
  const from = normalizeEmailAddress(fromRaw);
  if (from === RESERVE_CLOUD_PENNY_EMAIL && requested === 'groups-events') {
    return requested;
  }
  // Hotel/RC never-spam must not stomp commercial work folders that refine
  // (or the model) already chose — e.g. legacy staff FW of a rooming list.
  const commercialWorkFolders = new Set<WorkflowTriageOutput['primaryFolder']>([
    'groups-events',
    'exceptions-recovery',
    'guest-experience',
    'manage-stay',
    'money-billing',
    'documents-delivery',
    'confirm-reconcile',
  ]);
  if (commercialWorkFolders.has(requested)) {
    return requested;
  }
  if (isHotelNeverSpamAddress(fromRaw) || from === RESERVE_CLOUD_PENNY_EMAIL) {
    return 'internal-partner';
  }
  if (staff && (requested === 'unknown-review' || requested === 'automated-channel')) {
    return 'internal-partner';
  }
  return requested;
}

const INTERNAL_PROPERTY_DOMAINS = new Set([
  'legacyhotels.co.za',
  'mail.legacyhotels.com',
  'branding.legacyhotels.co.za',
]);

function emailDomain(raw: string): string {
  const normalized = normalizeEmailAddress(raw);
  const at = normalized.lastIndexOf('@');
  return at < 0 ? '' : normalized.slice(at + 1);
}

function hasInternalPropertySignal(input: TriageRefineInput): boolean {
  const fromDomain = emailDomain(input.from);
  if (INTERNAL_PROPERTY_DOMAINS.has(fromDomain)) return true;
  const haystack = `${input.subject ?? ''}\n${input.body}`;
  return /(?:^|[\s<(@])(?:legacyhotels\.co\.za|mail\.legacyhotels\.com|branding\.legacyhotels\.co\.za)(?:$|[\s>),;])/i.test(
    haystack,
  );
}

function isInternalDeliveryFailure(input: TriageRefineInput, internalProperty: boolean): boolean {
  if (!internalProperty) return false;
  return /delivery\s+(?:failure|failed|status|notification)|failed\s+to\s+deliver|undeliverable|mailer[- ]daemon|returned\s+mail|failure\s+notice|could\s+not\s+be\s+delivered/i.test(
    `${input.subject ?? ''}\n${input.body}`,
  );
}

function isHospitalityCloudFinanceMail(input: TriageRefineInput): boolean {
  const haystack = `${input.subject ?? ''}\n${input.body}`;
  const fromHospitalityCloud = emailDomain(input.from) === 'hospitality.cloud';
  const domainMentioned = /(?:^|[\s<(])hospitality\.cloud(?:$|[\s>),;])/i.test(haystack);
  const financeSignal =
    /\b(?:payment|paid|invoice|folio|deposit|commission|billing|remittance|proof\s+of\s+payment)\b/i.test(
      haystack,
    );
  return (fromHospitalityCloud || domainMentioned) && financeSignal;
}

function hotelConversationNotSpam(input: TriageRefineInput): boolean {
  const haystack = `${input.subject ?? ''}\n${input.body}`;
  const hasHotelMarker = /\b(?:centurion|bongi|legacy\s*hotels?)\b/i.test(haystack);
  const hasQuotedHotelBlock =
    /(?:^|\n)\s*>[^\n]*(?:centurion|bongi|legacy\s*hotels?)/i.test(haystack) ||
    /(?:^|\n)\s*(?:from|sender):?\s*[^\n]*(?:legacyhotels|centurion|bongi)/i.test(haystack);
  return (
    hasHotelMarker &&
    hasQuotedHotelBlock &&
    /\b(?:payment|invoice|commission|folio|deposit|paid|amount|bank)\b/i.test(haystack)
  );
}

function buildTriageHaystack(input: TriageRefineInput): string {
  return `${(input.subject ?? '').trim()}\n${input.body.trim()}`;
}

function isSeriesReleaseAtRisk(haystack: string): boolean {
  return (
    /(?:release|cancel).{0,40}(?:held|series|allocation)|(held|series)\s+(?:allocation|block)/i.test(
      haystack,
    ) ||
    (/allocation/i.test(haystack) && /series/i.test(haystack)) ||
    /\brelease\s+the\s+bookings?\b/i.test(haystack)
  );
}

function isFortiMailQuarantineDigest(haystack: string): boolean {
  if (/\bquarantine\s+room\b/i.test(haystack)) return false;
  if (/\bfortimail\b/i.test(haystack)) return true;
  return /\bquarantine\s+(?:digest|summary)\b/i.test(haystack);
}

function isGuestRevuDigest(haystack: string): boolean {
  return /\bguestrevu\b/i.test(haystack) && /\b(?:digest|summary)\b/i.test(haystack);
}

function hasRevenueRisk(haystack: string): boolean {
  const hasTimeboxedReplyAction =
    /\b(?:reply|respond|response|action|confirm)(?:\s+(?:is\s+)?(?:required|needed))?\s+(?:within\s+\d+\s*(?:h|hrs?|hours?)|by\s+(?:today|tomorrow|eod|\d{1,2}(?::\d{2})?\s*(?:am|pm)?))\b/i.test(
      haystack,
    );
  const hasRevenueSla = /\b(?:hard\s+)?sla\b/i.test(
    haystack.replace(
      /\b(?:no|not|without)\s+(?:hard\s+)?sla\b|\b(?:hard\s+)?sla\s+(?:does(?:\s+not|n't)\s+apply|(?:is\s+)?not\s+applicable)\b/gi,
      '',
    ),
  );
  return (
    hasTimeboxedReplyAction ||
    hasRevenueSla ||
    /\bunpaid\b/i.test(haystack) ||
    /\b(?:will|may|could)\s+(?:be\s+)?cancel(?:led|ed)?\b/i.test(haystack) ||
    /\bcancel(?:lation|led|ed|s)?\b[\s\S]{0,80}\b(?:if|unless|without|pending)\b/i.test(haystack)
  );
}

/** Shared promo/cold-sales shape for workflow force-spam (Task 2). */
function salesSignal(haystack: string): boolean {
  return /promo|sale|discount|unsubscribe|limited[- ]time|book a demo|whatsapp|newsletter|marketing|click here|viqal|outreach|boost|% off|\$\d|donation|charity|solicitation|is your business|free\s+(?:\w+\s+){0,5}(?:security\s+)?audit|business development|managed (?:network|document)|document management solutions/i.test(
    haystack,
  );
}

/** Guest complaint / service-recovery work → guest-experience. */
function isGuestServiceRecovery(haystack: string): boolean {
  return (
    /\b(?:bed\s*bugs?|service recovery|complaint|infestation)\b/i.test(haystack) ||
    /\b(?:leave a (?:public )?review|report this to (?:booking\.com|expedia|hotels\.com))\b/i.test(
      haystack,
    ) ||
    (/\b(?:discovered|found)\b/i.test(haystack) &&
      /\b(?:bed\s*bugs?|bugs?|pests?)\b/i.test(haystack) &&
      /\b(?:guest|stay|room|property|hotel)\b/i.test(haystack))
  );
}

/**
 * Human-requested cancel/release of a booking or group (not SynXis system
 * cancel notices — those stay on the routine-system path).
 */
function isHumanBookingCancelOrRelease(haystack: string): boolean {
  return (
    /\bcancellation\s+request\b/i.test(haystack) ||
    /\brelease\s+the\s+bookings?\b/i.test(haystack) ||
    /\b(?:kindly|please|could you|can you)\s+(?:\w+\s+){0,6}(?:cancel|release)\b/i.test(haystack) ||
    /\b(?:cancel|release)\s+(?:the\s+)?(?:attached\s+)?(?:booking|reservation|group|rooms?)\b/i.test(
      haystack,
    )
  );
}

/** Group/event commercial work (rooming lists, function runs, group blocks). */
function isGroupsEventsWork(haystack: string): boolean {
  return (
    /\brooming\s+list\b/i.test(haystack) ||
    /\bfunction\s+run\b/i.test(haystack) ||
    /\bgroup\s+res(?:ervation)?\s*#?\s*\d+/i.test(haystack) ||
    /\b(?:group|tour|conference|banquet|function)\s+(?:accommodation|booking|reservation|block|quote|enquiry|inquiry)\b/i.test(
      haystack,
    ) ||
    /\b(?:event\s+(?:proposal|contract)|wedding\s+enquiry)\b/i.test(haystack)
  );
}

/** Folders never-spam senders may still be remapped away from. */
const NEVER_SPAM_WEAK_FOLDERS = new Set<WorkflowTriageOutput['primaryFolder']>([
  'unknown-review',
  'automated-channel',
]);

function isRoutineSystemMail(
  input: TriageRefineInput,
  haystack = buildTriageHaystack(input),
): boolean {
  const subject = (input.subject ?? '').trim();

  const synxisOrChannelConfirm =
    /\b(?:synxis|channel(?:\s+manager)?)\b/i.test(haystack) &&
    /\b(?:confirm(?:ation|ed|s)?|cancel(?:lation|led|ed|s)?|modif(?:ication|ied))\b/i.test(
      haystack,
    );

  const failedToIntegrate = /\bfailed\s+to\s+integrate\b/i.test(haystack);

  const calendarCanceled =
    /^canceled:/i.test(subject) ||
    (/\bcalendar\b/i.test(haystack) && /\bcanceled\b/i.test(haystack));

  const bookingComNotice =
    /\bbooking\.com\b/i.test(haystack) &&
    /\b(?:new\s+reservation|reservation\s+modification|cancellation\s+notice)\b/i.test(haystack);

  const profitroomNotice =
    /\bprofitroom\b/i.test(haystack) &&
    /\b(?:reservation\s+confirmed|booking\s+update)\b/i.test(haystack);

  const tboNotice =
    /\btbo(?:\s+holidays)?\b/i.test(haystack) &&
    /\b(?:booking\s+confirmed|modification\s+alert)\b/i.test(haystack);

  const webbedsNotice =
    /\bwebbeds\b/i.test(haystack) &&
    /\b(?:reservation\s+confirmation|cancellation)\b/i.test(haystack);

  const expediaPartnerCentral =
    /\bexpedia\s+partner\s+central\b/i.test(haystack) && /\bnew\s+booking\b/i.test(haystack);

  const fromDomain = emailDomain(input.from ?? '');
  const otaFromDomainNotice =
    (fromDomain === 'booking.com' ||
      fromDomain.endsWith('.booking.com') ||
      fromDomain === 'profitroom.com' ||
      fromDomain.endsWith('.profitroom.com') ||
      fromDomain === 'tbo.com' ||
      fromDomain.endsWith('.tbo.com') ||
      fromDomain === 'webbeds.com' ||
      fromDomain.endsWith('.webbeds.com') ||
      fromDomain === 'expediapartnercentral.com' ||
      fromDomain.endsWith('.expediapartnercentral.com') ||
      fromDomain === 'synxis.com' ||
      fromDomain.endsWith('.synxis.com')) &&
    /\b(?:reservation|booking|confirmation|cancellation|modification|confirmed|cancelled)\b/i.test(
      haystack,
    );

  return (
    synxisOrChannelConfirm ||
    failedToIntegrate ||
    calendarCanceled ||
    bookingComNotice ||
    profitroomNotice ||
    tboNotice ||
    webbedsNotice ||
    expediaPartnerCentral ||
    otaFromDomainNotice
  );
}

function routineSystemMailPriority(
  priority: WorkflowTriageOutput['priority'],
): WorkflowTriageOutput['priority'] {
  return priority === 'P4' || priority === 'P5' ? priority : 'P4';
}

function isShortPersonalNotPromoSpam(input: TriageRefineInput, haystack: string): boolean {
  const subject = (input.subject ?? '').trim();
  const body = input.body.trim();
  return (
    !salesSignal(haystack) &&
    body.length > 0 &&
    body.length <= 120 &&
    subject.length <= 40 &&
    !/\b(https?:\/\/|www\.)/i.test(haystack) &&
    (/^(hi|hello|hey|test|tester\d*|bonjour|thanks|thank you)\b/i.test(body) ||
      /^(hi|hello|hey|test|tester\d*)\b/i.test(subject))
  );
}

function isEmptyBodyNotPromoSpam(input: TriageRefineInput, haystack: string): boolean {
  const subject = (input.subject ?? '').trim();
  const body = input.body.trim();
  return !salesSignal(haystack) && body.length === 0 && subject.length <= 80;
}

function isProtectedFromWorkflowForceSpam(
  input: TriageRefineInput,
  neverSpamFrom: boolean,
  notSpam: boolean,
): boolean {
  return neverSpamFrom || notSpam || hotelConversationNotSpam(input);
}

function shouldForceWorkflowPromoSpam(input: TriageRefineInput, haystack: string): boolean {
  if (!salesSignal(haystack)) return false;
  if (isEmptyBodyNotPromoSpam(input, haystack)) return false;
  if (isShortPersonalNotPromoSpam(input, haystack)) return false;
  return true;
}

function refineWorkflowTriageOutput(
  input: TriageRefineInput,
  rawOutput: WorkflowTriageOutputInput,
): WorkflowTriageOutput {
  let next = validateWorkflowTriageOutput(rawOutput);
  const neverSpamFrom = isAutoTriageNeverSpam(input.from);
  const signals = {
    ...input,
    threadSignals: input.threadSignals,
  };
  const notSpam = staffConversationNotSpam(signals);
  const staff = staffOutboundResponseNotSpam(signals);

  if (staff) {
    next = {
      ...next,
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:staff-conversation-not-spam'),
    };
  }

  if (next.isSpam && notSpam) {
    const policyFlag = neverSpamFrom
      ? 'refine:never-spam-allowlist'
      : 'refine:staff-conversation-not-spam';
    next = {
      ...next,
      primaryFolder: workflowExceptionFolder(input, staff),
      isSpam: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(next.policyFlags, policyFlag),
      rationale: `${next.rationale} Staff conversation/never-spam exception is not spam.`,
    };
  } else if (next.isSpam && hotelConversationNotSpam(input)) {
    next = {
      ...next,
      primaryFolder: 'money-billing',
      isSpam: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:hotel-conversation-not-spam'),
      rationale: `${next.rationale} Quoted hotel conversation is not spam.`,
    };
  }

  const haystack = buildTriageHaystack(input);

  // Content-intent folders beat blanket never-spam remaps (legacy staff FW of
  // rooming lists must stay groups-events; guest complaints must not stay bookings).
  // Cancel/series also clears erroneous model isSpam (apply early-return guard).
  if (isGuestServiceRecovery(haystack)) {
    next = {
      ...next,
      primaryFolder: 'guest-experience',
      isSpam: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:guest-service-recovery'),
      rationale: `${next.rationale} Guest complaint/service recovery is guest-experience.`,
    };
  } else if (isHumanBookingCancelOrRelease(haystack) || isSeriesReleaseAtRisk(haystack)) {
    next = {
      ...next,
      primaryFolder: 'exceptions-recovery',
      isSpam: false,
      urgent: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(
        next.policyFlags,
        isSeriesReleaseAtRisk(haystack)
          ? 'refine:series-release-at-risk'
          : 'refine:booking-cancel-or-release',
      ),
      rationale: `${next.rationale} Human booking cancel/release is exceptions-recovery.`,
    };
  } else if (isGroupsEventsWork(haystack)) {
    next = {
      ...next,
      primaryFolder: 'groups-events',
      isSpam: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:groups-events-work'),
      rationale: `${next.rationale} Group/event commercial work is groups-events.`,
    };
  } else if (!next.isSpam && neverSpamFrom && NEVER_SPAM_WEAK_FOLDERS.has(next.primaryFolder)) {
    // R22/R23: never-spam hotel/RC senders only leave weak folders. Do not
    // stomp commercial work folders the model (or content detectors) already set.
    const eventFolder = workflowExceptionFolder(input, staff);
    if (eventFolder !== 'unknown-review') next = { ...next, primaryFolder: eventFolder };
  }

  const contentIntentLocked =
    next.policyFlags.includes('refine:guest-service-recovery') ||
    next.policyFlags.includes('refine:booking-cancel-or-release') ||
    next.policyFlags.includes('refine:series-release-at-risk') ||
    next.policyFlags.includes('refine:groups-events-work');

  if (contentIntentLocked) {
    // Keep content-intent folder; skip fortimail/promo/routine remaps.
  } else if (isFortiMailQuarantineDigest(haystack)) {
    next = {
      ...next,
      isSpam: true,
      urgent: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:fortimail-spam'),
      rationale: `${next.rationale} FortiMail quarantine digest is spam.`,
    };
  } else if (
    !isProtectedFromWorkflowForceSpam(input, neverSpamFrom, notSpam) &&
    shouldForceWorkflowPromoSpam(input, haystack) &&
    !isRoutineSystemMail(input, haystack)
  ) {
    next = {
      ...next,
      isSpam: true,
      urgent: false,
      suggestedTools: [],
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:promo-spam'),
      rationale: `${next.rationale} Promo/cold-sales signal is spam.`,
    };
  } else if (
    isRoutineSystemMail(input, haystack) &&
    !isFortiMailQuarantineDigest(haystack) &&
    !hasRevenueRisk(haystack)
  ) {
    next = {
      ...next,
      primaryFolder: 'automated-channel',
      isSpam: false,
      urgent: false,
      suggestedTools: [],
      priority: routineSystemMailPriority(next.priority),
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:system-mail-automated'),
      rationale: `${next.rationale} Routine system mail is automated-channel.`,
    };
  }

  const internalProperty = hasInternalPropertySignal(input);
  if (isInternalDeliveryFailure(input, internalProperty)) {
    next = {
      ...next,
      primaryFolder: 'exceptions-recovery',
      sourceScope: 'internal_property',
      automationState: 'excluded_internal',
      humanAction: 'document_or_delivery',
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:internal-delivery-failure'),
    };
  } else if (internalProperty) {
    const demotedFromAutomated = next.primaryFolder === 'automated-channel';
    let policyFlags = next.policyFlags;
    if (demotedFromAutomated) {
      policyFlags = policyFlags.filter((flag) => flag !== 'refine:system-mail-automated');
    }
    next = {
      ...next,
      primaryFolder:
        next.primaryFolder === 'automated-channel' ? 'internal-partner' : next.primaryFolder,
      sourceScope: 'internal_property',
      automationState: 'excluded_internal',
      policyFlags: addPolicyFlag(policyFlags, 'refine:internal-property-source'),
    };
  }

  if (isHospitalityCloudFinanceMail(input) && !internalProperty) {
    next = {
      ...next,
      primaryFolder: 'money-billing',
      priority: next.priority === 'P4' || next.priority === 'P5' ? 'P3' : next.priority,
      overlays: { ...next.overlays, payment: true },
      isSpam: false,
      automationState: 'candidate',
      humanAction: 'payment_or_finance',
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:hospitality-cloud-finance'),
    };
  }

  return next;
}

export function refineTriageOutput(
  input: TriageRefineInput,
  output: TriageOutput,
  threadSignals?: ThreadSignals,
): TriageOutput;
export function refineTriageOutput(
  input: TriageRefineInput,
  output: WorkflowTriageOutputInput,
  threadSignals?: ThreadSignals,
): WorkflowTriageOutput;
export function refineTriageOutput(
  input: TriageRefineInput,
  output: TriageOutput | WorkflowTriageOutputInput,
  threadSignals?: ThreadSignals,
): TriageOutput | WorkflowTriageOutput {
  const resolvedInput = threadSignals ? { ...input, threadSignals } : input;
  if (typeof output === 'object' && output !== null && 'primaryFolder' in output) {
    return refineWorkflowTriageOutput(resolvedInput, output);
  }
  return refineLegacyTriageOutput(resolvedInput, output as TriageOutput);
}

function refineLegacyTriageOutput(input: TriageRefineInput, output: TriageOutput): TriageOutput {
  const subject = (input.subject ?? '').trim();
  const body = input.body.trim();
  const haystack = `${subject}\n${body}`;
  let next = output;

  const neverSpamFrom = isAutoTriageNeverSpam(input.from);
  const signals = {
    ...input,
    threadSignals: input.threadSignals,
  };
  const notSpam = staffConversationNotSpam(signals);
  const staff = staffOutboundResponseNotSpam(signals);

  if (next.category === 'spam' && notSpam) {
    const category =
      isHotelNeverSpamAddress(input.from) ||
      normalizeEmailAddress(input.from) === RESERVE_CLOUD_PENNY_EMAIL ||
      staff
        ? 'ops'
        : 'new-bookings';
    const policyFlag = neverSpamFrom
      ? 'refine:never-spam-allowlist'
      : 'refine:staff-conversation-not-spam';
    next = {
      ...next,
      category,
      policyFlags: addPolicyFlag(next.policyFlags, policyFlag),
      rationale: `${next.rationale} Staff conversation/never-spam exception is not spam.`,
    };
  }

  if (next.category === 'spam' && staff) {
    next = {
      ...next,
      category: 'ops',
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:staff-conversation-not-spam'),
      rationale: `${next.rationale} Existing hotel staff response means thread is not spam.`,
    };
  }

  if (next.category === 'spam' && hotelConversationNotSpam(input)) {
    next = {
      ...next,
      category: 'ops',
      policyFlags: addPolicyFlag(next.policyFlags, 'refine:hotel-conversation-not-spam'),
      rationale: `${next.rationale} Quoted hotel conversation is not spam.`,
    };
  }

  if (next.category === 'spam') {
    const haystackForSpam = haystack;
    const emptyBodyPreferWork =
      !salesSignal(haystackForSpam) && body.length === 0 && subject.length <= 80;
    if (emptyBodyPreferWork) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:empty-body-not-spam'],
        rationale: `${next.rationale} Empty body with no sales pitch prefers work.`,
      };
    }
    // Require hotel day-visitor / contact-form / walk-in / table-booking signal.
    // Bare restaurant|lunch|dinner alone must NOT force new-bookings (sales spam).
    const dayVisitorHotelSignal =
      /day[- ]?visitor|contact form|walk[- ]?in|table[- ]?book(ing)?/i.test(haystack);
    if (dayVisitorHotelSignal && !/unsubscribe|book a demo|whatsapp sales/i.test(haystack)) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:day-visitor-not-spam'],
        rationale: `${next.rationale} Day-visitor/contact-form/walk-in/table-booking is not sales spam.`,
      };
    }
    const propertySubjectOnly =
      subjectMatchesPropertyPreferWorkAllowlist(subject) &&
      !/unsubscribe|newsletter|book a demo/i.test(haystack);
    if (propertySubjectOnly) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:property-subject-prefer-work'],
        rationale: `${next.rationale} Property-name subject prefers work over spam.`,
      };
    }
    const shortPersonal =
      !salesSignal(haystack) &&
      body.length > 0 &&
      body.length <= 120 &&
      subject.length <= 40 &&
      !/\b(https?:\/\/|www\.)/i.test(haystack) &&
      (/^(hi|hello|hey|test|tester\d*|bonjour|thanks|thank you)\b/i.test(body) ||
        /^(hi|hello|hey|test|tester\d*)\b/i.test(subject));
    if (shortPersonal) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:short-personal-not-spam'],
        rationale: `${next.rationale} Short personal note is not sales spam.`,
      };
    }
  }

  if (next.category === 'ops' && isSeriesReleaseAtRisk(haystack)) {
    next = {
      ...next,
      category: 'at-risk',
      policyFlags: [...next.policyFlags, 'refine:series-release-at-risk'],
      rationale: `${next.rationale} Held series/allocation release is at-risk.`,
    };
  }

  if (
    output.category === 'ops' &&
    next.category === 'ops' &&
    isFortiMailQuarantineDigest(haystack)
  ) {
    next = {
      ...next,
      category: 'spam',
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:fortimail-spam'],
      rationale: `${next.rationale} FortiMail quarantine is spam.`,
    };
  } else if (isGuestRevuDigest(haystack) && !hasRevenueRisk(haystack)) {
    next = {
      ...next,
      category: 'ops',
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:guestrevu-ops'],
      rationale: `${next.rationale} GuestRevu digest is ops.`,
    };
  } else if (
    isRoutineSystemMail(input, haystack) &&
    !isFortiMailQuarantineDigest(haystack) &&
    !hasRevenueRisk(haystack) &&
    !next.policyFlags.includes('refine:series-release-at-risk')
  ) {
    next = {
      ...next,
      category: 'ops',
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:system-mail-ops'],
      rationale: `${next.rationale} Routine system mail is ops.`,
    };
  }

  if (
    next.category === 'at-risk' &&
    !hasRevenueRisk(haystack) &&
    /booking|voucher|reservation|rooms?\b/i.test(haystack) &&
    !/\b(cancel|cancell?ation|amend|release held|unpaid|pay at (check|ci)|within \d+\s*h|synxis|ota)\b/i.test(
      haystack,
    ) &&
    !/\b(2|3|4|5|6|7|8|9|10|\d{2})\s+rooms?\b/i.test(haystack) &&
    !/\b(allocation|series\s+rates|held\s+series|room\s+block)\b/i.test(haystack)
  ) {
    next = {
      ...next,
      category: 'new-bookings',
      policyFlags: [...next.policyFlags, 'refine:one-room-ack-not-at-risk'],
      rationale: `${next.rationale} One-room booking ack without cancel/SLA is new-bookings.`,
    };
  }

  if (next.category === 'ops' && next.urgent) {
    const opsHandover = /handover|room readiness|vip arrivals/i.test(haystack);
    if (opsHandover) {
      next = {
        ...next,
        urgent: false,
        policyFlags: [...next.policyFlags, 'refine:ops-handover-not-urgent'],
        rationale: `${next.rationale} Ops handover is not same-day urgent.`,
      };
    }
  }

  if (
    next.category === 'ops' &&
    next.urgent &&
    /\burgent\b/i.test(subject) &&
    /invoice|commission/i.test(haystack) &&
    !/(today|tonight|same[- ]day|arrives? tomorrow|check[- ]?in tomorrow|within \d+\s*h)/i.test(
      haystack,
    )
  ) {
    next = {
      ...next,
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:subject-urgent-not-sla'],
      rationale: `${next.rationale} Subject URGENT on ops invoice/commission is not SLA.`,
    };
  }

  if (
    next.category === 'ops' &&
    next.urgent &&
    /invoice|tax invoice/i.test(haystack) &&
    !/(today|tonight|same[- ]day|arrives? tomorrow|check[- ]?in tomorrow|within \d+\s*h)/i.test(
      haystack,
    ) &&
    !hasSameDayCheckInSignal(haystack, input.asOf)
  ) {
    next = {
      ...next,
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:ops-invoice-not-urgent'],
      rationale: `${next.rationale} Ops invoice without same-day/hard SLA is not urgent.`,
    };
  }

  if (
    !next.urgent &&
    (next.category === 'new-bookings' ||
      next.category === 'groups-events' ||
      next.category === 'at-risk') &&
    hasSameDayCheckInSignal(haystack, input.asOf)
  ) {
    next = {
      ...next,
      urgent: true,
      policyFlags: [...next.policyFlags, 'refine:same-day-ci-urgent'],
      rationale: `${next.rationale} Same-day check-in/arrival relative to asOf is urgent.`,
    };
  }

  if (
    next.urgent &&
    next.category === 'new-bookings' &&
    /\burgent\b/i.test(subject) &&
    !hasSameDayCheckInSignal(haystack, input.asOf) &&
    !/(today|tonight|same[- ]day|within \d+\s*h|arrives? tomorrow)/i.test(haystack)
  ) {
    next = {
      ...next,
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:subject-urgent-no-sla-signal'],
      rationale: `${next.rationale} Subject URGENT without same-day/hard SLA is not urgent.`,
    };
  }

  return next;
}

function subjectMatchesPropertyPreferWorkAllowlist(subject: string): boolean {
  const escaped = PROPERTY_SUBJECT_PREFER_WORK_ALLOWLIST.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');
  return new RegExp(`^(?:${escaped})\\b`, 'i').test(subject);
}

function hasSameDayCheckInSignal(haystack: string, asOf?: string): boolean {
  if (
    /check\s*[- ]?in\s*:?\s*today|arrives?\s+today|arrival\s+today|ci\s+today|same[- ]day\s*(ci|check)/i.test(
      haystack,
    )
  ) {
    return true;
  }
  if (!asOf) return false;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDate();
  const monShort = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const monLong = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const year = d.getUTCFullYear();
  const dateAlts = [
    `${day}\\s*${monShort}`,
    `${day}\\s*${monLong}`,
    `${day}[-/]0?${d.getUTCMonth() + 1}[-/]${year}`,
    `${day}[-/]0?${d.getUTCMonth() + 1}\\b`,
    `${String(day).padStart(2, '0')}[-/]${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
  ];
  for (const alt of dateAlts) {
    const re = new RegExp(
      `(check\\s*[- ]?in|arrival|ci)\\D{0,12}${alt}|${alt}\\D{0,12}(check\\s*[- ]?in|arrival)|\\b${day}\\s*[-–]\\s*\\d{1,2}\\s*${monShort}`,
      'i',
    );
    if (re.test(haystack)) return true;
  }
  return false;
}

export function applyShadowTriageResult(input: ShadowTriageResult): ShadowTriageResult {
  validateTriageOutput(input.output);
  return {
    ...input,
    metrics: {
      ...input.metrics,
      shadow: true,
      category: input.output.category,
      urgent: input.output.urgent,
      confidence: input.output.confidence,
    },
  };
}

export interface ApplyDurableTriageInput {
  db: DB;
  transportId: string;
  threadId: string;
  output: TriageOutput | WorkflowTriageOutputInput;
  writeGateEnabled: boolean;
  /** Enables workflow primary joins; legacy dual-read remains available when off. */
  workflowTriageEnabled?: boolean;
  /** Retag runs preserve prior state until worker success, then force full apply. */
  forceUnsettle?: boolean;
  threadSignals?: ThreadSignals;
  from?: string;
  to?: AddressListInput;
  cc?: AddressListInput;
  bcc?: AddressListInput;
  recipients?: AddressListInput;
  toAddresses?: AddressListInput;
  ccAddresses?: AddressListInput;
  bccAddresses?: AddressListInput;
}

export type ApplyMode = 'full' | 'urgency_only' | 'skipped';

/** FortiMail digest apply attaches this user label (ensure-by-name). Not ingest soft-quarantine. */
export const FORTIMAIL_QUARANTINE_LABEL_NAME = 'Quarantine';

async function findFortimailQuarantineLabelId(db: DB, transportId: string): Promise<string | null> {
  const rows = await db
    .select({ id: mailLabel.id })
    .from(mailLabel)
    .where(
      and(
        eq(mailLabel.transportId, transportId),
        eq(mailLabel.name, FORTIMAIL_QUARANTINE_LABEL_NAME),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

async function ensureFortimailQuarantineLabel(db: DB, transportId: string): Promise<string> {
  const existing = await findFortimailQuarantineLabelId(db, transportId);
  if (existing) return existing;

  const id = `label-quarantine-${transportId}`;
  await db
    .insert(mailLabel)
    .values({ id, transportId, name: FORTIMAIL_QUARANTINE_LABEL_NAME, color: null })
    .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });

  const resolved = await findFortimailQuarantineLabelId(db, transportId);
  if (!resolved) {
    throw new Error(`Failed to ensure Quarantine label for transport ${transportId}`);
  }
  return resolved;
}

function stripLabelId(labelIds: string[], labelId: string): string[] {
  return labelIds.filter((id) => id !== labelId);
}

function shouldAttachFortimailQuarantineLabel(
  effectiveIsSpam: boolean,
  workflowOutput: WorkflowTriageOutput | undefined,
  legacyOutput: LegacyTriageOutput,
): boolean {
  if (!effectiveIsSpam) return false;
  const policyFlags = workflowOutput?.policyFlags ?? legacyOutput.policyFlags;
  if (!policyFlags.includes('refine:fortimail-spam')) return false;
  if (workflowOutput) return workflowOutput.isSpam;
  return legacyOutput.category === 'spam';
}

export async function applyDurableTriageResult(
  input: ApplyDurableTriageInput,
): Promise<{ applyMode: ApplyMode }> {
  if (!input.writeGateEnabled) return { applyMode: 'skipped' };

  const { db, transportId, threadId } = input;
  const workflowOutput =
    'primaryFolder' in input.output ? validateWorkflowTriageOutput(input.output) : undefined;
  const workflowTriageEnabled = input.workflowTriageEnabled ?? true;
  const legacyOutput = workflowOutput
    ? toLegacyTriageOutput(workflowOutput)
    : validateLegacyTriageOutput(input.output);
  const requestedIsSpam = workflowOutput ? workflowOutput.isSpam : legacyOutput.category === 'spam';

  const [thread] = await db
    .select({ spamAt: mailThread.spamAt, spamUserLockedAt: mailThread.spamUserLockedAt })
    .from(mailThread)
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)))
    .limit(1);

  const primaryRows = await db
    .select({ categoryId: mailCategory.id, slug: mailCategory.slug })
    .from(mailThreadCategory)
    .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
    .where(
      and(
        eq(mailThreadCategory.threadId, threadId),
        eq(mailThreadCategory.transportId, transportId),
        inArray(mailCategory.slug, [...AI_DURABLE_PRIMARY_CATEGORY_SLUGS]),
      ),
    );

  // Manual mark-spam/inbox is represented by this lock and always wins over
  // automated R22/R23 exceptions.
  if (thread?.spamUserLockedAt != null) {
    const allCats = await db
      .select({ id: mailCategory.id, slug: mailCategory.slug })
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)));
    const urgentId = allCats.find((c) => c.slug === 'urgent')?.id;
    if (!urgentId) throw new Error(`AI category missing for transport ${transportId}: urgent`);

    await db
      .delete(mailThreadCategory)
      .where(
        and(
          eq(mailThreadCategory.threadId, threadId),
          eq(mailThreadCategory.transportId, transportId),
          eq(mailThreadCategory.categoryId, urgentId),
        ),
      );
    if (workflowOutput?.urgent ?? legacyOutput.urgent) {
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: urgentId,
        transportId,
      });
    }
    return { applyMode: 'urgency_only' };
  }

  // Resolve sender preference before the settled check. `block` is explicit
  // user intent and wins over auto-never-spam; `allow` is an auto-not-spam
  // override but still follows the same clear+join path below.
  const latestFrom = input.from ?? (await getLatestInboundFromAddress(db, transportId, threadId));
  const preference = latestFrom
    ? await getSenderPreference({ db, transportId, emailRaw: latestFrom })
    : null;
  const signals = {
    ...input,
    from: latestFrom ?? input.from,
    threadSignals: input.threadSignals,
  };
  const notSpam = staffConversationNotSpam(signals);
  const staff = staffOutboundResponseNotSpam(signals);
  const blocked = preference === 'block';
  const exceptionNotSpam = !blocked && (preference === 'allow' || notSpam);
  const workflowUnsettledNotSpam =
    !blocked &&
    Boolean(
      workflowOutput &&
        !workflowOutput.isSpam &&
        thread?.spamAt != null &&
        primaryRows.length === 0,
    );
  const rewriteForNotSpam = exceptionNotSpam || workflowUnsettledNotSpam;
  const effectiveIsSpam = blocked || (requestedIsSpam && !exceptionNotSpam);

  const settled =
    !input.forceUnsettle &&
    (primaryRows.length > 0 || (thread?.spamAt != null && !rewriteForNotSpam));

  if (settled) {
    // KTD2: settled threads never flip primary/spamAt — urgency overlay only.
    const allCats = await db
      .select({ id: mailCategory.id, slug: mailCategory.slug })
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)));
    const urgentId = allCats.find((c) => c.slug === 'urgent')?.id;
    if (!urgentId) throw new Error(`AI category missing for transport ${transportId}: urgent`);

    await db
      .delete(mailThreadCategory)
      .where(
        and(
          eq(mailThreadCategory.threadId, threadId),
          eq(mailThreadCategory.transportId, transportId),
          eq(mailThreadCategory.categoryId, urgentId),
        ),
      );
    if (workflowOutput?.urgent ?? legacyOutput.urgent) {
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: urgentId,
        transportId,
      });
    }
    return { applyMode: 'urgency_only' };
  }

  // Resolve every category ID before any destructive join/spam mutation. A
  // missing target category must leave the existing durable state untouched.
  const categoryRows = await db
    .select({ id: mailCategory.id, slug: mailCategory.slug })
    .from(mailCategory)
    .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)));

  const bySlug = new Map(categoryRows.map((row) => [row.slug, row.id]));
  let categoryIds: string[] = [];
  // Spam is durable on mail_thread.spam_at, never via a primary category join.
  // Do not require a legacy `spam` category when workflow output is spam and
  // the workflow/nav capability is disabled.
  if (!effectiveIsSpam) {
    const targetPrimary =
      workflowOutput && workflowTriageEnabled
        ? exceptionNotSpam
          ? workflowApplyExceptionFolder(workflowOutput.primaryFolder, latestFrom ?? '', staff)
          : workflowOutput.primaryFolder
        : exceptionNotSpam && legacyOutput.category === 'spam'
          ? isPilotNeverSpamAddress(latestFrom ?? '')
            ? 'new-bookings'
            : 'ops'
          : legacyOutput.category;
    if (!bySlug.get(targetPrimary)) {
      throw new Error(`AI category missing for transport ${transportId}: ${targetPrimary}`);
    }

    const targetSlugs = [
      targetPrimary,
      ...((workflowOutput?.urgent ?? legacyOutput.urgent) ? (['urgent'] as const) : []),
    ];
    categoryIds = targetSlugs
      .map((slug) => {
        const id = bySlug.get(slug);
        if (!id && slug !== targetPrimary) return undefined;
        if (!id) {
          throw new Error(`AI category missing for transport ${transportId}: ${slug}`);
        }
        return id;
      })
      .filter((id): id is string => Boolean(id));
  }

  const aiManagedRows = await db
    .select({ categoryId: mailCategory.id })
    .from(mailCategory)
    .where(
      and(
        eq(mailCategory.transportId, transportId),
        inArray(mailCategory.slug, [...AI_MANAGED_CATEGORY_SLUGS, ...AI_WORKFLOW_PRIMARY_SLUGS]),
      ),
    );

  const aiManagedIds = aiManagedRows.map((row) => row.categoryId);
  if (aiManagedIds.length > 0) {
    await db
      .delete(mailThreadCategory)
      .where(
        and(
          eq(mailThreadCategory.threadId, threadId),
          eq(mailThreadCategory.transportId, transportId),
          inArray(mailThreadCategory.categoryId, aiManagedIds),
        ),
      );
  }

  if (effectiveIsSpam) {
    const attachFortimail = shouldAttachFortimailQuarantineLabel(
      effectiveIsSpam,
      workflowOutput,
      legacyOutput,
    );

    // Prefer nested txn when `db` is a root client; test helpers pass an
    // already-open tx which has no `.transaction` — run inline then.
    const writeSpamAndQuarantine = async (tx: typeof db) => {
      const quarantineLabelId = attachFortimail
        ? await ensureFortimailQuarantineLabel(tx, transportId)
        : await findFortimailQuarantineLabelId(tx, transportId);

      const [threadRow] = await tx
        .select({ labelIds: mailThread.labelIds })
        .from(mailThread)
        .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)))
        .limit(1);
      const currentLabelIds = threadRow?.labelIds ?? [];
      const nextLabelIds =
        attachFortimail && quarantineLabelId
          ? [...new Set([...currentLabelIds, quarantineLabelId])]
          : quarantineLabelId
            ? stripLabelId(currentLabelIds, quarantineLabelId)
            : currentLabelIds;

      await tx
        .update(mailThread)
        .set({
          spamAt: new Date(),
          labelIds: nextLabelIds,
          updatedAt: new Date(),
        })
        .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));
    };
    if (typeof db.transaction === 'function') {
      await db.transaction(async (tx) => {
        await writeSpamAndQuarantine(tx as unknown as typeof db);
      });
    } else {
      await writeSpamAndQuarantine(db);
    }
    return { applyMode: 'full' };
  }

  const quarantineLabelId = await findFortimailQuarantineLabelId(db, transportId);
  const [threadLabelRow] = await db
    .select({ labelIds: mailThread.labelIds })
    .from(mailThread)
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)))
    .limit(1);
  const clearedLabelIds =
    quarantineLabelId && threadLabelRow
      ? stripLabelId(threadLabelRow.labelIds ?? [], quarantineLabelId)
      : undefined;

  await db
    .update(mailThread)
    .set({
      spamAt: null,
      ...(clearedLabelIds !== undefined ? { labelIds: clearedLabelIds } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));

  if (categoryIds.length > 0) {
    await db.insert(mailThreadCategory).values(
      categoryIds.map((categoryId) => ({
        threadId,
        categoryId,
        transportId,
      })),
    );
  }

  return { applyMode: 'full' };
}
