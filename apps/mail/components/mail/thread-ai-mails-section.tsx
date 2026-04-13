import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileText } from 'lucide-react';

type ThreadAiMailsSectionProps = {
  title: string;
  summariseLabel: string;
  onSummarise?: () => void;
  children: React.ReactNode;
};

export function ThreadAiMailsSection({
  title,
  summariseLabel,
  onSummarise,
  children,
}: ThreadAiMailsSectionProps) {
  return (
    <section
      className={cn(
        'border-border bg-panelLight/80 dark:bg-panelDark/80 mb-3 rounded-xl border p-3',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {onSummarise ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onSummarise}
          >
            <FileText className="h-3.5 w-3.5" />
            {summariseLabel}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
