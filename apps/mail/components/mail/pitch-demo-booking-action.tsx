import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PITCH_DEMO_LOADING_MS, PITCH_DEMO_VIDEO_URL } from '@/lib/pitch-demo/config';

type BookingActionState = 'idle' | 'loading' | 'playing';

export function PitchDemoBookingAction() {
  const [state, setState] = useState<BookingActionState>('idle');
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (state !== 'loading') return;
    const timer = window.setTimeout(() => setState('playing'), PITCH_DEMO_LOADING_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === 'playing') {
    return (
      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-black/95">
        {videoFailed ? (
          <div className="text-muted-foreground flex aspect-video items-center justify-center p-6 text-sm">
            HMS automation recording unavailable. Re-deploy with demo video asset.
          </div>
        ) : (
          <video
            className="aspect-video w-full"
            src={PITCH_DEMO_VIDEO_URL}
            autoPlay
            muted
            playsInline
            controls
            onError={() => setVideoFailed(true)}
            data-testid="pitch-demo-rpa-video"
          />
        )}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        size="sm"
        className={cn('gap-2', state === 'loading' && 'pointer-events-none')}
        disabled={state === 'loading'}
        onClick={() => setState('loading')}
        data-testid="pitch-demo-make-booking"
      >
        {state === 'loading' ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Creating reservation in HMS…
          </>
        ) : (
          'Make booking in HMS'
        )}
      </Button>
    </div>
  );
}
