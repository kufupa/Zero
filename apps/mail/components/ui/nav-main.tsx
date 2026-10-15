import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from './sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { LabelDialog } from '@/components/labels/label-dialog';
import { useActiveConnection } from '@/hooks/use-connections';
import { useResetSearchValue } from '@/hooks/use-search-value';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Intercom, { show } from '@intercom/messenger-js-sdk';
import { MessageSquare, OldPhone } from '../icons/icons';
import { useSidebar } from '../context/sidebar-context';
import { useTRPC } from '@/providers/query-provider';
import { type NavItem } from '@/config/navigation';
import type { Label as LabelType } from '@/types';
import { serializeLabelColor } from '@/lib/label-colors';
import {
  MY_FOLDERS_SIDEBAR_TITLE,
  shouldShowMyFoldersCreate,
} from '@/lib/mail/my-folders-nav';
import { Link, useLocation } from 'react-router';
import { m } from '../../paraglide/messages.js';
import { Button } from '@/components/ui/button';
import { useLabels } from '@/hooks/use-labels';
import { Badge } from '@/components/ui/badge';
import SidebarLabels from './sidebar-labels';
import { useCallback, useRef } from 'react';
import { shouldShowSupportLinks } from '@/lib/demo/support-links';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { ChevronRight, Plus, CheckCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import * as React from 'react';
import type { SidebarUnreadCountSnapshot } from '@/lib/mail/sidebar-unread-counts';
import { getNavUnreadCount } from '@/lib/mail/sidebar-unread-counts';
import { useCategorySettings } from '@/hooks/use-categories';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { markFolderAsReadInContext } from '@/components/context/label-sidebar-context';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  ref?: React.Ref<SVGSVGElement>;
  startAnimation?: () => void;
  stopAnimation?: () => void;
}
interface NavItemProps extends NavItem {
  isActive?: boolean;
  isExpanded?: boolean;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  suffix?: React.ComponentType<IconProps>;
  isSettingsPage?: boolean;
  subtitle?: string;
  badgeTooltip?: string;
  categoryId?: string;
}

interface NavMainProps {
  items: {
    title: string;
    items: NavItemProps[];
    isActive?: boolean;
  }[];
  unreadCountsSnapshot?: SidebarUnreadCountSnapshot;
}

type IconRefType = SVGSVGElement & {
  startAnimation?: () => void;
  stopAnimation?: () => void;
};

