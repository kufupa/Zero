import React, { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Label } from '@/types';
import { isUserFolderDroppableId } from '@/lib/mail/file-drag';

const mocks = vi.hoisted(() => ({
  activeAccount: { providerId: 'google' },
  recursiveFolder: vi.fn((props: unknown) => {
    void props;
    return null;
  }),
  stats: [
    { label: 'Archive', count: 17 },
    { label: 'Other', count: 9 },
    { label: 'Projects', count: 6 },
    { label: 'zebra', count: 1 },
  ],
}));

vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: mocks.activeAccount }),
}));

vi.mock('@/hooks/use-stats', () => ({
  useStats: () => ({ data: mocks.stats }),
}));

vi.mock('@/paraglide/runtime', () => ({
  getLocale: () => 'tr',
}));

vi.mock('../components/magicui/file-tree', () => ({
  Tree: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('../components/ui/recursive-folder', () => ({
  RecursiveFolder: mocks.recursiveFolder,
}));

import SidebarLabels from '@/components/ui/sidebar-labels';

type SidebarLabel = Omit<Label, 'labels'> & {
  labels?: SidebarLabel[];
  originalLabel?: Label;
};

type RecursiveFolderProps = {
  label: SidebarLabel;
  activeAccount: typeof mocks.activeAccount;
  count?: number;
};

const makeLabel = (
  id: string,
  name: string,
  options: Partial<Pick<Label, 'color' | 'type'>> = {},
): Label => ({
  id,
  name,
  type: 'folder',
  ...options,
});

describe('SidebarLabels', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    mocks.activeAccount = { providerId: 'google' };
    mocks.recursiveFolder.mockClear();
  });

  it('renders normalized non-Microsoft nodes with stable folder identities and props', () => {
    const zebra = makeLabel('zebra-root', 'zebra');
    const bracketZoo = makeLabel('bracket-zoo', '[Zoo]');
    const projectChildTen = makeLabel('projects-child-ten', 'Projects/Folder 10');
    const projects = makeLabel('projects-root', 'Projects', {
      color: '#123456',
      type: 'user',
    });
    const projectChildTwo = makeLabel('projects-child-two', 'Projects/folder 2');
    const bracketApple = makeLabel('bracket-apple', '[apple]');
    const archive = makeLabel('archive-root', 'Archive');

    renderToStaticMarkup(
      createElement(SidebarLabels, {
        data: [
          zebra,
          bracketZoo,
          projectChildTen,
          projects,
          projectChildTwo,
          bracketApple,
          archive,
        ],
      }),
    );

    const rendered = mocks.recursiveFolder.mock.calls.map(
      ([props]) => props as RecursiveFolderProps,
    );

    expect(rendered.map(({ label }) => `${label.name}:${label.id}`)).toEqual([
      'Archive:archive-root',
      'Other:group-other',
      'Projects:projects-root',
      'zebra:zebra-root',
    ]);
    expect(rendered.map(({ label, count }) => `${label.id}:${count}`)).toEqual([
      'archive-root:17',
      'group-other:9',
      'projects-root:6',
      'zebra-root:1',
    ]);
    expect(rendered.map(({ label }) => isUserFolderDroppableId(label.id))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    for (const { activeAccount } of rendered) {
      expect(activeAccount).toBe(mocks.activeAccount);
    }

    const other = rendered[1]!.label;
    const projectsRoot = rendered[2]!.label;
    expect(rendered[0]!.label.originalLabel).toBe(archive);
    expect(other.labels?.map(({ id }) => id)).toEqual(['bracket-apple', 'bracket-zoo']);
    expect(other.labels?.map(({ originalLabel }) => originalLabel)).toEqual([
      bracketApple,
      bracketZoo,
    ]);
    expect(projectsRoot.originalLabel).toBe(projects);
    expect(projectsRoot.labels?.map(({ id }) => id)).toEqual([
      'projects-child-two',
      'projects-child-ten',
    ]);
    expect(projectsRoot.labels?.map(({ originalLabel }) => originalLabel)).toEqual([
      projectChildTwo,
      projectChildTen,
    ]);
  });

  it('uses the active UI locale to order Microsoft folder labels', () => {
    mocks.activeAccount = { providerId: 'microsoft' };

    renderToStaticMarkup(
      createElement(SidebarLabels, {
        data: [
          makeLabel('isparta', 'Isparta'),
          makeLabel('izmir-dotless', 'Izmir'),
          makeLabel('isik', 'ışık'),
          makeLabel('istanbul', 'istanbul'),
          makeLabel('izmir-dotted', 'İzmir'),
        ],
      }),
    );

    const rendered = mocks.recursiveFolder.mock.calls.map(
      ([props]) => props as RecursiveFolderProps,
    );

    expect(rendered.map(({ label }) => label.name)).toEqual([
      'Isparta',
      'ışık',
      'Izmir',
      'istanbul',
      'İzmir',
    ]);
  });
});
