import React from 'react';
import type { MessageReactionGroup } from '@/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ReactorPopoverProps {
  group: MessageReactionGroup;
  children: React.ReactNode;
  className?: string;
}

function getInitials(name?: string | null, email?: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email && email.trim()) {
    const local = email.split('@')[0];
    return local.slice(0, 2).toUpperCase();
  }
  return '??';
}

/**
 * Reactor details popover matching Microsoft Outlook (Screenshot 4).
 * Lists everyone who reacted with a specific emoji along with their avatar initials.
 */
export const ReactorPopover: React.FC<ReactorPopoverProps> = ({
  group,
  children,
  className,
}) => {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className={cn(
          'z-50 w-64 rounded-lg border border-border bg-white p-3 shadow-lg dark:border-[#424242] dark:bg-[#252525]',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between border-b border-border pb-2 dark:border-[#3D3D3D]">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Reactions
          </div>
          <span className="text-sm select-none">{group.emoji}</span>
        </div>

        <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
          {group.users.map((user, idx) => {
            const displayName = user.userName || user.email;
            const initials = getInitials(user.userName, user.email);

            return (
              <div
                key={`${user.email}-${idx}`}
                className="flex items-center justify-between gap-2.5 rounded-md p-1.5 text-sm transition-colors hover:bg-gray-100 dark:hover:bg-[#333333]"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0078D4] text-xs font-semibold text-white select-none"
                    aria-hidden="true"
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1 truncate">
                    <div className="truncate text-xs font-medium text-foreground">
                      {displayName}
                    </div>
                    {user.userName && user.userName !== user.email && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        {user.email}
                      </div>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-base select-none">{group.emoji}</span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default ReactorPopover;