export function NavMain({ items, unreadCountsSnapshot }: NavMainProps) {
  const location = useLocation();
  const pathname = location.pathname;
  const searchParams = new URLSearchParams(location.search);
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const categorySettings = useCategorySettings();

  const categoryIdBySlug = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categorySettings) {
      if (cat.slug && cat.id) {
        map.set(cat.slug, cat.id);
      }
    }
    return map;
  }, [categorySettings]);

  const trpc = useTRPC();
  const { data: intercomToken } = useQuery(
    trpc.user.getIntercomToken.queryOptions(void 0, {
      enabled: !frontendOnlyDemo,
    }),
  );

  React.useEffect(() => {
    if (intercomToken) {
      Intercom({
        app_id: 'aavenrba',
        intercom_user_jwt: intercomToken,
      });
    }
  }, [intercomToken]);

  const { mutateAsync: createLabel } = useMutation(trpc.labels.create.mutationOptions());

  const { userLabels, refetch } = useLabels();

  const { state } = useSidebar();

  // Check if these are bottom navigation items by looking at the first section's title
  const isBottomNav = items[0]?.title === '';
  const isMailSidebar = !isBottomNav && !pathname.includes('/settings');
  const showSupportLinks = isBottomNav && shouldShowSupportLinks();

  /**
   * Validates URLs to prevent open redirect vulnerabilities.
   * Only allows two types of URLs:
   * 1. Absolute paths that start with '/' (e.g., '/mail', '/settings')
   * 2. Full URLs that match our application's base URL
   *
   * @param url - The URL to validate
   * @returns boolean - True if the URL is internal and safe to use
   */
  const isValidInternalUrl = useCallback((url: string) => {
    if (!url) return false;
    // Accept absolute paths as they are always internal
    if (url.startsWith('/')) return true;
    try {
      const urlObj = new URL(url, window.location.origin);
      // Prevent redirects to external domains by checking against our base URL
      return urlObj.origin === window.location.origin;
    } catch {
      return false;
    }
  }, []);

  const sanitizeFrom = useCallback(
    (rawFrom: string | null) => {
      if (!rawFrom) return null;

      let decodedFrom = rawFrom;
      try {
        decodedFrom = decodeURIComponent(rawFrom);
      } catch {
        return null;
      }

      if (!decodedFrom || decodedFrom === 'undefined' || decodedFrom === 'null') return null;

      let normalizedFrom = decodedFrom.startsWith('/') ? decodedFrom : `/${decodedFrom}`;

      if (normalizedFrom.startsWith('/settings/undefined/')) {
        normalizedFrom = `/${normalizedFrom.slice('/settings/undefined/'.length)}`;
      }

      if (normalizedFrom.startsWith('/undefined/')) {
        normalizedFrom = `/${normalizedFrom.slice('/undefined/'.length)}`;
      }

      if (normalizedFrom === '/undefined' || normalizedFrom === '/null') return null;

      if (isValidInternalUrl(normalizedFrom)) {
        return normalizedFrom;
      }

      return null;
    },
    [isValidInternalUrl],
  );

  const getHref = useCallback(
    (item: NavItemProps) => {
      // Get the current 'from' parameter
      const currentFrom = sanitizeFrom(searchParams.get('from'));

      // Handle settings navigation
      if (item.isSettingsButton) {
        // Include current path with category query parameter if present
        const currentPath = pathname;
        return `${item.url}?from=${encodeURIComponent(currentPath)}`;
      }

      // Handle back button with redirect protection
      if (item.isBackButton) {
        if (currentFrom) {
          if (isValidInternalUrl(currentFrom)) {
            return currentFrom;
          }
        }
        // Fall back to safe default if URL is missing or invalid
        return '/mail';
      }

      // Handle settings pages navigation
      if (item.isSettingsPage && currentFrom) {
        // Validate and sanitize the 'from' parameter to prevent open redirects
        if (isValidInternalUrl(currentFrom)) {
          return `${item.url}?from=${encodeURIComponent(currentFrom)}`;
        }
        // Fall back to safe default if URL validation fails
        return `${item.url}?from=/mail`;
      }

      return item.url;
    },
    [pathname, searchParams, sanitizeFrom, isValidInternalUrl],
  );

  const { data: activeAccount } = useActiveConnection();

  const isUrlActive = useCallback(
    (url: string) => {
      const urlObj = new URL(url, window.location.origin);
      const cleanPath = pathname.replace(/\/$/, '');
      const cleanUrl = urlObj.pathname.replace(/\/$/, '');

      if (cleanPath !== cleanUrl) return false;

      const urlParams = new URLSearchParams(urlObj.search);
      const currentParams = new URLSearchParams(searchParams);

      for (const [key, value] of urlParams) {
        if (currentParams.get(key) !== value) return false;
      }
      return true;
    },
    [pathname, searchParams],
  );

  const onSubmit = async (data: LabelType) => {
    try {
      const promise = createLabel({
        name: data.name,
        color: serializeLabelColor(data.color),
      }).then(async (result) => {
        await refetch();
        return result;
      });
      
      toast.promise(promise, {
        loading: 'Creating label...',
        success: 'Label created successfully',
        error: 'Failed to create label',
      });
      
      await promise;
    } catch (error) {
      console.error('Failed to create label:', error);
    }
  };

  return (
    <SidebarGroup className={`${state !== 'collapsed' ? '' : 'mt-1'} space-y-2.5 py-0 md:px-0`}>
      <SidebarMenu>
        {showSupportLinks ? (
          <>
            <SidebarMenuButton
              onClick={() => show()}
              tooltip={state === 'collapsed' ? m['common.commandPalette.groups.help']() : undefined}
              className="hover:bg-subtleWhite flex cursor-pointer items-center dark:hover:bg-[#202020]"
            >
              <OldPhone className="relative mr-2.5 h-2 w-2 fill-[#8F8F8F]" />
              <p className="relative bottom-0.5 mt-0.5 truncate text-[13px]">Live Support</p>
            </SidebarMenuButton>
            <NavItem
              key={'feedback'}
              isActive={isUrlActive('https://feedback.0.email')}
              href={'https://feedback.0.email'}
              url={'https://feedback.0.email'}
              icon={MessageSquare}
              target={'_blank'}
              title={m['navigation.sidebar.feedback']()}
            />
          </>
        ) : null}
        {items.map((section) => {
          const isCollapsibleSection = isMailSidebar && Boolean(section.title);
          const sectionItems = (
            <div className="z-20 space-y-1 pb-2">
              {section.items
                .filter((item) => !item.hidden)
                .map((item) => {
                  const categoryId = item.id ? categoryIdBySlug.get(item.id) : undefined;
                  const badge = getNavUnreadCount(unreadCountsSnapshot, item.id, categoryId);
                  const badgeTooltip = unreadCountsSnapshot?.getTooltip(
                    item.id ?? item.title,
                    item.title,
                    categoryId,
                  );
                  return (
                    <NavItem
                      key={item.url}
                      {...item}
                      categoryId={categoryId}
                      badge={badge}
                      badgeTooltip={badgeTooltip}
                      isActive={isUrlActive(item.url)}
                      href={getHref(item)}
                      target={item.target}
                      title={item.title}
                    />
                  );
                })}
            </div>
          );

          return (
            <Collapsible
              key={section.title}
              defaultOpen={isCollapsibleSection || section.isActive}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                {state !== 'collapsed' ? (
                  section.title ? (
                    isCollapsibleSection ? (
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground mx-2 mb-2 flex items-center gap-1 text-[13px] dark:text-[#898989]"
                        >
                          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                          {section.title}
                        </button>
                      </CollapsibleTrigger>
                    ) : (
                      <p className="text-muted-foreground mx-2 mb-2 text-[13px] dark:text-[#898989]">
                        {section.title}
                      </p>
                    )
                  ) : null
                ) : (
                  <div className="bg-muted-foreground/50 mx-2 mb-4 mt-2 h-[0.5px] dark:bg-[#262626]" />
                )}
                {isCollapsibleSection && state !== 'collapsed' ? (
                  <CollapsibleContent>{sectionItems}</CollapsibleContent>
                ) : (
                  sectionItems
                )}
              </SidebarMenuItem>
            </Collapsible>
          );
        })}
        {!pathname.includes('/settings') &&
          !isBottomNav &&
          state !== 'collapsed' &&
          !isFrontendOnlyDemo() && (
          <Collapsible defaultOpen={true} className="group/collapsible flex-col">
            <SidebarMenuItem className="mb-4" style={{ height: 'auto' }}>
              <div className="mx-2 mb-2 flex items-center justify-between">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[13px] dark:text-[#898989]"
                  >
                    <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    {MY_FOLDERS_SIDEBAR_TITLE}
                  </button>
                </CollapsibleTrigger>
                {shouldShowMyFoldersCreate(activeAccount?.providerId) ? (
                  <LabelDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="mr-1 h-4 w-4 p-0 hover:bg-transparent"
                      >
                        <Plus className="text-muted-foreground h-3 w-3 dark:text-[#898989]" />
                      </Button>
                    }
                    onSubmit={onSubmit}
                  />
                ) : null}
              </div>

              <CollapsibleContent>
                {activeAccount ? (
                  <SidebarLabels
                    data={userLabels ?? []}
                    unreadCountsSnapshot={unreadCountsSnapshot}
                  />
                ) : null}
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function NavItem(item: NavItemProps & { href: string }) {
  const iconRef = useRef<IconRefType>(null);
  const resetSearchValue = useResetSearchValue();

  const { state, setOpenMobile } = useSidebar();

  const unreadCount = item.badge;
  const hasUnread = typeof unreadCount === 'number' && unreadCount > 0;
  const badgeTooltip = item.badgeTooltip;
  const unreadText = hasUnread ? (badgeTooltip ?? `${unreadCount} unread`) : undefined;
  const tooltipText = React.useMemo(() => {
    const base = item.subtitle ? `${item.title} — ${item.subtitle}` : item.title;
    if (state === 'collapsed') {
      return unreadText ? `${base}: ${unreadText}` : base;
    }
    // Expanded rows: title-only visible; keep description on hover.
    if (item.subtitle) {
      return unreadText ? `${base}: ${unreadText}` : base;
    }
    return undefined;
  }, [state, item.subtitle, item.title, unreadText]);
  const linkAriaLabel = unreadText ? `${item.title}: ${unreadText}` : undefined;

  if (item.disabled) {
    return (
      <SidebarMenuButton
        tooltip={state === 'collapsed' ? item.title : undefined}
        className="flex cursor-not-allowed items-center opacity-50"
      >
        {item.icon && <item.icon ref={iconRef} className="relative mr-2.5 h-3 w-3.5" />}
        <p className="relative bottom-px mt-0.5 truncate text-[13px]">{item.title}</p>
      </SidebarMenuButton>
    );
  }

  const handleClick = (e: React.MouseEvent) => {
    if (item.onClick) {
      item.onClick(e as React.MouseEvent<HTMLAnchorElement>);
    }
    resetSearchValue();
    setOpenMobile(false);
  };

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { mutateAsync: markFolderAsRead } = useMutation(
    trpc.mail.markFolderAsRead.mutationOptions(),
  );

  const normalizedId = item.id?.trim().toLowerCase();
  const canMarkAsRead =
    Boolean(item.id) &&
    normalizedId !== 'drafts' &&
    normalizedId !== 'draft' &&
    normalizedId !== 'settings' &&
    !item.disabled;

  const handleMarkAllAsRead = () => {
    if (!item.id) return;
    const isCategory = Boolean(item.categoryId);
    const folder = isCategory ? undefined : item.id === 'trash' ? 'bin' : item.id;
    const categoryId = item.categoryId;

    void markFolderAsReadInContext({
      folder,
      categoryId,
      isFrontendOnlyDemoMode: isFrontendOnlyDemo(),
      markAsReadMutation: async (params) => markFolderAsRead(params),
      invalidateQueries: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.queryKey() });
      },
      successMessage: 'Marked all as read',
      errorMessage: 'Failed to mark all as read',
    });
  };

  const itemContent = (
    <Collapsible defaultOpen={item.isActive}>
      <CollapsibleTrigger asChild>
        <SidebarMenuButton
          asChild
          tooltip={tooltipText}
          className={cn(
            'hover:bg-subtleWhite flex items-center dark:hover:bg-[#202020]',
            item.isActive && 'bg-subtleWhite text-accent-foreground dark:bg-[#202020]',
            item.className,
          )}
          style={item.style}
          onClick={handleClick}
        >
          <Link target={item.target} to={item.href} aria-label={linkAriaLabel}>
            {item.icon && <item.icon ref={iconRef} className="mr-2 shrink-0" />}
            <span className="relative bottom-px mt-0.5 min-w-0 flex-1 truncate text-left">
              <span className="block truncate text-[13px] leading-tight">{item.title}</span>
            </span>
            {state !== 'collapsed' && hasUnread && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    title={badgeTooltip}
                    className="ml-auto inline-flex items-center"
                    tabIndex={-1}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Badge className="text-muted-foreground shrink-0 rounded-full border-none bg-transparent">
                      {unreadCount.toLocaleString()}
                    </Badge>
                  </span>
                </TooltipTrigger>
                {badgeTooltip && (
                  <TooltipContent side="right">
                    {badgeTooltip}
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </Link>
        </SidebarMenuButton>
      </CollapsibleTrigger>
    </Collapsible>
  );

  if (!canMarkAsRead) {
    return itemContent;
  }

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{itemContent}</ContextMenuTrigger>
      <ContextMenuContent className="bg-white dark:bg-[#313131]">
        <ContextMenuItem
          asChild
          onClick={handleMarkAllAsRead}
          disabled={false}
          className="gap-2 text-sm cursor-pointer"
        >
          <Button
            size="sm"
            variant="ghost"
            className="hover:bg-black/10 dark:hover:bg-[#404040] [&_svg]:size-3.5"
          >
            <CheckCheck className="text-muted-foreground" />
            <span>Mark all as read</span>
          </Button>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
