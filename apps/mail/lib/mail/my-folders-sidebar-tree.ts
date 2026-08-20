import type { Label } from '@/types';

type SidebarLabelNode = Omit<Label, 'labels'> & {
  labels?: SidebarLabelNode[];
  originalLabel?: Label;
};

const createVisibleNameCollator = (locale: string): Intl.Collator =>
  new Intl.Collator(locale, {
    numeric: true,
    sensitivity: 'base',
  });

const sourceRawName = (node: SidebarLabelNode): string => node.originalLabel?.name ?? node.name;

const compareVisibleNodes =
  (visibleNameCollator: Intl.Collator) =>
  (left: SidebarLabelNode, right: SidebarLabelNode): number => {
    const visibleNameOrder = visibleNameCollator.compare(left.name, right.name);
    if (visibleNameOrder !== 0) return visibleNameOrder;
    const leftRawName = sourceRawName(left);
    const rightRawName = sourceRawName(right);
    if (leftRawName !== rightRawName) return leftRawName < rightRawName ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  };

const sortVisibleNodes = <T extends SidebarLabelNode>(
  nodes: readonly T[],
  visibleNameCollator: Intl.Collator,
): T[] => [...nodes].sort(compareVisibleNodes(visibleNameCollator));

const hasSlashChild = (name: string): boolean => /[^/]+\/[^/]+/.test(name);

const toSidebarLabelNode = (label: Label, name = label.name): SidebarLabelNode => ({
  id: label.id,
  name,
  type: label.type,
  color: label.color,
  originalLabel: label,
});

export function buildMyFoldersSidebarTree(
  labels: readonly Label[],
  providerId: string | null | undefined,
  locale = 'en',
): SidebarLabelNode[] {
  const visibleNameCollator = createVisibleNameCollator(locale);

  if (providerId === 'microsoft') {
    return sortVisibleNodes(labels, visibleNameCollator);
  }

  const folderNames = new Set<string>();
  for (const label of labels) {
    if (hasSlashChild(label.name)) {
      folderNames.add(label.name.split('/')[0]!);
    }
  }

  const brackets: Label[] = [];
  const other: Label[] = [];
  const folders = new Map<string, Label[]>();

  for (const label of labels) {
    if (folderNames.has(label.name)) continue;

    if (/\[.*\]/.test(label.name)) {
      brackets.push(label);
    } else if (hasSlashChild(label.name)) {
      const groupName = label.name.split('/')[0]!;
      const children = folders.get(groupName) ?? [];
      children.push(label);
      folders.set(groupName, children);
    } else {
      other.push(label);
    }
  }

  const roots: SidebarLabelNode[] = [
    ...Array.from(folders, ([groupName, children]) => {
      const parent = sortVisibleNodes(
        labels.filter((label) => label.name === groupName),
        visibleNameCollator,
      )[0];

      return {
        id: parent?.id || `group-${groupName}`,
        name: groupName,
        type: parent?.type || 'folder',
        color: parent?.color,
        originalLabel: parent,
        labels: sortVisibleNodes(
          children.map((label) =>
            toSidebarLabelNode(label, label.name.split('/').slice(1).join('/')),
          ),
          visibleNameCollator,
        ),
      };
    }),
    ...other.map((label) => toSidebarLabelNode(label)),
  ];

  if (brackets.length > 0) {
    roots.push({
      id: 'group-other',
      name: 'Other',
      type: 'folder',
      labels: sortVisibleNodes(
        brackets.map((label) => toSidebarLabelNode(label, label.name.replace(/\[|\]/g, ''))),
        visibleNameCollator,
      ),
    });
  }

  return sortVisibleNodes(roots, visibleNameCollator);
}
