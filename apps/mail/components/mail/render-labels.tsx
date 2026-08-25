import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useSearchValue } from '@/hooks/use-search-value';
import type { Label } from '@/types';
import { labelColorStyles } from '@/lib/label-colors';
import { cn } from '@/lib/utils';
import {
  EMPTY_SEARCH_VALUE,
  MAX_EFFECTIVE_SEARCH_LENGTH,
  SEARCH_QUERY_TOO_LONG_MESSAGE,
} from '@/lib/mail/search-list';
import * as React from 'react';
import { toast } from 'sonner';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelSearchToken(labelName: string): string {
  if (!/\s/.test(labelName)) return `label:${labelName}`;
  if (!labelName.includes('"')) return `label:"${labelName}"`;
  if (!labelName.includes("'")) return `label:'${labelName}'`;
  return `label:${labelName}`;
}

function hasLabelSearchToken(query: string, labelName: string): boolean {
  const token = labelSearchToken(labelName);
  return new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`).test(query);
}

function removeLabelSearchToken(query: string, labelName: string): string {
  const token = labelSearchToken(labelName);
  return query
    .replace(new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`, 'g'), '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export const RenderLabels = ({ count = 1, labels }: { count?: number; labels: Label[] }) => {
  const [searchValue, setSearchValue] = useSearchValue();
  const handleFilterByLabel = (label: Label) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const existingValue = searchValue.value;
    if (hasLabelSearchToken(existingValue, label.name)) {
      setSearchValue({
        ...EMPTY_SEARCH_VALUE,
        value: removeLabelSearchToken(existingValue, label.name),
      });
      return;
    }
    const token = labelSearchToken(label.name);
    const newValue = existingValue ? `${existingValue} ${token}` : token;
    if (newValue.length > MAX_EFFECTIVE_SEARCH_LENGTH) {
      toast.error(SEARCH_QUERY_TOO_LONG_MESSAGE);
      return;
    }
    setSearchValue({
      ...EMPTY_SEARCH_VALUE,
      value: newValue,
    });
  };

  if (!labels.length) return null;

  const visibleLabels = labels.slice(0, count);
  const hiddenLabels = labels.slice(count);

  return (
    <div className="flex gap-1">
      {visibleLabels.map((label) => (
        <button
          key={label.id}
          onClick={handleFilterByLabel(label)}
          className={cn(
            'inline-block overflow-hidden truncate rounded bg-[#E8DEFD] px-1.5 py-0.5 text-xs font-medium text-[#2C2241] dark:bg-[#2C2241] dark:text-[#E8DEFD]',
            hasLabelSearchToken(searchValue.value, label.name) && 'border-white',
          )}
          style={labelColorStyles(label.color)}
        >
          {label.name}
        </button>
      ))}
      {hiddenLabels.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-foreground dark:bg-subtleBlack bg-subtleWhite inline-block overflow-hidden truncate rounded px-1.5 py-0.5 text-xs font-medium cursor-pointer">
              +{hiddenLabels.length}
            </button>
          </TooltipTrigger>
          <TooltipContent className="z-99 flex gap-1 px-1 py-1" side="top" align="end">
            {hiddenLabels.map((label) => (
              <button
                key={label.id}
                onClick={handleFilterByLabel(label)}
                className={cn(
                  'inline-block overflow-hidden truncate rounded bg-[#E8DEFD] px-1.5 py-0.5 text-xs font-medium text-[#2C2241] dark:bg-[#2C2241] dark:text-[#E8DEFD]',
                  hasLabelSearchToken(searchValue.value, label.name) && 'border-white',
                )}
                style={labelColorStyles(label.color)}
              >
                {label.name}
              </button>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
