import type { ComponentProps } from 'react';

import { type SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { PanelLeftClose, PanelLeftOpen } from '../icons/icons';
import { cn } from '@/lib/utils';

export function SidebarToggle({ className }: ComponentProps<typeof SidebarTrigger>) {
  const { toggleSidebar, open, state } = useSidebar();
  const label = open ? 'Hide sidebar' : 'Show sidebar';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          onClick={toggleSidebar}
          variant="ghost"
          size="icon"
          aria-expanded={open}
          aria-label={label}
          data-state={state}
          className={cn(
            'border-none bg-transparent hover:bg-accent/50 h-10 w-10 rounded-lg transition-colors duration-150 md:px-2',
            className,
          )}
        >
          {open ? (
            <PanelLeftClose className="dark:fill-iconDark fill-iconLight" />
          ) : (
            <PanelLeftOpen className="dark:fill-iconDark fill-iconLight" />
          )}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
