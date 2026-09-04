import { LabelSidebarContextMenu } from '../context/label-sidebar-context';

import type { Label, Label as LabelType } from '@/types';
import { useSidebar } from '../context/sidebar-context';
import useSearchLabels from '@/hooks/use-labels-search';
import { isUserFolderDroppableId } from '@/lib/mail/file-drag';
import { shouldNavigateMyFolderRoute } from '@/lib/mail/my-folders-nav';
import { Folder } from '../magicui/file-tree';
import { useLocation, useNavigate } from 'react-router';
import { useDroppable } from '@dnd-kit/core';

import { useCallback } from 'react';
import * as React from 'react';

export const RecursiveFolder = ({
  label,
  activeAccount,
  count,
  getCount,
}: {
  label: Label & { originalLabel?: Label };
  activeAccount?: any;
  count?: number;
  getCount?: (label: Label & { originalLabel?: Label }) => number;
}) => {
  const { labels, setLabels } = useSearchLabels();
  const location = useLocation();
  const isActive = labels?.includes(label.id);
  const isFolderActive =
    isActive || location.pathname.includes(`/mail/${label.id}`);
  const navigate = useNavigate();
  const { setOpenMobile, isMobile } = useSidebar();

  const canDrop = isUserFolderDroppableId(label.id);
  const { setNodeRef, isOver } = useDroppable({
    id: label.id,
    disabled: !canDrop,
  });

  const handleFilterByLabel = useCallback(
    (labelToFilter: LabelType) => {
      if (labels?.includes(labelToFilter.id)) {
        setLabels(labels.filter((l) => l !== labelToFilter.id));
      } else {
        setLabels([...(labels ?? []), labelToFilter.id]);
      }
    },
    [labels, setLabels],
  );

  const handleFolderClick = useCallback(
    (id: string) => {
      if (!activeAccount) return;

      if (id.startsWith('group-')) {
        return;
      }

      const labelToUse = label;

      if (shouldNavigateMyFolderRoute(activeAccount.providerId)) {
        navigate(`/mail/${id}`);
      } else {
        handleFilterByLabel(labelToUse);
      }

      if (isMobile) {
        setOpenMobile(false);
      }
    },
    [navigate, handleFilterByLabel, activeAccount, label, isMobile, setOpenMobile],
  );

  const hasChildren = label.labels && label.labels.length > 0;

  const nodeCount = getCount ? getCount(label) : (count || 0);
  const resolvedCount =
    label.id.startsWith('group-') && activeAccount?.providerId === 'mailbox' ? 0 : nodeCount;

  return (
    <LabelSidebarContextMenu
      labelId={label.id}
      key={label.id}
      hide={activeAccount?.providerId === 'microsoft' || hasChildren}
    >
      <div ref={canDrop ? setNodeRef : undefined} className="w-full min-h-[28px]">
        <Folder
          element={label.name}
          value={label.id}
          key={label.id}
          hasChildren={hasChildren}
          onFolderClick={handleFolderClick}
          isSelect={isFolderActive || (canDrop && isOver)}
          count={resolvedCount}
          className="max-w-[192px]"
        >
          {label.labels?.map((childLabel: any) => (
            <RecursiveFolder
              key={childLabel.id}
              label={childLabel}
              activeAccount={activeAccount}
              count={getCount ? getCount(childLabel) : count}
              getCount={getCount}
            />
          ))}
        </Folder>
      </div>
    </LabelSidebarContextMenu>
  );
};
