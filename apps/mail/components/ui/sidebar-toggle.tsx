import type { ComponentProps } from 'react';

import { type SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from '../icons/icons';
import { cn } from '@/lib/utils';

export function SidebarToggle({ className }: ComponentProps<typeof SidebarTrigger>) {
  const { toggleSidebar, open, openMobile, isMobile } = useSidebar();
  const isOpen = isMobile ? openMobile : open;
  const label = isOpen ? 'Hide sidebar' : 'Show sidebar';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          onClick={toggleSidebar}
          variant="ghost"
          size="icon"
          aria-expanded={isOpen}
          aria-label={label}
          data-state={isOpen ? 'expanded' : 'collapsed'}
          className={cn(
            'border-none bg-transparent hover:bg-accent/50 h-10 w-10 rounded-lg transition-colors duration-150 md:px-2',
            className,
          )}
        >
          {isOpen ? (
            <ChevronLeft className="h-3 w-3 dark:fill-iconDark fill-iconLight" />
          ) : (
            <ChevronRight className="h-3 w-3 dark:fill-iconDark fill-iconLight" />
          )}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
