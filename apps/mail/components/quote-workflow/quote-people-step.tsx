import { useSyncExternalStore } from 'react';
import { Field, Section, SecondaryButton, StepState, paneFieldClass } from '@/components/nava-pane/pane-ui';
import { ContactBlock } from '@/components/nava-pane/blocks/contact-block';
import type { HmsJobTransport } from '@/lib/quote-workflow/amend-find';
import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { recalledGuestName, rememberGuestName, subscribeStayingGuestName } from '@/lib/quote-workflow/guest-name-cache';
import type { PartyFinder, PartyIndexSearcher, PartySuggestion } from '@/lib/quote-workflow/party-lookup';
import { HRDAV_PROPERTY_CODE, type QuoteSession, type StaffQuoteHeader, type StaffQuoteParty } from '@/lib/quote-workflow/types';
import { sectionHasStaffEdit, type WorkItemPaneControls } from '@/lib/quote-workflow/use-work-item';
import { PartyPicker } from './party-picker';

function inferredGuestName(session: QuoteSession, contact?: StoredContact | null, propertyCode?: string | null): string {
  const sourceGroups = session.analysis?.groups ?? [];
  const hasStoredRoster = sourceGroups.some((group) => 'stayGuests' in group && Array.isArray(group.stayGuests));
  if (hasStoredRoster) {
    const source = sourceGroups[0];
    const current = session.groups[0];
    if (sourceGroups.length !== 1 || session.groups.length !== 1 || !source || !current ||
      source.id !== current.id || source.stayId !== current.stayId || current.quantity !== 1) return '';
    const details = source as typeof source & { guestNames?: unknown; stayGuests?: unknown };
    const names = Array.isArray(details.guestNames) ? details.guestNames : [];
    const roster = Array.isArray(details.stayGuests) ? details.stayGuests : [];
    const name = names.length === 1 && typeof names[0] === 'string' ? names[0].trim() : '';
    const listed = roster.length === 1 && typeof roster[0]?.name === 'string' ? roster[0].name.trim() : '';
    return name && name === listed ? name : '';
  }
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
  if (propertyCode === HRDAV_PROPERTY_CODE && session.analysis?.luna?.party?.kind === 'private') {
    return contact?.name?.trim() ?? '';
  }
  return '';
}

export function guestEditorKeyFor(session: QuoteSession, userId: string | null | undefined, propertyCode?: string | null): string | null {
  const binding = session.binding;
  const property = propertyCode === undefined ? session.quotePropertyCode : propertyCode;
  if (!userId?.trim() || !binding?.transportId?.trim() || !binding.entryId?.trim() ||
      (!binding.storeId?.trim() && property !== HRDAV_PROPERTY_CODE)) return null;
  // Message-ID headers are not unique. Outlook supplies store/entry IDs; webmail uses the stored message ID as entryId.
  // Older HRDAV bridges may omit the store; its entry ID remains user- and transport-scoped.
  return JSON.stringify([userId, binding.transportId, binding.storeId?.trim() ? binding.storeId : null, binding.entryId]);
}

export function stayingGuestName(
  session: QuoteSession,
  contact?: StoredContact | null,
  editorKey?: string,
  propertyCode?: string | null,
): string {
  const property = propertyCode === undefined ? session.quotePropertyCode : propertyCode;
  return (editorKey ? recalledGuestName(editorKey) : null) ?? inferredGuestName(session, contact, property);
}

function GuestNameField({
  session,
  guestEditorKey,
  contact,
  propertyCode,
}: {
  session: QuoteSession;
  guestEditorKey: string | null;
  contact?: StoredContact | null;
  propertyCode?: string | null;
}) {
  const editedName = useSyncExternalStore(subscribeStayingGuestName,
    () => guestEditorKey ? recalledGuestName(guestEditorKey) : null, () => null);
  const guestName = guestEditorKey ? (editedName ?? inferredGuestName(session, contact, propertyCode)) : '';
  const needsPrompt = guestName.trim().length === 0;

  return (
    <Field label="Guest" htmlFor="quote-guest-name">
      <input
        id="quote-guest-name"
        aria-describedby={needsPrompt ? 'quote-guest-name-prompt' : undefined}
        className={paneFieldClass}
        value={guestName}
        disabled={!guestEditorKey}
        placeholder={needsPrompt ? 'Guest name?' : undefined}
        onChange={(event) => {
          const name = event.target.value;
          if (guestEditorKey) rememberGuestName(guestEditorKey, name);
        }}
      />
      {needsPrompt ? (
        <p id="quote-guest-name-prompt" className="text-[11px] text-[#64748b]">
          {guestEditorKey ? (propertyCode === HRDAV_PROPERTY_CODE ? 'Enter the staying guest’s name.' :
            'Enter the staying guest’s name; the contact is not assumed to be the guest.') :
            'Select a signed-in mailbox and email to enter the guest’s name.'}
        </p>
      ) : null}
    </Field>
  );
}

