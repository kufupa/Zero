import type { Label as LabelType } from '@/types';
import { useActiveConnection } from '@/hooks/use-connections';
import { RecursiveFolder } from './recursive-folder';
import { useStats } from '@/hooks/use-stats';
import { buildMyFoldersSidebarTree } from '@/lib/mail/my-folders-sidebar-tree';
import { getLocale } from '@/paraglide/runtime';
import { Tree } from '../magicui/file-tree';
import { useCallback } from 'react';

import type { SidebarUnreadCountSnapshot } from '@/lib/mail/sidebar-unread-counts';
import { getLabelUnreadCount } from '@/lib/mail/sidebar-unread-counts';

type Props = {
  data: LabelType[];
  unreadCountsSnapshot?: SidebarUnreadCountSnapshot;
};

const SidebarLabels = ({ data, unreadCountsSnapshot }: Props) => {
  const { data: stats } = useStats();
  const { data: activeAccount } = useActiveConnection();
  const getLabelCount = useCallback(
    (labelName: string | undefined): number => {
      if (!stats || !labelName) return 0;
      return (
        stats.find((stat) => stat.label?.toLowerCase() === labelName.toLowerCase())?.count ?? 0
      );
    },
    [stats],
  );

  const getCount = useCallback(
    (label: { id: string; name?: string }): number => {
      if (unreadCountsSnapshot) {
        return getLabelUnreadCount(unreadCountsSnapshot, label.id, label.name) ?? 0;
      }
      return getLabelCount(label.name);
    },
    [unreadCountsSnapshot, getLabelCount],
  );

  const getTooltip = useCallback(
    (label: { id: string; name?: string }): string | undefined => {
      if (unreadCountsSnapshot) {
        return unreadCountsSnapshot.getTooltip(label.id, label.name);
      }
      return undefined;
    },
    [unreadCountsSnapshot],
  );

  const myFoldersTree = data
    ? buildMyFoldersSidebarTree(data, activeAccount?.providerId, getLocale())
    : [];

  return (
    <div className="mr-0 flex-1 pr-0">
      <div className="no-scrollbar relative -m-2 flex-1 overflow-auto bg-transparent">
        <Tree className="rounded-md bg-transparent">
          {myFoldersTree.map((label) => (
            <RecursiveFolder
              key={label.id}
              label={label}
              activeAccount={activeAccount}
              count={getCount(label)}
              getCount={getCount}
              getTooltip={getTooltip}
            />
          ))}
        </Tree>
      </div>
    </div>
  );
};

export default SidebarLabels;
