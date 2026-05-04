import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { emailProviders } from '@/lib/constants';
import { linkSocialSafe } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/runtime/mail-mode';
import { Plus, UserPlus } from 'lucide-react';
import { useLocation } from 'react-router';
import { m } from '@/paraglide/messages';
import { motion } from 'motion/react';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export const AddConnectionDialog = ({
  children,
  className,
  onOpenChange,
}: {
  children?: React.ReactNode;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) => {
  const pathname = useLocation().pathname;
  const frontendOnlyDemo = isFrontendOnlyDemo();

  const handleLinkSocial = async (providerId: string) => {
    if (frontendOnlyDemo) {
      toast.info('This action is not available in demo mode');
      return;
    }

    try {
      await linkSocialSafe({
        provider: providerId,
        callbackURL: `${window.location.origin}${pathname}`,
      });
    } catch (error) {
      console.error('Error linking account:', error);
      toast.error('Failed to connect account. Please try again.');
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {children || (
          <Button
            size={'dropdownItem'}
            variant={'dropdownItem'}
            className={cn('w-full justify-start gap-2', className)}
          >
            <UserPlus size={16} strokeWidth={2} className="opacity-60" aria-hidden="true" />
            <p className="text-[13px] opacity-60">{m['pages.settings.connections.addEmail']()}</p>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent showOverlay={true}>
        <DialogHeader>
          <DialogTitle>{m['pages.settings.connections.connectEmail']()}</DialogTitle>
          <DialogDescription>
            {m['pages.settings.connections.connectEmailDescription']()}
          </DialogDescription>
        </DialogHeader>
        <motion.div
          className="mt-4 grid grid-cols-2 gap-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          {emailProviders.map((provider, index) => {
            const Icon = provider.icon;
            return (
              <motion.div
                key={provider.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1, duration: 0.3 }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                <Button
                  variant="outline"
                  className="h-24 w-full flex-col items-center justify-center gap-2"
                  onClick={async () => await handleLinkSocial(provider.providerId)}
                >
                  <Icon className="size-6!" />
                  <span className="text-xs">{provider.name}</span>
                </Button>
              </motion.div>
            );
          })}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: emailProviders.length * 0.1, duration: 0.3 }}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
          >
            <Button
              variant="outline"
              className="h-24 w-full flex-col items-center justify-center gap-2 border-dashed"
            >
              <Plus className="h-12 w-12" />
              <span className="text-xs">{m['pages.settings.connections.moreComingSoon']()}</span>
            </Button>
          </motion.div>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
};