/** Editing a field away from its picked name drops that pick, so the quote never sends a party the text no longer names. */
function pickClearedBy(kind: 'company' | 'agency', header: StaffQuoteHeader, text: string): Partial<StaffQuoteHeader> {
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
  sourcePartyReview = [],
  sourcePartyAutoPickDisabled = false,
  onPartyReviewed,
}: {
  header: StaffQuoteHeader;
  onPatch?: (header: Partial<StaffQuoteHeader>) => void;
  onFieldEdit?: (kind: 'company' | 'agency') => void;
  /** Find in HMS. Null or absent keeps the company and agency as plain text, as before. */
  findParty?: PartyFinder | null;
  /** Suggestions from the email. The top name is preselected when V2 has not bound a party. */
  partySuggestions?: PartySuggestion[];
  /** The HMS list searched while staff type. Null or absent leaves only the live search. */
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
  threadId?: string | null;
  sourceMessageId?: string | null;
  /** Tells the pane whether a field's automatic HMS search still decides its pick, so a rates run waits for it. */
  onPartyLookupPending?: (kind: 'company' | 'agency', pending: boolean) => void;
  sourcePartyReview?: StaffQuoteParty['kind'][];
  sourcePartyAutoPickDisabled?: boolean;
  onPartyReviewed?: (kind: StaffQuoteParty['kind']) => void;
}) {
  const partyPicker = (kind: 'company' | 'agency') => {
    const label = kind === 'agency' ? 'Agency' : 'Company';
    const value = kind === 'agency' ? header.agency : header.company;
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
              onPatch?.({
                ...(kind === 'company' ? { company: searched } : { agency: searched }),
                ...pickClearedBy(kind, header, searched),
              });
            }}
          />
        </Field>
      );
    }
    const pick = (party: StaffQuoteParty, explicit: boolean) => {
      onFieldEdit?.(kind);
      onPatch?.({
        parties: { ...header.parties, [party.kind]: party },
        ...(party.kind === 'company' ? { company: party.name } : { agency: party.name }),
      });
      if (explicit) onPartyReviewed?.(party.kind);
    };
    return (
      <PartyPicker
        autoLookup
        allowAutoPick={!sourcePartyAutoPickDisabled}
        kind={kind}
        name={value}
        parties={header.parties ?? {}}
        jobReadBackStatusOwner={kind === 'agency' || Boolean(header.parties?.agency)}
        find={findParty}
        jobTransport={partyJobTransport}
        threadId={threadId}
        sourceMessageId={sourceMessageId}
        suggestions={partySuggestions}
        indexSearch={partyIndex}
        onLookupPending={(pending) => onPartyLookupPending?.(kind, pending)}
        onPick={(party) => pick(party, true)}
        onAutoPick={(party) => pick(party, false)}
        onClear={(cleared) => {
          onFieldEdit?.(cleared);
          onPatch?.({
            parties:
              cleared === 'company'
                ? { ...header.parties, company: undefined }
                : { ...header.parties, agency: undefined },
          });
          onPartyReviewed?.(cleared);
        }}
        onSearchName={(searched, searchKind) => {
          onFieldEdit?.(searchKind);
          return onPatch?.({
            ...(searchKind === 'company' ? { company: searched } : { agency: searched }),
            ...pickClearedBy(searchKind, header, searched),
          });
        }}
      />
    );
  };
  const review = (kind: 'agency' | 'company') => sourcePartyReview.includes(kind) ? (
    <div className="text-[12px] text-[#92400e]">
      Select this {kind} in HMS again, or{' '}
      <button type="button" className="underline" onClick={() => {
        onFieldEdit?.(kind);
        onPatch?.({ [kind]: '', parties: { ...header.parties, [kind]: undefined } });
        onPartyReviewed?.(kind);
      }}>{`use no ${kind}`}</button>.
    </div>
  ) : null;
  return (
    <div className="flex flex-col gap-2.5">
      {partyPicker('agency')}
      {review('agency')}
      <div aria-hidden="true" className="border-t border-[#e2e8f0]" />
      {partyPicker('company')}
      {review('company')}
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
  propertyCode,
  contactEditorKey,
  guestEditorKey = null,
  onContactEdit,
  contactReadOnly = false,
  onPartyLookupPending,
  onPartyReviewed,
  scrollToStep,
  workItemPane = null,
}: {
  session: QuoteSession;
  partyState: 'Done' | 'Pending' | 'Optional' | 'Looking up';
  header: StaffQuoteHeader;
  onPatchStaffHeader?: (header: Partial<StaffQuoteHeader>, options?: { staffEdit?: boolean }) => void;
  onFieldEdit?: (kind: 'company' | 'agency') => void;
  findParty?: PartyFinder | null;
  partySuggestions?: PartySuggestion[];
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
  contact?: StoredContact | null;
  propertyCode?: string | null;
  contactEditorKey?: string;
  guestEditorKey?: string | null;
  onContactEdit?: (field: ContactField, value: string | null) => void;
  contactReadOnly?: boolean;
  onPartyLookupPending?: (kind: 'company' | 'agency', pending: boolean) => void;
  onPartyReviewed?: (kind: StaffQuoteParty['kind']) => void;
  scrollToStep: (id: string) => void;
  workItemPane?: WorkItemPaneControls | null;
}) {
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
          resetPending={contactReadOnly || workItemPane?.resetPending}
        />
      ) : null}
      <GuestNameField
        key={`guest:${guestEditorKey}`}
        session={session}
        guestEditorKey={guestEditorKey}
        contact={contact}
        propertyCode={propertyCode === undefined ? session.quotePropertyCode : propertyCode}
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
        sourcePartyReview={session.sourcePartyReview}
        sourcePartyAutoPickDisabled={session.sourcePartyAutoPickDisabled}
        onPartyReviewed={onPartyReviewed}
      />
      <SecondaryButton className="w-full" onClick={() => scrollToStep('quote-stay')}>
        Continue to Stay
      </SecondaryButton>
    </Section>
  );
}
