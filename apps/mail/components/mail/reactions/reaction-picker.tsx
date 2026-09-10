import React, { useState } from 'react';
import { Smile } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const OUTLOOK_REACTIONS = [
  { emoji: '👍', label: 'Like' },
  { emoji: '❤️', label: 'Love' },
  { emoji: '🎉', label: 'Celebrate' },
  { emoji: '😆', label: 'Laugh' },
  { emoji: '😮', label: 'Surprised' },
  { emoji: '😢', label: 'Sad' },
] as const;

export type OutlookReactionEmoji = (typeof OUTLOOK_REACTIONS)[number]['emoji'];

export interface ReactionPickerProps {
  onSelectEmoji: (emoji: string) => void;
  activeEmojis?: string[];
  className?: string;
  disabled?: boolean;
}

export const ReactionPicker: React.FC<ReactionPickerProps> = ({
  onSelectEmoji,
  activeEmojis = [],
  className,
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);

  const handleSelect = (emoji: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelectEmoji(emoji);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Add reaction"
              onClick={(e) => {
                e.stopPropagation();
              }}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring dark:text-[#9B9B9B] dark:hover:bg-[#3D3D3D] dark:hover:text-white',
                open && 'bg-gray-100 text-foreground dark:bg-[#3D3D3D] dark:text-white',
                disabled && 'pointer-events-none opacity-50',
                className,
              )}
            >
              <Smile className="h-4 w-4" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Add reaction</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="z-50 w-auto rounded-full border border-border bg-white px-2 py-1 shadow-lg dark:border-[#424242] dark:bg-[#252525]"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          role="toolbar"
          aria-label="Reaction options"
          className="flex items-center gap-1"
        >
          {OUTLOOK_REACTIONS.map(({ emoji, label }) => {
            const isActive = activeEmojis.includes(emoji);
            return (
              <Tooltip key={emoji}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="button"
                    aria-label={label}
                    onClick={(e) => handleSelect(emoji, e)}
                    className={cn(
                      'relative flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-125 focus:outline-none focus:ring-1 focus:ring-blue-500',
                      isActive &&
                        'bg-blue-100 ring-2 ring-blue-500 ring-offset-1 dark:bg-blue-900/60 dark:ring-offset-[#252525]',
                    )}
                  >
                    <span className="select-none leading-none">{emoji}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default ReactionPicker;
