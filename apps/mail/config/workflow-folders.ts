import { Folder, Inbox, Plane2, Tabs } from '@/components/icons/icons';
import type { NavItem } from './navigation';

export const PRIMARY_MAIL_NAV_ITEMS = [
  { id: 'inbox', title: 'Inbox', url: '/mail/inbox', icon: Inbox },
  { id: 'all', title: 'All mail', url: '/mail/all', icon: Tabs },
  { id: 'sent', title: 'Sent', url: '/mail/sent', icon: Plane2 },
] as const satisfies readonly NavItem[];

/** Navigation labels and route slugs only; server workflow-folders.ts owns membership mapping. */
export const WORKFLOW_FOLDER_NAV_ITEMS = [
  { id: 'quotes', title: 'Quotes', url: '/mail/quotes', icon: Folder },
  { id: 'new-bookings', title: 'New bookings', url: '/mail/new-bookings', icon: Folder },
  { id: 'amendments', title: 'Amendments', url: '/mail/amendments', icon: Folder },
  { id: 'cancellations', title: 'Cancellations', url: '/mail/cancellations', icon: Folder },
  { id: 'payments', title: 'Payments', url: '/mail/payments', icon: Folder },
  { id: 'billing', title: 'Billing', url: '/mail/billing', icon: Folder },
  { id: 'groups-events', title: 'Groups & events', url: '/mail/groups-events', icon: Folder },
  { id: 'other-to-do', title: 'Other to do', url: '/mail/other-to-do', icon: Folder },
  { id: 'not-for-nava', title: 'Not for Nava', url: '/mail/not-for-nava', icon: Folder },
] as const satisfies readonly NavItem[];

export type WorkflowFolderNavId = (typeof WORKFLOW_FOLDER_NAV_ITEMS)[number]['id'];

export function isWorkflowFolderNavId(value: string | undefined | null): value is WorkflowFolderNavId {
  return WORKFLOW_FOLDER_NAV_ITEMS.some((item) => item.id === value?.toLowerCase());
}
