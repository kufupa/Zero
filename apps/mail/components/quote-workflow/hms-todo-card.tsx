import { Section } from '@/components/nava-pane/pane-ui';

export type HmsTodoKind =
  | 'new_booking'
  | 'amend'
  | 'cancel'
  | 'payment_proof'
  | 'forward_to_partner'
  | 'send_document'
  | 'payment_ack'
  | 'clarify'
  | 'acknowledge';

export type HmsTodoStepSource = 'mail' | 'attachment' | 'missing';

export type HmsTodoStep = {
  label: string;
  value: string | null;
  source: HmsTodoStepSource;
};

/** Server analyse payload `hmsTodoCard`. Mirrors `buildHmsTodoCard`. */
export type HmsTodoCardPayload = {
  kind: HmsTodoKind;
  title: string;
  steps: HmsTodoStep[];
  missing: string[];
  writesEnabled: false;
};

const PII_LABELS = new Set([
  'Guest last name',
  'Confirmation number',
  'Requested change',
  'Payment reference',
  'Attachments',
  'Team',
  'Document',
]);

/**
 * Read-only staff checklist of facts to type into HMS. Renders nothing without a card.
 * Never offers a write control. Missing values are muted "Missing", not a warning colour.
 */
export function HmsTodoCard({ card }: { card: HmsTodoCardPayload | null | undefined }) {
  if (!card) return null;

  return (
    <Section title={card.title} id="quote-hms-todo">
      <dl className="flex flex-col gap-1.5">
        {card.steps.map((step) => (
          <div key={step.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[13px] font-semibold text-[#475569]">{step.label}</dt>
            <dd
              data-pii={PII_LABELS.has(step.label) || undefined}
              className={
                step.value
                  ? 'text-right text-[12.5px] text-[#1e293b]'
                  : 'text-right text-[12.5px] text-[#64748b]'
              }
            >
              {step.value ?? 'Missing'}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-[#64748b]">Nava does not write to HMS</p>
    </Section>
  );
}
