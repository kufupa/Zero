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
  Sheet,
  Plane2,
  LockIcon,
  Clock,
} from '@/components/icons/icons';
import { MessageSquareIcon } from 'lucide-react';
import { m } from '@/paraglide/messages';
import { isFrontendOnlyDemo } from '@/lib/runtime/mail-mode';
import {
  getDemoMailFolderSidebarChrome,
  listDemoMailSidebarNavDescriptors,
  type DemoMailFolderId,
} from '@/lib/demo/folder-map';
import { cn } from '@/lib/utils';
import type { CSSProperties } from 'react';

export interface NavItem {
  id?: string;
  title: string;
  subtitle?: string;
  url: string;
  icon: React.ComponentType<any>;
  badge?: number;
  isBackButton?: boolean;
  isSettingsButton?: boolean;
  disabled?: boolean;
  target?: string;
  shortcut?: string;
  style?: CSSProperties;
  className?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface NavConfig {
  path: string;
  sections: NavSection[];
}

const DEMO_FOLDER_MODEL_ENABLED = isFrontendOnlyDemo();

function getDemoMailFolderIcon(folderId: DemoMailFolderId): React.ComponentType<any> {
  if (folderId === 'urgent' || folderId === 'spam') return ExclamationCircle;
  return Folder;
}

const demoMailFolderNavItems: NavItem[] = listDemoMailSidebarNavDescriptors().map((folder) => {
  const chrome = getDemoMailFolderSidebarChrome(folder.id);
  return {
    id: folder.id,
    title: folder.title,
    subtitle: folder.subtitle,
    url: `/mail/${folder.pathSegment}`,
    icon: getDemoMailFolderIcon(folder.id),
    style: chrome.style as CSSProperties | undefined,
    className: cn(
      chrome.className,
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
            title: m['navigation.settings.labels'](),
            url: '/settings/labels',
            icon: Sheet,
          },
          {
            title: m['navigation.settings.categories'](),
            url: '/settings/categories',
            icon: Tabs,
          },
          {
            title: m['navigation.settings.signatures'](),
            url: '/settings/signatures',
            icon: MessageSquareIcon,
            disabled: true,
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
        id: 'settings',
        title: m['navigation.sidebar.settings'](),
        url: '/settings/general',
        icon: SettingsGear,
        isSettingsButton: true,
      },
    ],
  },
];
