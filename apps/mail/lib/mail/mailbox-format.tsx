import type { Sender } from '@/types';

type MailboxInlineProps = {
  sender?: Pick<Sender, 'name' | 'email'> | null;
  className?: string;
};

export const cleanEmailDisplay = (email?: string): string => {
  if (!email) return '';
  const match = email.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  return match ? match[1] : email;
};

export const cleanNameDisplay = (name?: string): string => {
  if (!name) return '';
  return name.trim();
};

export const formatMailboxPlain = (sender?: { name?: string; email?: string }): string => {
  const addr = cleanEmailDisplay(sender?.email);
  const name = cleanNameDisplay(sender?.name);

  if (!addr) return '';
  if (!name || name === addr) return addr;

  return `${name} <${addr}>`;
};

export const MailboxInline = ({ sender, className }: MailboxInlineProps) => {
  const addr = cleanEmailDisplay(sender?.email);
  const name = cleanNameDisplay(sender?.name);

  if (!addr) return null;

  if (!name || name === addr) {
    return (
      <span className={`text-sm text-muted-foreground dark:text-[#8C8C8C] break-all ${className ?? ''}`}>
        {addr}
      </span>
    );
  }

  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className ?? ''}`}>
      <span className="font-semibold">{name}</span>
      <span className="text-sm text-muted-foreground dark:text-[#8C8C8C] break-all">{`<${addr}>`}</span>
    </span>
  );
};

