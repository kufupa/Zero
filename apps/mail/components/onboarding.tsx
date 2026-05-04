import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import confetti from 'canvas-confetti';

type OnboardingBaseStep = {
  title: string;
  description: string;
  bullets: string[];
};

type CarouselStep = OnboardingBaseStep & {
  type: 'carousel';
  visual: {
    icon: string;
    metric: string;
    tone: string;
    gradient: string;
    headline: string;
  };
};

type OnboardingStep = CarouselStep;

const CAROUSEL_STEPS: CarouselStep[] = [
  {
    type: 'carousel',
    title: 'Welcome to Lucein AI',
    description:
      'You are now on a hotel focused inbox. This tour shows your daily reservation workflow from Outlook to AI assisted composing and final human approval.',
    bullets: [
      'You already know your guests. Lucein AI helps you answer faster, safer, and more consistently.',
      'Every draft is review-first so you stay in control.',
    ],
    visual: {
      icon: '🏨',
      metric: 'Reservation-first',
      tone: 'Hotel operations clarity, not marketing fluff.',
      headline: 'From guest question to reply-ready draft in one loop.',
      gradient: 'from-sky-500/70 to-blue-500/90',
    },
  },
  {
    type: 'carousel',
    title: 'The daily reply loop',
    description:
      'For reservation-related emails, Lucein automatically prepares a rough draft using synced booking context, so you can quickly review and send.',
    bullets: [
      'You have full control to make edits and ensure the email sounds like you.',
    ],
    visual: {
      icon: '↪️',
      metric: 'Reservation ready drafting',
      tone: 'Human in the loop at every reply.',
      headline: 'Draft generation is a helper, not an autopilot.',
      gradient: 'from-emerald-500/70 to-green-600/90',
    },
  },
  {
    type: 'carousel',
    title: 'Built for hospitality language',
    description:
      'Lucein AI is tuned for reservation style communication, so your outgoing replies stay courteous and operationally correct.',
    bullets: [
      'Keep tone aligned with your hotel standards.',
      'If you spot issues, use the feedback button in the bottom left, or escalate to your General Manager.',
    ],
    visual: {
      icon: '☕',
      metric: 'Guest-ready phrasing',
      tone: 'Consistent tone without sounding robotic.',
      headline: 'Guests get clear, polite replies; your team keeps luxury quality, not policy.',
      gradient: 'from-amber-500/60 to-rose-500/75',
    },
  },
  {
    type: 'carousel',
    title: 'You stay in the control seat',
    description:
      'This is a powered assistant layer for a live reservation desk: fast recommendations, intentional review, full accountability.',
    bullets: [
      'Never sends automatically unless you hit Send.',
      'You can replay this tour from Help when needed.',
    ],
    visual: {
      icon: '✅',
      metric: 'Human approval enabled',
      tone: 'Speed without losing trust.',
      headline: 'AI drafts, you decide, guests receive your final message.',
      gradient: 'from-indigo-500/70 to-blue-600/90',
    },
  },
];

function buildStepVisual(step: CarouselStep) {
  return (
    <div className={`h-52 w-full overflow-hidden rounded-xl border bg-linear-to-br ${step.visual.gradient} p-4`}>
      <div className="flex h-full flex-col justify-between gap-4 text-white">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] opacity-85">Lucein AI</div>
        <div className="space-y-4">
          <div className="inline-flex items-center gap-3 rounded-full bg-white/20 px-3 py-1.5 text-sm">
            <span className="text-2xl">{step.visual.icon}</span>
            <span>{step.visual.metric}</span>
          </div>
          <h3 className="text-xl font-semibold leading-tight">{step.visual.headline}</h3>
          <p className="text-sm text-white/90">{step.visual.tone}</p>
        </div>
      </div>
    </div>
  );
}

 

type OnboardingDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function OnboardingDialog({
  open,
  onOpenChange,
}: OnboardingDialogProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const activeSteps: OnboardingStep[] = CAROUSEL_STEPS;
  const isFinalStep = currentStep === activeSteps.length - 1;
  const activeStep = activeSteps[currentStep];

  useEffect(() => {
    if (open) {
      setCurrentStep(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (isFinalStep) {
      confetti({
        particleCount: 120,
        spread: 80,
        origin: { y: 0.75 },
      });
    }
  }, [isFinalStep, open]);

  const handleNext = () => {
    if (!isFinalStep) {
      setCurrentStep((step) => step + 1);
      return;
    }

    onOpenChange(false);
  };

  const handleBack = () => {
    setCurrentStep((step) => step - 1);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle></DialogTitle>
      <DialogContent
        showOverlay
        className="bg-panelLight mx-auto w-full max-w-[90%] rounded-xl border p-0 sm:max-w-[760px] dark:bg-[#111111]"
      >
        <div className="flex flex-col gap-6 p-4">
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold">{activeStep.title}</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-[1.25fr_1fr]">
            {buildStepVisual(activeStep)}
            <div>
              <p className="text-sm text-muted-foreground">{activeStep.description}</p>
              <ul className="mt-3 space-y-2 text-sm">
                {activeStep.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-2">
                    <span className="mt-1 inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mx-auto flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="outline" onClick={handleBack} disabled={currentStep === 0}>
                Go back
              </Button>
              <Button size="xs" onClick={handleNext}>
                {isFinalStep ? 'Get Started' : 'Next'}
              </Button>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button size="xs" variant="ghost" onClick={() => onOpenChange(false)}>
                Skip for now
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OnboardingWrapper() {
  const [showOnboarding, setShowOnboarding] = useState(true);

  const handleOpenChange = (open: boolean) => {
    setShowOnboarding(open);
  };

  return (
    <OnboardingDialog
      open={showOnboarding}
      onOpenChange={handleOpenChange}
    />
  );
}
