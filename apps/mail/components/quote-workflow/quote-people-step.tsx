import { useState } from 'react';
import { Field, Section, SecondaryButton, StepState, paneFieldClass } from '@/components/nava-pane/pane-ui';
import { ContactBlock } from '@/components/nava-pane/blocks/contact-block';
import type { HmsJobTransport } from '@/lib/quote-workflow/amend-find';
import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PartyFinder, PartyIndexSearcher, PartySuggestion } from '@/lib/quote-workflow/party-lookup';
import type { QuoteSession, StaffQuoteHeader } from '@/lib/quote-workflow/types';
import { PartyPicker } from './party-picker';

function inferredGuestName(session: QuoteSession, contact?: StoredContact | null): string {
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
  if (session.analysis?.luna?.party?.kind === 'private') return contact?.name?.trim() ?? '';
  return '';
}

function GuestNameField({
  session,
  contact,
}: {
  session: QuoteSession;
  contact?: StoredContact | null;
}) {
  const [editedName, setEditedName] = useState<string | null>(null);
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
        onChange={(event) => setEditedName(event.target.value)}
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
    return (
      <PartyPicker
        autoLookup
        kind={kind}
        name={value}
        parties={header.parties ?? {}}
        find={findParty}
        jobTransport={partyJobTransport}
        threadId={threadId}
        sourceMessageId={sourceMessageId}
        suggestions={partySuggestions}
        indexSearch={partyIndex}
        onLookupPending={(pending) => onPartyLookupPending?.(kind, pending)}
        onPick={(party) => {
          onFieldEdit?.(kind);
          return onPatch?.({
            parties:
              party.kind === 'company'
                ? { ...header.parties, company: party }
                : { ...header.parties, agency: party },
            ...(party.kind === 'company' ? { company: party.name } : { agency: party.name }),
          });
        }}
        onClear={(cleared) => {
          onFieldEdit?.(cleared);
          return onPatch?.({
            parties:
              cleared === 'company'
                ? { ...header.parties, company: undefined }
                : { ...header.parties, agency: undefined },
          });
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
  return (
    <div className="flex flex-col gap-2.5">
      {partyPicker('agency')}
      <div aria-hidden="true" className="border-t border-[#e2e8f0]" />
      {partyPicker('company')}
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
  scrollToStep,
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
  contactEditorKey?: string;
  onContactEdit?: (field: ContactField, value: string | null) => void;
  onPartyLookupPending?: (kind: 'company' | 'agency', pending: boolean) => void;
  scrollToStep: (id: string) => void;
}) {
  const guestEditorKey =
    contactEditorKey ??
    session.binding?.entryId ??
    session.staffSource?.messageId ??
    'quote-guest';

  return (
    <Section step={1} title="People" id="quote-party" action={<StepState state={partyState} />}>
      {onContactEdit ? (
        <ContactBlock embedded key={contactEditorKey} contact={contact ?? null} onEdit={onContactEdit} />
      ) : null}
      <GuestNameField key={guestEditorKey} session={session} contact={contact} />
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
      />
      <SecondaryButton className="w-full" onClick={() => scrollToStep('quote-authority')}>
        Continue to HMS notes
      </SecondaryButton>
    </Section>
  );
}
