import {
  CircleCheck,
  ExclamationCircle2,
  ExclamationTriangle,
  InfoCircle,
} from '@/components/icons/icons';
import { Toaster as SonnerToaster } from 'sonner';
import { Loader2 } from 'lucide-react';

const Toaster = () => {
  return (
    <SonnerToaster
      position="bottom-center"
      icons={{
        success: <CircleCheck className="h-4.5 w-4.5 border-none fill-[#36B981]" />,
        error: <ExclamationCircle2 className="h-4.5 w-4.5 fill-[#FF0000]" />,
        warning: <ExclamationTriangle className="h-4.5 w-4.5 fill-[#FFC107]" />,
        info: <InfoCircle className="h-4.5 w-4.5 fill-[#5767fb]" />,
        loading: <Loader2 className="stroke-muted-foreground h-[17px] w-[17px] animate-spin" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          title: 'title flex-1 justify-center text-white! text-sm leading-none',
          description: 'text-white/80! text-xs',
          toast: 'p-1',
          // The toast is a dark pill, so its buttons carry their own light text and a visible focus ring.
          actionButton:
            'inline-flex h-6 items-center justify-between mr-1 gap-1 overflow-hidden rounded-full! px-2.5 text-xs font-semibold text-white! bg-white/15! hover:bg-white/25! focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white pointer-events-auto cursor-pointer',
          cancelButton:
            'inline-flex h-6 items-center justify-between mr-1 gap-1 overflow-hidden rounded-full! px-2.5 text-xs text-white! bg-white/15! hover:bg-white/25! focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white',
          closeButton:
            'inline-flex h-6 items-center justify-between mr-1 gap-1 overflow-hidden rounded-full! px-2.5 text-xs text-white! bg-white/15! hover:bg-white/25! focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white',
          loading: 'pl-3 -mr-3 loading',
          loader: 'pl-3 loader -mr-3',
          icon: 'pl-3 icon mr-2',
          content: 'flex-1 p-1.5 pl-2',
          default:
            'w-full p-1.5 bg-[#1e293b] text-white rounded-full flex items-center gap-2 overflow-visible shadow-md',
        },
      }}
    />
  );
};

export default Toaster;
