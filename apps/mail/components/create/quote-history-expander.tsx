import React, { useState, useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { formatOutlookHeaderDate } from '@/lib/mail/outlook-quote-formatter';
import { useTimezone } from '@/hooks/use-timezone';
import { cleanHtml } from '@/lib/email-utils';
import type { ParsedMessage } from '@/types';

export interface QuoteHistoryExpanderProps {
  replyToMessage?: ParsedMessage | null;
  isExcluded?: boolean;
  onExcludeChange?: (excluded: boolean) => void;
  className?: string;
}

export function QuoteHistoryExpander({
  replyToMessage,
  isExcluded = false,
  onExcludeChange,
  className = '',
}: QuoteHistoryExpanderProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const timezone = useTimezone();

  const senderDisplay = useMemo(() => {
    if (!replyToMessage?.sender) return 'Unknown Sender';
    const name = replyToMessage.sender.name?.trim() || '';
    const email = replyToMessage.sender.email?.trim() || '';
    if (name && name !== email) {
      return `${name} <${email}>`;
    }
    return email || name || 'Unknown Sender';
  }, [replyToMessage?.sender]);

  const dateDisplay = useMemo(() => {
    if (!replyToMessage?.receivedOn) return '';
    return formatOutlookHeaderDate(replyToMessage.receivedOn, timezone);
  }, [replyToMessage?.receivedOn, timezone]);

  const toDisplay = useMemo(() => {
    if (!replyToMessage?.to || replyToMessage.to.length === 0) return '';
    return replyToMessage.to
      .map((r) => (r.name && r.name !== r.email ? `${r.name} <${r.email}>` : r.email || r.name))
      .filter(Boolean)
      .join('; ');
  }, [replyToMessage?.to]);

  const ccDisplay = useMemo(() => {
    if (!replyToMessage?.cc || replyToMessage.cc.length === 0) return '';
    return replyToMessage.cc
      .map((r) => (r.name && r.name !== r.email ? `${r.name} <${r.email}>` : r.email || r.name))
      .filter(Boolean)
      .join('; ');
  }, [replyToMessage?.cc]);

  const cleanBody = useMemo(() => {
    const raw = replyToMessage?.decodedBody || replyToMessage?.body || '';
    return cleanHtml(raw);
  }, [replyToMessage?.decodedBody, replyToMessage?.body]);

  if (!replyToMessage) {
    return null;
  }

  if (isExcluded) {
    return (
      <div className={`my-2 flex items-center gap-2 text-xs text-muted-foreground ${className}`}>
        <span>Quoted message removed from this reply.</span>
        <button
          type="button"
          onClick={() => onExcludeChange?.(false)}
          className="text-primary underline hover:opacity-80 transition-opacity font-medium cursor-pointer"
        >
          Undo
        </button>
      </div>
    );
  }

  if (!isExpanded) {
    return (
      <div className={`my-2 flex items-center ${className}`}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="quote-expander-collapsed"
                aria-label="Expand header and show message history"
                className="h-6 w-8 rounded border border-border/80 bg-muted/30 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                onClick={() => setIsExpanded(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setIsExpanded(true);
                  }
                }}
              >
                <span className="text-base leading-none font-bold tracking-widest select-none">⋯</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Expand header and show message history
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  return (
    <div
      data-testid="quote-expander-expanded"
      className={`mt-3 space-y-3 rounded-lg border border-border/70 bg-background/60 p-3 text-xs ${className}`}
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Message History</span>
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsExpanded(false);
              }
            }}
            className="text-xs text-muted-foreground hover:text-foreground underline cursor-pointer"
          >
            Hide history
          </button>
        </div>
        <button
          type="button"
          onClick={() => onExcludeChange?.(true)}
          className="text-xs text-destructive hover:underline cursor-pointer font-medium"
        >
          Remove quote
        </button>
      </div>

      <div className="space-y-1 font-sans text-xs text-foreground/90 border-l-2 border-border pl-2.5">
        <div>
          <span className="font-semibold text-muted-foreground">From: </span>
          <span>{senderDisplay}</span>
        </div>
        <div>
          <span className="font-semibold text-muted-foreground">Sent: </span>
          <span>{dateDisplay}</span>
        </div>
        {toDisplay ? (
          <div>
            <span className="font-semibold text-muted-foreground">To: </span>
            <span>{toDisplay}</span>
          </div>
        ) : null}
        {ccDisplay ? (
          <div>
            <span className="font-semibold text-muted-foreground">Cc: </span>
            <span>{ccDisplay}</span>
          </div>
        ) : null}
        <div>
          <span className="font-semibold text-muted-foreground">Subject: </span>
          <span>{replyToMessage.subject || '(No subject)'}</span>
        </div>
      </div>

      <div
        className="max-h-60 overflow-y-auto rounded border border-border/50 bg-background/90 p-2.5 text-xs text-foreground/80 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: cleanBody }}
      />
    </div>
  );
}
