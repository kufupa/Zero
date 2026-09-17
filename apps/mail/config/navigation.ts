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
  HOTEL_WORKFLOW_PRIMARY_SLUGS,
} from '@/lib/mail/hotel-folder-presentation';
import { WORKFLOW_MAIL_FOLDER_DEFINITIONS, type DemoMailFolderId } from '@/lib/demo/folder-map';
import { PILOT_CAPABILITIES } from '@/lib/pilot/capabilities';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import type { ComponentType, SVGProps } from 'react';
import { ShieldCheck, Upload, Download } from 'lucide-react';
import type { CSSProperties } from 'react';
import { m } from '@/paraglide/messages';

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
};

function getWorkflowNavSortIndex(slug: string): number {
  if (slug === 'urgent') return -1;
  return HOTEL_WORKFLOW_PRIMARY_SLUGS.indexOf(
    slug as (typeof HOTEL_WORKFLOW_PRIMARY_SLUGS)[number],
  );
}

export function buildLiveCategoryNavItems(categories: LiveCategoryNavInput[]): NavItem[] {
  const visibleCategories = categories.filter((category) => {
    const slug = category.slug.trim().toLowerCase();
    if (slug === 'spam') return false;
    return (
      HOTEL_WORKFLOW_PRIMARY_SLUGS.includes(
        slug as (typeof HOTEL_WORKFLOW_PRIMARY_SLUGS)[number],
      ) || slug === 'urgent'
    );
  });

  return [...visibleCategories]
    .sort(
      (a, b) =>
        getWorkflowNavSortIndex(a.slug.trim().toLowerCase()) -
        getWorkflowNavSortIndex(b.slug.trim().toLowerCase()),
    )
    .map((category) => {
      const slug = category.slug.trim().toLowerCase();
      const presentation = getHotelFolderPresentation(slug);

      return {
        id: category.slug,
        title: presentation?.title ?? category.name,
        subtitle: presentation?.subtitle,
        url: `/mail/${category.slug}`,
        icon: Folder,
        ...getHotelFolderNavTheme(slug),
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

  const folderItems = buildLiveCategoryNavItems(categories);
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

function getDemoMailFolderIcon(folderId: DemoMailFolderId): ComponentType<SVGProps<SVGSVGElement>> {
  if (folderId === 'urgent' || folderId === 'spam') return ExclamationCircle;
  return Folder;
}

export function buildDemoMailFolderNavItems(): NavItem[] {
  return WORKFLOW_MAIL_FOLDER_DEFINITIONS.filter((folder) => folder.id !== 'spam')
    .sort((a, b) => getWorkflowNavSortIndex(a.id) - getWorkflowNavSortIndex(b.id))
    .map((folder) => {
      return {
        id: folder.id,
        title: folder.title,
        subtitle: folder.subtitle,
        url: `/mail/${folder.id}`,
        icon: getDemoMailFolderIcon(folder.id),
        ...getHotelFolderNavTheme(folder.id),
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
          {
            id: 'catchup-upload',
            title: 'Upload backup',
            url: '/settings/catchup-upload',
            icon: Archive,
            hidden: true,
          },
          {
            id: 'outlook-addin',
            title: 'Outlook add-in',
            url: '/settings/outlook-addin',
            icon: Download,
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
      {
        id: 'catchup-upload',
        title: 'Upload backup',
        url: '/settings/catchup-upload',
        icon: Upload,
        hidden: true,
      },
    ],
  },
];
