import type { Outputs } from '@zero/server/trpc';

type ReadyWorkItem = Extract<Outputs['workItems']['getByMessage'], { status: 'ready' }>;
export type WorkItemFieldProvenanceEntry = ReadyWorkItem['fieldProvenance'][string];

type WorkItemFieldProvenanceProps = {
  fieldValue: unknown;
  provenance?: WorkItemFieldProvenanceEntry | null;
};

export function WorkItemFieldProvenance(props: WorkItemFieldProvenanceProps) {
  if (props.provenance && Object.is(props.provenance.value, props.fieldValue)) return <span />;
  return null;
}
