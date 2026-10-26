import type { Outputs } from '@zero/server/trpc';

type ReadyWorkItem = Extract<Outputs['workItems']['getByMessage'], { status: 'ready' }>;
export type WorkItemFieldProvenanceEntry = ReadyWorkItem['fieldProvenance'][string];

type WorkItemFieldProvenanceProps = {
  fieldValue: unknown;
  provenance?: WorkItemFieldProvenanceEntry | null;
};

/** An inline marker for H1 provenance, hidden when the displayed value differs from the server's latest value. */
export function WorkItemFieldProvenance({
  fieldValue,
  provenance,
}: WorkItemFieldProvenanceProps) {
  if (!provenance || !Object.is(provenance.value, fieldValue)) return null;
  if (provenance.source !== 'ai' && provenance.source !== 'staff') return null;

  const isAi = provenance.source === 'ai';
  const label = isAi ? 'AI' : 'Edited';
  const title = isAi ? 'AI-provided value' : 'Staff-edited value';
  return (
    <span
      className="inline-flex rounded-full bg-[#f1f5f9] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#475569]"
      title={title}
    >
      {label}
    </span>
  );
}
