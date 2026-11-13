import { useState } from 'react';
import { Field, Section, SecondaryButton, StepState, paneFieldClass } from '@/components/nava-pane/pane-ui';
import { ContactBlock } from '@/components/nava-pane/blocks/contact-block';
import type { HmsJobTransport } from '@/lib/quote-workflow/amend-find';
import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { guestNameCacheKey, recalledGuestName, rememberGuestName } from '@/lib/quote-workflow/guest-name-cache';
import type { PartyFinder, PartyIndexSearcher, PartySuggestion } from '@/lib/quote-workflow/party-lookup';
import type { QuoteSession, StaffQuoteHeader } from '@/lib/quote-workflow/types';
import { sectionHasStaffEdit, type WorkItemPaneControls } from '@/lib/quote-workflow/use-work-item';
import { PartyPicker, type RatePartyEvidence } from './party-picker';

const stayingGuestListeners = new Set<() => void>();

export function subscribeStayingGuestName(onStoreChange: () => void): () => void {
  stayingGuestListeners.add(onStoreChange);
  return () => {
    stayingGuestListeners.delete(onStoreChange);
  };
}

function notifyStayingGuestName(): void {
  stayingGuestListeners.forEach((listener) => listener());
}

function inferredGuestName(session: QuoteSession, contact?: StoredContact | null): string {
  // The contact is the booker and is not evidence of the staying guest.
  void contact;
  const storedGuestNames = session.groups.flatMap((group) =>
    'guestNames' in group && Array.isArray(group.guestNames)
      ? group.guestNames.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const parsedGuestNames = [
    ...storedGuestNames,
    ...(session.analysis?.luna?.groups ?? []).flatMap((group) => group.guestNames),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
  const uniqueGuestNames = [...new Set(parsedGuestNames)];

  if (uniqueGuestNames.length === 1) return uniqueGuestNames[0] ?? '';
  if (uniqueGuestNames.length > 1) return '';
  return '';
}

export function guestEditorKeyFor(session: QuoteSession, fallback?: string | null): string {
  const guestMessageKey = session.binding?.internetMessageId?.trim() || session.binding?.entryId;
  return (
    (session.binding && guestMessageKey
      ? guestNameCacheKey(session.binding.transportId, session.binding)
      : null) ??
    fallback ??
    session.staffSource?.messageId ??
    'quote-guest'
  );
}

export function stayingGuestName(
  session: QuoteSession,
  contact?: StoredContact | null,
  editorKey?: string,
): string {
  const key = editorKey ?? guestEditorKeyFor(session);
  return recalledGuestName(key) ?? inferredGuestName(session, contact);
}

function GuestNameField({
  session,
  contact,
  guestEditorKey,
}: {
  session: QuoteSession;
  contact?: StoredContact | null;
  guestEditorKey: string;
}) {
  const [editedName, setEditedName] = useState<string | null>(() => recalledGuestName(guestEditorKey));
  const guestName = editedName ?? inferredGuestName(session, contact);
  const needsPrompt = guestName.trim().length === 0;

  return (
    <Field label="Guest" htmlFor="quote-guest-name">
      <input
        id="quote-guest-name"
        aria-describedby={needsPrompt ? 'quote-guest-name-prompt' : undefined}
        className={paneFieldClass}
        value={guestName}
        placeholder={needsPrompt ? 'Guest name?' : undefined}
        onChange={(event) => {
          const name = event.target.value;
          rememberGuestName(guestEditorKey, name);
          notifyStayingGuestName();
          setEditedName(name);
        }}
      />
      {needsPrompt ? (
        <p id="quote-guest-name-prompt" className="text-[11px] text-[#64748b]">
          Enter the staying guest’s name; the contact is not assumed to be the guest.
        </p>
      ) : null}
    </Field>
  );
}

/** Editing a field away from its picked name drops that pick, so the quote never sends a party the text no longer names. */
function pickClearedBy(kind: 'organization' | 'bookingAgency', header: StaffQuoteHeader, text: string): Partial<StaffQuoteHeader> {
  const picked = header.parties?.[kind];
  if (!picked || text === picked.name) return {};
  return { parties: { ...header.parties, [kind]: undefined } };
}

/** Rate plan filters returned options. Contract eligibility still comes only from each HMS result. */
function StaffPartyFields({
  header,
  onPatch,
  onFieldEdit,
  findParty,
  partySuggestions,
  partyIndex,
  partyJobTransport,
  threadId,
  sourceMessageId,
  onPartyLookupPending,
  onRatePartyChange,
  requireExplicitPick,
  propertyCode,
}: {
  header: StaffQuoteHeader;
  onPatch?: (header: Partial<StaffQuoteHeader>) => void;
  onFieldEdit?: (kind: 'organization' | 'bookingAgency') => void;
  /** Find in HMS. Null or absent keeps the organization and bookingAgency as plain text, as before. */
  findParty?: PartyFinder | null;
  /** Suggestions from the email. The top name is preselected when V2 has not bound a party. */
  partySuggestions?: PartySuggestion[];
  /** The HMS list searched while staff type. Null or absent leaves only the live search. */
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
  threadId?: string | null;
  sourceMessageId?: string | null;
  /** Tells the pane whether a field's automatic HMS search still decides its pick, so a rates run waits for it. */
  onPartyLookupPending?: (kind: 'organization' | 'bookingAgency', pending: boolean) => void;
  onRatePartyChange?: (kind: 'organization' | 'bookingAgency', evidence: RatePartyEvidence | null) => void;
  requireExplicitPick?: boolean;
  propertyCode?: string | null;
}) {
  const partyPicker = (kind: 'organization' | 'bookingAgency') => {
    const label = kind === 'bookingAgency' ? 'Agency' : 'Company';
    const value = kind === 'bookingAgency' ? header.bookingAgency : header.organization;
    const id = `quote-${kind}-name`;
    if (!findParty) {
      return (
        <Field label={label} htmlFor={id}>
          <input
            id={id}
            aria-label={label}
            className={paneFieldClass}
            value={value}
            onChange={(event) => {
              const searched = event.target.value;
              onFieldEdit?.(kind);
              onRatePartyChange?.(kind, null);
              onPatch?.({
                ...(kind === 'organization' ? { organization: searched } : { bookingAgency: searched }),
                ...pickClearedBy(kind, header, searched),
              });
            }}
          />
        </Field>
      );
    }
    return (
      <PartyPicker
        autoLookup
        requireExplicitPick={requireExplicitPick}
        propertyCode={propertyCode}
        kind={kind}
        name={value}
        parties={header.parties ?? {}}
        jobReadBackStatusOwner={kind === 'bookingAgency' || Boolean(header.parties?.bookingAgency)}
        find={findParty}
        jobTransport={partyJobTransport}
        threadId={threadId}
        sourceMessageId={sourceMessageId}
        suggestions={partySuggestions}
        indexSearch={partyIndex}
        onLookupPending={(pending) => onPartyLookupPending?.(kind, pending)}
        onPick={(party, evidence) => {
          onFieldEdit?.(kind);
          onRatePartyChange?.(kind, evidence ?? null);
          return onPatch?.({
            parties:
              party.kind === 'organization'
                ? { ...header.parties, organization: party }
                : { ...header.parties, bookingAgency: party },
            ...(party.kind === 'organization' ? { organization: party.name } : { bookingAgency: party.name }),
          });
        }}
        onClear={(cleared) => {
          onFieldEdit?.(cleared);
          onRatePartyChange?.(cleared, null);
          return onPatch?.({
            parties:
              cleared === 'organization'
                ? { ...header.parties, organization: undefined }
                : { ...header.parties, bookingAgency: undefined },
          });
        }}
        onSearchName={(searched, searchKind) => {
          onFieldEdit?.(searchKind);
          onRatePartyChange?.(searchKind, null);
          return onPatch?.({
            ...(searchKind === 'organization' ? { organization: searched } : { bookingAgency: searched }),
            ...pickClearedBy(searchKind, header, searched),
          });
        }}
      />
    );
  };
  return (
    <div className="flex flex-col gap-2.5">
      {partyPicker('bookingAgency')}
      <div aria-hidden="true" className="border-t border-[#e2e8f0]" />
      {partyPicker('organization')}
    </div>
  );
}

export function QuotePeopleStep({
  session,
  partyState,
  header,
  onPatchStaffHeader,
  onFieldEdit,
  findParty,
  partySuggestions,
  partyIndex,
  partyJobTransport,
  contact,
  contactEditorKey,
  onContactEdit,
  onPartyLookupPending,
  onRatePartyChange,
  scrollToStep,
  workItemPane = null,
  propertyCode,
}: {
  session: QuoteSession;
  partyState: 'Done' | 'Pending' | 'Optional' | 'Looking up';
  header: StaffQuoteHeader;
  onPatchStaffHeader?: (header: Partial<StaffQuoteHeader>, options?: { staffEdit?: boolean }) => void;
  onFieldEdit?: (kind: 'organization' | 'bookingAgency') => void;
  findParty?: PartyFinder | null;
  partySuggestions?: PartySuggestion[];
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
  contact?: StoredContact | null;
  contactEditorKey?: string;
  onContactEdit?: (field: ContactField, value: string | null) => void;
  onPartyLookupPending?: (kind: 'organization' | 'bookingAgency', pending: boolean) => void;
  onRatePartyChange?: (kind: 'organization' | 'bookingAgency', evidence: RatePartyEvidence | null) => void;
  scrollToStep: (id: string) => void;
  workItemPane?: WorkItemPaneControls | null;
  propertyCode?: string | null;
}) {
  const guestEditorKey = guestEditorKeyFor(session, contactEditorKey);

  return (
    <Section step={1} title="People" id="quote-party" action={<StepState state={partyState} />}>
      {onContactEdit ? (
        <ContactBlock
          embedded
          key={contactEditorKey}
          contact={contact ?? null}
          onEdit={onContactEdit}
          fieldProvenance={workItemPane?.fieldProvenance ?? null}
          onResetToAi={
            workItemPane?.onResetContact &&
            sectionHasStaffEdit(workItemPane.fieldProvenance, { type: 'contact' })
              ? workItemPane.onResetContact
              : undefined
          }
          resetPending={workItemPane?.resetPending}
        />
      ) : null}
      <GuestNameField
        key={`guest:${guestEditorKey}:${workItemPane?.historyEpoch ?? 0}`}
        session={session}
        contact={contact}
        guestEditorKey={guestEditorKey}
      />
      <StaffPartyFields
        header={header}
        onPatch={(header) => onPatchStaffHeader?.(header, { staffEdit: true })}
        onFieldEdit={onFieldEdit}
        findParty={findParty}
        partySuggestions={partySuggestions}
        partyIndex={partyIndex}
        partyJobTransport={partyJobTransport}
        threadId={session.staffSource?.threadId ?? null}
        sourceMessageId={session.staffSource?.messageId ?? null}
        onPartyLookupPending={onPartyLookupPending}
        onRatePartyChange={onRatePartyChange}
        requireExplicitPick={session.analysis?.luna?.workflow === 'create_booking'}
        propertyCode={propertyCode}
      />
      <SecondaryButton className="w-full" onClick={() => scrollToStep('quote-stay')}>
        Continue to Stay
      </SecondaryButton>
    </Section>
  );
}
