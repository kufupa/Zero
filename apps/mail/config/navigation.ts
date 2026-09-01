import {
  Archive,
  Bin,
  ExclamationCircle,
  Folder,
  Inbox,
  SettingsGear,
  Stars,
  Tabs,
  ArrowLeft,
  Danger,
  Plane2,
  LockIcon,
  Clock,
} from '@/components/icons/icons';
import {
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  isHotelManagedCategorySlug,
  isHotelWorkflowPrimarySlug,
  HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS,
  HOTEL_WORKFLOW_PRIMARY_SLUGS,
} from '@/lib/mail/hotel-folder-presentation';
import {
  DEMO_MAIL_FOLDER_DEFINITIONS,
  WORKFLOW_MAIL_FOLDER_DEFINITIONS,
  type DemoMailFolderId,
} from '@/lib/demo/folder-map';
import { categoryColorNavTheme } from '@/lib/mail/route-filter';
import { PILOT_CAPABILITIES } from '@/lib/pilot/capabilities';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import type { ComponentType, SVGProps } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { CSSProperties } from 'react';
import { m } from '@/paraglide/messages';
import { cn } from '@/lib/utils';

export interface NavItem {
  id?: string;
  title: string;
  subtitle?: string;
  url: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  badge?: number;
  isBackButton?: boolean;
  isSettingsButton?: boolean;
  disabled?: boolean;
  target?: string;
  shortcut?: string;
  hidden?: boolean;
  style?: CSSProperties;
  className?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export type LiveCategoryNavInput = {
  slug: string;
  name: string;
  color?: string | null;
  sortOrder?: number;
};

export type WorkflowNavEnv = {
  VITE_WORKFLOW_NAV_V6?: string | boolean;
  WORKFLOW_NAV_V6?: string | boolean;
};

export function isWorkflowNavV6Enabled(
  env: WorkflowNavEnv = import.meta.env as WorkflowNavEnv,
): boolean {
  const raw = env.VITE_WORKFLOW_NAV_V6 ?? env.WORKFLOW_NAV_V6;
  return raw === true || raw === '1' || raw === 'true';
}

/** Build-time frontend gate. Durable triage/schema gate lives in server env. */
export const WORKFLOW_NAV_V6 = isWorkflowNavV6Enabled();

function isLegacyOrCustomLiveCategory(slug: string): boolean {
  if (
    HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS.includes(
      slug as (typeof HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS)[number],
    )
  ) {
    return true;
  }
  return !isHotelWorkflowPrimarySlug(slug);
}

function getLiveCategoryNavSortIndex(
  category: LiveCategoryNavInput,
  workflowNav: boolean,
): number {
  const slug = category.slug.trim().toLowerCase();
  if (slug === 'urgent') return -1;
  if (category.sortOrder !== undefined) return category.sortOrder;
  const primaryOrder = workflowNav
    ? HOTEL_WORKFLOW_PRIMARY_SLUGS
    : HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS;
  const primaryIndex = (primaryOrder as readonly string[]).indexOf(slug);
  return primaryIndex >= 0 ? primaryIndex : primaryOrder.length;
}

export function buildLiveCategoryNavItems(
  categories: LiveCategoryNavInput[],
  workflowNav: boolean = WORKFLOW_NAV_V6,
): NavItem[] {
  const visibleCategories = categories.filter((category) => {
    const slug = category.slug.trim().toLowerCase();
    if (slug === 'spam') return false;
    if (workflowNav) {
      return HOTEL_WORKFLOW_PRIMARY_SLUGS.includes(
        slug as (typeof HOTEL_WORKFLOW_PRIMARY_SLUGS)[number],
      ) || slug === 'urgent';
    }
    // Legacy live mode keeps custom categories, but removes v6 folders until flip.
    return isLegacyOrCustomLiveCategory(slug);
  });

  return [...visibleCategories]
    .sort(
      (a, b) =>
        getLiveCategoryNavSortIndex(a, workflowNav) -
        getLiveCategoryNavSortIndex(b, workflowNav),
    )
    .map((category) => {
      const presentation = getHotelFolderPresentation(category.slug);
      const managedTheme = isHotelManagedCategorySlug(category.slug)
        ? getHotelFolderNavTheme(category.slug)
        : category.color?.trim()
          ? categoryColorNavTheme(category.color)
          : {};

      return {
        id: category.slug,
        title: presentation?.title ?? category.name,
        subtitle: presentation?.subtitle,
        url: `/mail/${category.slug}`,
        icon: Folder,
        ...managedTheme,
      };
    });
}

export function injectLiveCategoryNavSection(
  sections: NavSection[],
  categories: LiveCategoryNavInput[],
  workflowNav: boolean = WORKFLOW_NAV_V6,
): NavSection[] {
  if (!PILOT_CAPABILITIES.hotelCategories || categories.length === 0) {
    return sections;
  }

  const folderItems = buildLiveCategoryNavItems(categories, workflowNav);
  if (folderItems.length === 0) return sections;

  const managementIndex = sections.findIndex((section) => section.title === 'Management');
  const insertAt = managementIndex >= 0 ? managementIndex : sections.length;
  const folderSection: NavSection = {
    title: 'Folders',
    items: folderItems,
  };

  return [...sections.slice(0, insertAt), folderSection, ...sections.slice(insertAt)];
}

interface NavConfig {
  path: string;
  sections: NavSection[];
}

const DEMO_FOLDER_MODEL_ENABLED = isFrontendOnlyDemo();

/** Workflow sidebar order when WORKFLOW_NAV_V6 is enabled; urgent sorts separately. */
const HOTEL_PRIMARY_NAV_ORDER = HOTEL_WORKFLOW_PRIMARY_SLUGS;

/** Current sidebar remains legacy until WORKFLOW_NAV_V6 is enabled. */
const LEGACY_DEMO_PRIMARY_NAV_ORDER = HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS;

function getDemoMailFolderNavSortIndex(
  folderId: DemoMailFolderId,
  workflowNav: boolean,
): number {
  if (folderId === 'urgent') return -1;
  const primaryOrder = workflowNav ? HOTEL_PRIMARY_NAV_ORDER : LEGACY_DEMO_PRIMARY_NAV_ORDER;
  const primaryIndex = (primaryOrder as readonly string[]).indexOf(folderId);
  if (primaryIndex >= 0) return primaryIndex;
  return primaryOrder.length;
}

function getDemoMailFolderIcon(folderId: DemoMailFolderId): ComponentType<SVGProps<SVGSVGElement>> {
  if (folderId === 'urgent' || folderId === 'spam') return ExclamationCircle;
  return Folder;
}

function getDemoMailFolderNavItemTheme(
  folderId: DemoMailFolderId,
): Pick<NavItem, 'style' | 'className'> {
  return getHotelFolderNavTheme(folderId);
}

export function buildDemoMailFolderNavItems(
  workflowNav: boolean = WORKFLOW_NAV_V6,
): NavItem[] {
  const definitions = workflowNav
    ? WORKFLOW_MAIL_FOLDER_DEFINITIONS
    : DEMO_MAIL_FOLDER_DEFINITIONS;
  return definitions
    .filter((folder) => folder.id !== 'spam')
    .sort(
      (a, b) =>
        getDemoMailFolderNavSortIndex(a.id, workflowNav) -
        getDemoMailFolderNavSortIndex(b.id, workflowNav),
    )
    .map((folder) => {
      const theme = getDemoMailFolderNavItemTheme(folder.id);
      return {
        id: folder.id,
        title: folder.title,
        subtitle: folder.subtitle,
        url: `/mail/${folder.id}`,
        icon: getDemoMailFolderIcon(folder.id),
        ...theme,
        className: cn(theme.className),
      };
    });
}

const demoMailFolderNavItems: NavItem[] = buildDemoMailFolderNavItems();

// ! items title has to be a message key (check messages/en.json)
export const navigationConfig: Record<string, NavConfig> = {
  mail: {
    path: '/mail',
    sections: [
      {
        title: 'Core',
        items: [
          {
            id: 'inbox',
            title: m['navigation.sidebar.inbox'](),
            url: '/mail/inbox',
            icon: Inbox,
          },
          {
            id: 'drafts',
            title: m['navigation.sidebar.drafts'](),
            url: '/mail/draft',
            icon: Folder,
          },
          {
            id: 'sent',
            title: m['navigation.sidebar.sent'](),
            url: '/mail/sent',
            icon: Plane2,
          },
        ],
      },
      ...(DEMO_FOLDER_MODEL_ENABLED
        ? [
            {
              title: 'Folders',
              items: demoMailFolderNavItems,
            },
          ]
        : []),
      {
        title: 'Management',
        items: [
          {
            id: 'archive',
            title: m['navigation.sidebar.archive'](),
            url: '/mail/archive',
            icon: Archive,
          },
          {
            id: 'snoozed',
            title: m['navigation.sidebar.snoozed'](),
            url: '/mail/snoozed',
            icon: Clock,
          },
          {
            id: 'trash',
            title: m['navigation.sidebar.bin'](),
            url: '/mail/bin',
            icon: Bin,
          },
          {
            id: 'spam',
            title: m['navigation.sidebar.spam'](),
            url: '/mail/spam',
            icon: ExclamationCircle,
          },
        ],
      },
    ],
  },
  settings: {
    path: '/settings',
    sections: [
      {
        title: 'Settings',
        items: [
          {
            title: m['common.actions.back'](),
            url: '/mail',
            icon: ArrowLeft,
            isBackButton: true,
          },

          {
            title: m['navigation.settings.general'](),
            url: '/settings/general',
            icon: SettingsGear,
          },
          {
            title: m['navigation.settings.privacy'](),
            url: '/settings/privacy',
            icon: LockIcon,
          },
          {
            title: m['navigation.settings.appearance'](),
            url: '/settings/appearance',
            icon: Stars,
          },
          {
            title: m['navigation.settings.categories'](),
            url: '/settings/categories',
            icon: Tabs,
            disabled: true,
            hidden: true,
          },
          {
            title: m['navigation.settings.shortcuts'](),
            url: '/settings/shortcuts',
            icon: Tabs,
          },
          {
            title: m['navigation.settings.deleteAccount'](),
            url: '/settings/danger-zone',
            icon: Danger,
            disabled: true,
            hidden: true,
          },
          {
            id: 'admin-dashboard',
            title: 'Admin dashboard',
            url: '/settings/admin-dashboard',
            icon: ShieldCheck,
            hidden: true,
          },
        ].map((item) => ({
          ...item,
          isSettingsPage: true,
        })),
      },
    ],
  },
};

export const bottomNavItems = [
  {
    title: '',
    items: [
      {
        id: 'admin-dashboard',
        title: 'Admin dashboard',
        url: '/settings/admin-dashboard',
        icon: ShieldCheck,
        hidden: true,
      },
      {
        id: 'settings',
        title: m['navigation.sidebar.settings'](),
        url: '/settings/general',
        icon: SettingsGear,
        isSettingsButton: true,
      },
    ],
  },
];
