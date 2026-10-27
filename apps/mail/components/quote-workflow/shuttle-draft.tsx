import { useRef, useState, type FormEvent } from 'react';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { createOperationId, MailLocationSchema } from '@/lib/workstation/bridge-protocol';
import {
  Field,
  Notice,
  PrimaryButton,
  SecondaryButton,
  Section,
  paneFieldClass,
  paneTextareaClass,
} from '../nava-pane/pane-ui';
import {
  buildShuttleDraftTemplate,
  readShuttleProviderConfig,
  type ShuttleProviderConfig,
  type ShuttleTransferDetails,
} from '../../../server-pilot/src/ai/shuttle-draft.js';

type ShuttleDraftBridge = Pick<PaneBridge, 'sendCommand' | 'supportsAction'>;
type OutlookCreateDraftPayload = {
  operationId: string;
  storeId: string;
  to: string;
  subject: string;
  htmlBody: string;
  openInComposer: boolean;
};

const EMPTY_DETAILS: ShuttleTransferDetails = {
  serviceDate: '',
  pickupLocation: '',
  dropoffLocation: '',
  pickupTime: '',
  flight: '',
  passengers: '',
  bookingReference: '',
};

const FIELDS: ReadonlyArray<{ key: keyof ShuttleTransferDetails; label: string; type?: string }> = [
  { key: 'serviceDate', label: 'Service date', type: 'date' },
  { key: 'pickupLocation', label: 'Pickup location' },
  { key: 'dropoffLocation', label: 'Drop-off location' },
  { key: 'pickupTime', label: 'Pickup time', type: 'time' },
  { key: 'flight', label: 'Flight' },
  { key: 'passengers', label: 'Passengers' },
  { key: 'bookingReference', label: 'Booking reference' },
];

export function ShuttleDraft({
  config,
  bridge,
  storeId,
}: {
  config: ShuttleProviderConfig | null;
  bridge?: ShuttleDraftBridge | null;
  storeId?: string | null;
}) {
  const provider = readShuttleProviderConfig(config);

  if (!provider) {
    return (
      <Section title="Draft shuttle request">
        <Notice tone="warn" role="status">Shuttle requests are not set up for this property.</Notice>
      </Section>
    );
  }

  return <ShuttleDraftForm bridge={bridge} provider={provider} storeId={storeId} />;
}

function ShuttleDraftForm({
  bridge,
  provider,
  storeId,
}: {
  bridge?: ShuttleDraftBridge | null;
  provider: ShuttleProviderConfig;
  storeId?: string | null;
}) {
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const saving = useRef(false);
  const operationId = useRef<string | null>(null);
  const hasDetails = Object.values(details).some((value) => value.trim());
  const mailboxStoreId = storeId?.trim() ?? '';
  const canCreateDraft = Boolean(mailboxStoreId && bridge?.supportsAction('CREATE_DRAFT'));
  const needsDraftCheck = status?.tone === 'error' && operationId.current !== null;
  const draft = buildShuttleDraftTemplate(provider, details);

  const update = (key: keyof ShuttleTransferDetails, value: string) => {
    if (needsDraftCheck) return;
    operationId.current = null;
    setDetails((current) => ({ ...current, [key]: value }));
    setStatus(null);
  };

  const allowFreshAttempt = () => {
    operationId.current = null;
    setStatus(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasDetails || !canCreateDraft || !bridge || saving.current || status?.tone === 'success') return;
    saving.current = true;
    setPending(true);
    setStatus(null);
    try {
      const saveOperationId = operationId.current ?? createOperationId();
      operationId.current = saveOperationId;
      const result = await bridge.sendCommand<OutlookCreateDraftPayload, unknown>('CREATE_DRAFT', {
        operationId: saveOperationId,
        storeId: mailboxStoreId,
        to: provider.to.join('; '),
        subject: draft.subject,
        htmlBody: draft.html,
        openInComposer: false,
      });
      const location = MailLocationSchema.safeParse(result);
      if (!location.success || location.data.storeId !== mailboxStoreId || location.data.locationUnverified ||
        location.data.draftPlacementWarning || location.data.folderPlacementWarning) {
        setStatus({
          tone: 'error',
          message: 'Outlook may have saved the draft, but its folder could not be confirmed. Check Outlook Drafts before retrying.',
        });
        return;
      }
      setStatus({
        tone: 'success',
        message: location.data.displayed
          ? 'Outlook opened the unsent draft. Review it, then send it yourself.'
          : 'Saved as an unsent Outlook draft. Review and send it from Drafts.',
      });
    } catch {
      setStatus({
        tone: 'error',
        message: 'Outlook is busy or unavailable. The draft may have been saved; check Outlook Drafts before retrying.',
      });
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <Section title="Draft shuttle request">
      <p className="text-[13px] text-[#64748b]">
        For {provider.provider}. Saving creates an unsent Outlook draft only; review it before sending.
      </p>
      {!canCreateDraft ? (
        <Notice tone="warn" role="status">
          {mailboxStoreId
            ? 'Outlook draft creation is not available in this view.'
            : 'The Outlook mailbox is not set up for this request.'}
        </Notice>
      ) : null}
      <form className="flex flex-col gap-3" onSubmit={save}>
        {FIELDS.map(({ key, label, type }) => (
          <Field key={key} label={label} htmlFor={`shuttle-${key}`}>
            <input
              id={`shuttle-${key}`}
              type={type ?? 'text'}
              className={paneFieldClass}
              maxLength={240}
              disabled={pending || needsDraftCheck}
              value={details[key]}
              onChange={(event) => update(key, event.target.value)}
            />
          </Field>
        ))}
        <Field
          label="Reservation note for HMS"
          htmlFor="shuttle-reservation-note"
          hint="Copy this into the reservation note; it is not written to HMS."
        >
          <textarea
            id="shuttle-reservation-note"
            className={paneTextareaClass}
            readOnly
            value={draft.noteText}
          />
        </Field>
        {status ? (
          <Notice
            tone={status.tone === 'success' ? 'success' : 'error'}
            role={status.tone === 'success' ? 'status' : 'alert'}
          >
            {status.message}
          </Notice>
        ) : null}
        {needsDraftCheck ? (
          <SecondaryButton type="button" onClick={allowFreshAttempt}>
            I checked Outlook Drafts; no draft found — retry with a new ID
          </SecondaryButton>
        ) : null}
        <PrimaryButton
          type="submit"
          disabled={!hasDetails || !canCreateDraft || pending || status?.tone === 'success'}
          disabledReason={
            !hasDetails
              ? 'Add at least one transfer detail.'
              : !canCreateDraft
                ? 'Outlook draft creation is not available here.'
                : status?.tone === 'success'
                  ? 'Edit a detail to save another draft.'
                  : null
          }
          loading={pending}
          loadingText="Saving unsent draft…"
        >
          Save unsent draft
        </PrimaryButton>
      </form>
    </Section>
  );
}
