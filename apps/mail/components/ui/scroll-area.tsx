import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  SCROLL_AREA_FLEX_MIN_W_CLASS,
  SCROLL_AREA_VIEWPORT_CONTENT_CLASS,
} from '@/lib/attachment-chip-scroll';
import {
  RADIX_SCROLLBAR_HORIZONTAL_SIZE_CLASS,
  RADIX_SCROLLBAR_VERTICAL_SIZE_CLASS,
} from '@/lib/scrollbar-chrome';

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  hideScrollbar?: boolean;
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, hideScrollbar = false, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    className={cn('relative overflow-hidden', SCROLL_AREA_FLEX_MIN_W_CLASS, className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      ref={ref}
      className={cn(
        'h-full w-full rounded-[inherit]',
        SCROLL_AREA_FLEX_MIN_W_CLASS,
        SCROLL_AREA_VIEWPORT_CONTENT_CLASS,
      )}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar hideScrollbar={hideScrollbar} />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

interface ScrollBarProps
  extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> {
  hideScrollbar?: boolean;
}

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  ScrollBarProps
>(({ className, orientation = 'vertical', hideScrollbar = false, ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      hideScrollbar && 'opacity-0',
      orientation === 'vertical' &&
        cn('h-full border-l border-l-transparent p-px', RADIX_SCROLLBAR_VERTICAL_SIZE_CLASS),
      orientation === 'horizontal' &&
        cn(
          'flex-col border-t border-t-transparent p-px',
          RADIX_SCROLLBAR_HORIZONTAL_SIZE_CLASS,
        ),
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
