type DemoLabelLike = {
  id: string;
  name: string;
};

const REMOVED_DEMO_LABELS = new Set(['comment', 'to respond', 'promotion']);

function normalizeLabelValue(value: string): string {
  return value.trim().toLowerCase();
}

export function isRemovedDemoLabel(label: DemoLabelLike): boolean {
  return (
    REMOVED_DEMO_LABELS.has(normalizeLabelValue(label.id)) || REMOVED_DEMO_LABELS.has(normalizeLabelValue(label.name))
  );
}

export function filterRemovedDemoLabels<T extends DemoLabelLike>(labels: readonly T[]): T[] {
  return labels.filter((label) => !isRemovedDemoLabel(label));
}
