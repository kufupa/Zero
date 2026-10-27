import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpcClient, useTRPC } from '../../providers/query-provider';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import {
  Field,
  Notice,
  PrimaryButton,
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
  transportId,
}: {
  config: ShuttleProviderConfig | null;
  transportId: string;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const saving = useRef(false);
  const provider = readShuttleProviderConfig(config);
  const hasDetails = Object.values(details).some((value) => value.trim());
  const draft = provider ? buildShuttleDraftTemplate(provider, details) : null;

  if (!provider || !draft) {
    return (
      <Section title="Draft shuttle request">
        <Notice tone="warn" role="status">Shuttle requests are not set up for this property.</Notice>
      </Section>
    );
  }

  const update = (key: keyof ShuttleTransferDetails, value: string) => {
    setDetails((current) => ({ ...current, [key]: value }));
    setStatus(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasDetails || saving.current || status?.tone === 'success') return;
    saving.current = true;
    setPending(true);
    setStatus(null);
    try {
      await trpcClient.drafts.create.mutate({
        id: null,
        threadId: null,
        replyToMessageId: null,
        to: provider.to.join(', '),
        subject: draft.subject,
        message: draft.html,
      }, inMailbox(transportId));
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() }),
      ]);
      setStatus({ tone: 'success', message: 'Saved as an unsent draft. Review and send from Drafts.' });
    } catch {
      setStatus({ tone: 'error', message: 'The mailbox is busy or unavailable. Nothing was sent; try again.' });
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <Section title="Draft shuttle request">
      <p className="text-[13px] text-[#64748b]">
        For {provider.provider}. Saving creates an unsent draft only; review it before sending.
      </p>
      <form className="flex flex-col gap-3" onSubmit={save}>
        {FIELDS.map(({ key, label, type }) => (
          <Field key={key} label={label} htmlFor={`shuttle-${key}`}>
            <input
              id={`shuttle-${key}`}
              type={type ?? 'text'}
              className={paneFieldClass}
              maxLength={240}
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
        <PrimaryButton
          type="submit"
          disabled={!hasDetails || pending || status?.tone === 'success'}
          disabledReason={
            !hasDetails
              ? 'Add at least one transfer detail.'
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
