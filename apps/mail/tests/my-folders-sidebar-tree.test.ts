import { describe, expect, it } from 'vitest';
import type { Label } from '@/types';
import { buildMyFoldersSidebarTree } from '@/lib/mail/my-folders-sidebar-tree';

const makeLabel = (
  id: string,
  name: string,
  options: Partial<Pick<Label, 'color' | 'type' | 'labels'>> = {},
): Label => ({
  id,
  name,
  type: 'folder',
  ...options,
});

const treeShape = (
  tree: readonly {
    id: string;
    name: string;
    labels?: readonly { id: string; name: string }[];
  }[],
) =>
  tree.map((node) => ({
    id: node.id,
    name: node.name,
    labels: node.labels?.map((child) => ({ id: child.id, name: child.name })),
  }));

describe('buildMyFoldersSidebarTree', () => {
  it('keeps Microsoft flat while sorting natural case-insensitive names with deterministic ties', () => {
    const labels = [
      makeLabel('folder-ten', 'Folder 10'),
      makeLabel('lower-alpha', 'alpha'),
      makeLabel('duplicate-b', 'duplicate'),
      makeLabel('folder-two', 'folder 2'),
      makeLabel('upper-alpha', 'Alpha'),
      makeLabel('duplicate-a', 'duplicate'),
      makeLabel('slash-child', 'Projects/Child'),
      makeLabel('bracket-label', '[Archive]'),
    ];

    const tree = buildMyFoldersSidebarTree(labels, 'microsoft');

    expect(tree.map((node) => `${node.name}:${node.id}`)).toEqual([
      '[Archive]:bracket-label',
      'Alpha:upper-alpha',
      'alpha:lower-alpha',
      'duplicate:duplicate-a',
      'duplicate:duplicate-b',
      'folder 2:folder-two',
      'Folder 10:folder-ten',
      'Projects/Child:slash-child',
    ]);
    expect(tree.every((node) => node.labels === undefined)).toBe(true);
    expect(tree.every((node) => !node.id.startsWith('group-'))).toBe(true);
    expect(tree.find((node) => node.id === 'bracket-label')).toMatchObject({
      name: '[Archive]',
    });
    expect(tree.find((node) => node.id === 'slash-child')).toMatchObject({
      name: 'Projects/Child',
    });
  });

  it('sorts visible names by the active UI locale', () => {
    const labels = [
      makeLabel('isparta', 'Isparta'),
      makeLabel('izmir-dotless', 'Izmir'),
      makeLabel('isik', 'ışık'),
      makeLabel('istanbul', 'istanbul'),
      makeLabel('izmir-dotted', 'İzmir'),
    ];

    const tree = buildMyFoldersSidebarTree(labels, 'microsoft', 'tr');

    expect(tree.map((node) => node.name)).toEqual([
      'Isparta',
      'ışık',
      'Izmir',
      'istanbul',
      'İzmir',
    ]);
  });

  it('sorts non-Microsoft roots and children after slash and bracket display transforms', () => {
    const labels = [
      makeLabel('z-child-ten', 'Zulu/Folder 10'),
      makeLabel('bracket-zoo', '[Zoo]'),
      makeLabel('plain-alpha', 'alpha'),
      makeLabel('beta-parent', 'Beta'),
      makeLabel('z-child-two', 'Zulu/folder 2'),
      makeLabel('bracket-apple', '[apple]'),
      makeLabel('beta-child-ten', 'Beta/Folder 10'),
      makeLabel('beta-child-two', 'Beta/folder 2'),
    ];

    const tree = buildMyFoldersSidebarTree(labels, 'google');
    const reshuffledTree = buildMyFoldersSidebarTree([...labels].reverse(), 'google');

    expect(treeShape(reshuffledTree)).toEqual(treeShape(tree));
    expect(tree.map((node) => node.name)).toEqual(['alpha', 'Beta', 'Other', 'Zulu']);
    expect(tree.find((node) => node.name === 'Beta')?.labels?.map((node) => node.name)).toEqual([
      'folder 2',
      'Folder 10',
    ]);
    expect(tree.find((node) => node.name === 'Other')?.labels?.map((node) => node.name)).toEqual([
      'apple',
      'Zoo',
    ]);
    expect(tree.find((node) => node.name === 'Zulu')?.labels?.map((node) => node.name)).toEqual([
      'folder 2',
      'Folder 10',
    ]);
  });

  it('breaks equal transformed bracket names by source raw name before id', () => {
    const singleBracket = makeLabel('z-single-bracket', '[Alpha]');
    const doubleBracket = makeLabel('a-double-bracket', '[[Alpha]]');

    const tree = buildMyFoldersSidebarTree([doubleBracket, singleBracket], 'google');

    expect(tree.find((node) => node.id === 'group-other')?.labels?.map((node) => node.id)).toEqual([
      'z-single-bracket',
      'a-double-bracket',
    ]);
  });

  it('chooses duplicate real group parents by id regardless of input order', () => {
    const laterById = makeLabel('z-parent', 'Projects', {
      type: 'user',
      color: '#z-parent',
    });
    const earlierById = makeLabel('a-parent', 'Projects', {
      type: 'system',
      color: '#a-parent',
    });
    const child = makeLabel('project-child', 'Projects/Child');

    const tree = buildMyFoldersSidebarTree([laterById, child, earlierById], 'google');
    const reshuffledTree = buildMyFoldersSidebarTree([earlierById, child, laterById], 'google');
    const projects = tree.find((node) => node.name === 'Projects');
    const reshuffledProjects = reshuffledTree.find((node) => node.name === 'Projects');

    expect(projects).toMatchObject({
      id: 'a-parent',
      type: 'system',
      color: '#a-parent',
    });
    expect(projects?.originalLabel).toBe(earlierById);
    expect(reshuffledProjects).toMatchObject({
      id: 'a-parent',
      type: 'system',
      color: '#a-parent',
    });
    expect(reshuffledProjects?.originalLabel).toBe(earlierById);
  });

  it('preserves real label data and identity while creating only existing synthetic group ids', () => {
    const parent = makeLabel('real-parent', 'Projects', {
      type: 'system',
      color: { backgroundColor: '#123456', textColor: '#ffffff' },
    });
    const child = makeLabel('real-child', 'Projects/Alpha', {
      type: 'user',
      color: '#abcdef',
    });
    const missingParentChild = makeLabel('missing-child', 'Travel/Plans', {
      type: 'user',
      color: '#fedcba',
    });
    const bracket = makeLabel('bracket-child', '[Loose]', {
      type: 'user',
      color: '#654321',
    });
    const flat = makeLabel('flat-label', 'Archive', { type: 'user', color: '#111111' });
    const labels = Object.freeze([parent, child, missingParentChild, bracket, flat]);
    const before = structuredClone(labels);

    const tree = buildMyFoldersSidebarTree(labels, 'mailbox');
    const projects = tree.find((node) => node.name === 'Projects');
    const travel = tree.find((node) => node.name === 'Travel');
    const other = tree.find((node) => node.id === 'group-other');
    const archive = tree.find((node) => node.id === 'flat-label');

    expect(projects).toMatchObject({
      id: 'real-parent',
      name: 'Projects',
      type: 'system',
      color: parent.color,
    });
    expect(projects?.originalLabel).toBe(parent);
    expect(projects?.labels?.[0]).toMatchObject({
      id: 'real-child',
      name: 'Alpha',
      type: 'user',
      color: '#abcdef',
    });
    expect(projects?.labels?.[0]?.originalLabel).toBe(child);
    expect(travel).toMatchObject({ id: 'group-Travel', name: 'Travel', type: 'folder' });
    expect(travel?.labels?.[0]?.originalLabel).toBe(missingParentChild);
    expect(other).toMatchObject({ id: 'group-other', name: 'Other', type: 'folder' });
    expect(other?.labels?.[0]).toMatchObject({
      id: 'bracket-child',
      name: 'Loose',
      type: 'user',
      color: '#654321',
    });
    expect(other?.labels?.[0]?.originalLabel).toBe(bracket);
    expect(archive?.originalLabel).toBe(flat);
    expect(tree).not.toBe(labels);
    expect(labels).toEqual(before);
    expect(labels[0]).not.toHaveProperty('originalLabel');
  });

  it('keeps empty and malformed slash labels flat while retaining one-level multi-slash grouping', () => {
    const tree = buildMyFoldersSidebarTree(
      [
        makeLabel('leading-slash', '/Leading'),
        makeLabel('trailing-slash', 'Trailing/'),
        makeLabel('double-slash', 'Double//Slash'),
        makeLabel('empty-name', ''),
        makeLabel('nested-child', 'Parent/Child/Leaf'),
      ],
      'google',
    );

    for (const id of ['leading-slash', 'trailing-slash', 'double-slash', 'empty-name']) {
      expect(tree.find((node) => node.id === id)).toBeDefined();
    }
    expect(tree.find((node) => node.id === 'group-Double')).toBeUndefined();
    expect(tree.find((node) => node.id === 'group-Parent')).toMatchObject({
      name: 'Parent',
      labels: [{ id: 'nested-child', name: 'Child/Leaf' }],
    });
    expect(tree.find((node) => node.id === 'group-Parent')?.labels?.[0]?.labels).toBeUndefined();
  });
});
