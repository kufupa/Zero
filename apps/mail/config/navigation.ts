import type { ComponentType, SVGProps } from 'react';
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
import { ShieldCheck } from 'lucide-react';
import { m } from '@/paraglide/messages';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import {
  DEMO_MAIL_FOLDER_DEFINITIONS,
  getCenturionCategoryColorStyle,
  isCenturionMailCategorySlug,
  type DemoMailFolderId,
} from '@/lib/demo/folder-map';
import { cn } from '@/lib/utils';
import type { CSSProperties } from 'react';
import { PILOT_CAPABILITIES } from '@/lib/pilot/capabilities';
import {
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  isHotelManagedCategorySlug,
} from '@/lib/mail/hotel-folder-presentation';
import { categoryColorNavTheme } from '@/lib/mail/route-filter';

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

export function buildLiveCategoryNavItems(categories: LiveCategoryNavInput[]): NavItem[] {
  return [...categories]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
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
): NavSection[] {
  if (!PILOT_CAPABILITIES.hotelCategories || categories.length === 0) {
    return sections;
  }

  const managementIndex = sections.findIndex((section) => section.title === 'Management');
  const insertAt = managementIndex >= 0 ? managementIndex : sections.length;
  const folderSection: NavSection = {
    title: 'Folders',
    items: buildLiveCategoryNavItems(categories),
  };

  return [...sections.slice(0, insertAt), folderSection, ...sections.slice(insertAt)];
}

interface NavConfig {
  path: string;
  sections: NavSection[];
}

const DEMO_FOLDER_MODEL_ENABLED = isFrontendOnlyDemo();

/** Primary hotel folder sidebar order (urgent overlay sorted separately). */
const HOTEL_PRIMARY_NAV_ORDER = ['at-risk', 'new-bookings', 'groups-events', 'ops'] as const;

function getDemoMailFolderNavSortIndex(folderId: DemoMailFolderId): number {
  if (folderId === 'urgent') return -1;
  const primaryIndex = HOTEL_PRIMARY_NAV_ORDER.indexOf(
    folderId as (typeof HOTEL_PRIMARY_NAV_ORDER)[number],
  );
  if (primaryIndex >= 0) return primaryIndex;
  return HOTEL_PRIMARY_NAV_ORDER.length;
}

function getDemoMailFolderIcon(folderId: DemoMailFolderId): ComponentType<SVGProps<SVGSVGElement>> {
  if (folderId === 'urgent' || folderId === 'spam') return ExclamationCircle;
  return Folder;
}

function getDemoMailFolderNavItemTheme(folderId: DemoMailFolderId): Pick<NavItem, 'style' | 'className'> {
  if (!isCenturionMailCategorySlug(folderId)) {
    return {};
  }

  const palette = getCenturionCategoryColorStyle(folderId);
  return {
    style: {
      '--centurion-sidebar-bg': palette.bg,
      '--centurion-sidebar-text': palette.text,
      '--centurion-sidebar-bg-dark': palette.darkBg,
      '--centurion-sidebar-text-dark': palette.darkText,
    } as CSSProperties,
    className:
      'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
  };
}

const demoMailFolderNavItems: NavItem[] = DEMO_MAIL_FOLDER_DEFINITIONS.filter((folder) => folder.id !== 'spam')
  .sort((a, b) => getDemoMailFolderNavSortIndex(a.id) - getDemoMailFolderNavSortIndex(b.id))
  .map((folder) => {
    const theme = getDemoMailFolderNavItemTheme(folder.id);
    return {
      id: folder.id,
      title: folder.title,
      subtitle: folder.subtitle,
      url: `/mail/${folder.id}`,
      icon: getDemoMailFolderIcon(folder.id),
      ...theme,
      className: cn(
        theme.className,
        folder.id === 'urgent' &&
          "relative after:absolute after:inset-y-1.5 after:right-0 after:w-1 after:rounded-l-sm after:bg-red-500/90 after:content-['']",
      ),
    };
  });

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
