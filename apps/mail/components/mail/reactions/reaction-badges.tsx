import React from 'react';
import type { MessageReactionGroup } from '@/types';
import { ReactorPopover } from './reactor-popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ReactionBadgesProps {
  reactions?: MessageReactionGroup[];
  onToggleReaction: (emoji: string) => void;
  className?: string;
}

/**
 * Reaction pill badges rendered directly beneath the message timestamp (Screenshot 1).
 * Supports clicking the emoji to toggle reaction, and clicking/hovering count to view reactors (Screenshot 4).
 */
export const ReactionBadges: React.FC<ReactionBadgesProps> = ({
  reactions = [],
  onToggleReaction,
  className,
}) => {
  const visibleGroups = reactions.filter((g) => g.count > 0);

  if (visibleGroups.length === 0) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label="Message reactions"
      className={cn('mt-1 flex flex-wrap items-center justify-end gap-1.5', className)}
    >
      {visibleGroups.map((group) => {
        const names = group.users
          .map((u) => u.userName || u.email)
          .slice(0, 3)
          .join(', ');
        const tooltipText =
          group.count > 3 ? `${names} and ${group.count - 3} others` : names;

        return (
          <ReactorPopover key={group.emoji} group={group}>
            <div
              className={cn(
                'group inline-flex items-center rounded-full border text-xs font-medium transition-all shadow-xs select-none',
                group.hasReacted
                  ? 'border-[#0078D4] bg-[#E5F1FB] text-[#0078D4] dark:border-[#2886CA] dark:bg-[#103B61] dark:text-[#70B8F5]'
                  : 'border-[#E0E0E0] bg-white text-gray-700 hover:bg-gray-100 dark:border-[#424242] dark:bg-[#2B2B2B] dark:text-[#D4D4D4] dark:hover:bg-[#383838]',
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Toggle ${group.emoji} reaction`}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onToggleReaction(group.emoji);
                    }}
                    className="flex cursor-pointer items-center py-0.5 pl-2 pr-1 text-sm leading-none transition-transform active:scale-90 hover:scale-110"
                  >
                    <span>{group.emoji}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {group.hasReacted ? `Remove ${group.emoji}` : `React with ${group.emoji}`}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`View ${group.count} reactions for ${group.emoji}`}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    className="cursor-pointer py-0.5 pl-0.5 pr-2 text-xs font-semibold tabular-nums opacity-90 hover:opacity-100"
                  >
                    {group.count}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {tooltipText} (click to see all)
                </TooltipContent>
              </Tooltip>
            </div>
          </ReactorPopover>
        );
      })}
    </div>
  );
};

export default ReactionBadges;
