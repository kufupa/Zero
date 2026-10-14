import { Link, useLocation } from 'react-router';
import type { SidebarUnreadCountSnapshot } from '@/lib/mail/sidebar-unread-counts';
import { getNavUnreadCount } from '@/lib/mail/sidebar-unread-counts';
import {
  PRIMARY_MAIL_NAV_ITEMS,
  WORKFLOW_FOLDER_NAV_ITEMS,
  type WorkflowFolderNavId,
} from '@/config/workflow-folders';
import type { NavItem } from '@/config/navigation';

type WorkflowCounts = Partial<Record<WorkflowFolderNavId, number>>;
type WorkflowSummary = Partial<
  Record<WorkflowFolderNavId, { threads?: number; total?: number; marked?: number }>
>;

export function WorkflowFolderNav({
  counts,
  summary,
  unreadCountsSnapshot,
  collapsed = false,
}: {
  counts?: WorkflowCounts;
  summary?: WorkflowSummary;
  unreadCountsSnapshot?: SidebarUnreadCountSnapshot;
  collapsed?: boolean;
}) {
  const location = useLocation();
  const reviewSet = new URLSearchParams(location.search).get('set') === 'eval';
  return (
    <nav aria-label="Mail navigation" className="flex flex-col gap-3 px-2 py-1">
      <div className="flex flex-col gap-1" aria-label="Primary mail folders">
        {PRIMARY_MAIL_NAV_ITEMS.map((item) => (
          <WorkflowNavLink
            key={item.id}
            item={item}
            active={location.pathname.replace(/\/$/, '') === item.url}
            collapsed={collapsed}
            count={getNavUnreadCount(unreadCountsSnapshot, item.id)}
          />
        ))}
      </div>

      <section className="flex flex-col gap-1" aria-label="Workflow folders">
        {!collapsed ? (
          <h2 className="text-muted-foreground mx-2 mb-1 text-[13px] dark:text-[#898989]">
            Workflows
          </h2>
        ) : null}
        {WORKFLOW_FOLDER_NAV_ITEMS.map((item) => {
          const folderSummary = summary?.[item.id];
          const count = reviewSet
            ? typeof folderSummary?.total === 'number'
              ? `${folderSummary.marked ?? 0} / ${folderSummary.total}`
              : undefined
            : counts?.[item.id] ?? folderSummary?.threads;
          const countLabel =
            reviewSet && typeof folderSummary?.total === 'number'
              ? `${folderSummary.marked ?? 0} of ${folderSummary.total} marked`
              : undefined;
          return (
            <WorkflowNavLink
              key={item.id}
              item={item}
              to={`${item.url}${reviewSet ? '?set=eval' : ''}`}
              active={location.pathname.replace(/\/$/, '') === item.url}
              collapsed={collapsed}
              count={count}
              countLabel={countLabel}
              showZero
            />
          );
        })}
      </section>
    </nav>
  );
}

function WorkflowNavLink({
  item,
  to,
  active,
  collapsed,
  count,
  countLabel,
  showZero = false,
}: {
  item: NavItem;
  to?: string;
  active: boolean;
  collapsed: boolean;
  count?: number | string;
  countLabel?: string;
  showZero?: boolean;
}) {
  const Icon = item.icon;
  const showCount =
    (typeof count === 'string' ||
      (typeof count === 'number' && (showZero || count > 0))) &&
    !collapsed;
  return (
    <Link
      to={to ?? item.url}
      aria-label={collapsed ? item.title : undefined}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.title : undefined}
      className={`flex h-9 items-center gap-2 rounded-md px-2 text-[13px] transition-colors hover:bg-subtleWhite dark:hover:bg-[#202020] ${
        active ? 'bg-subtleWhite text-foreground dark:bg-[#202020]' : 'text-muted-foreground'
      } ${collapsed ? 'justify-center px-1' : ''}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.title}</span> : null}
      {showCount ? (
        <span
          aria-label={countLabel ?? (typeof count === 'number' ? `${count} threads` : undefined)}
          className="text-muted-foreground ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums"
        >
          {typeof count === 'number' ? count.toLocaleString() : count}
        </span>
      ) : null}
    </Link>
  );
}
