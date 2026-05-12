import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import confetti from 'canvas-confetti';

type OnboardingBaseStep = {
  title: string;
  description: string;
  eyebrow: string;
};

type CarouselStep = OnboardingBaseStep & {
  type: 'carousel';
  visual: {
    mode: 'hotel' | 'provider' | 'import' | 'workflow' | 'brain';
  };
};

type OnboardingStep = CarouselStep;

const CAROUSEL_STEPS: CarouselStep[] = [
  {
    type: 'carousel',
    eyebrow: 'Step 1 / hotel profile',
    title: 'Connect The Centurion reservation desk',
    description:
      'Nava starts like a real hotel operations platform: property profile, inbox owner, service standard, and the workflows your team already runs manually.',
    visual: {
      mode: 'hotel',
    },
  },
  {
    type: 'carousel',
    eyebrow: 'Step 2 / email provider',
    title: 'Connect Google or Microsoft mail',
    description:
      'The demo is front-end only, but the product story is real: OAuth into Outlook or Gmail, pull historical threads, and keep live inbound mail in sync.',
    visual: {
      mode: 'provider',
    },
  },
  {
    type: 'carousel',
    eyebrow: 'Step 3 / historical import',
    title: 'Import the hotel memory',
    description:
      'Nava reads old replies to learn tone, rate language, release clauses, escalation paths, and which emails always needed a manager.',
    visual: {
      mode: 'import',
    },
  },
  {
    type: 'carousel',
    eyebrow: 'Step 4 / workflow graph',
    title: 'Generate hotel workflows',
    description:
      'Categories become living workflows: individual bookings, group quotes, travel agents, internal ops, and urgent guest recovery.',
    visual: {
      mode: 'workflow',
    },
  },
  {
    type: 'carousel',
    eyebrow: 'Step 5 / AI employee goes live',
    title: 'Every edit trains the company brain',
    description:
      'When a human changes a draft, Nava decides whether it was brand tone, missing source data, or a new workflow edge case, then updates the brain.',
    visual: {
      mode: 'brain',
    },
  },
];

function buildStepVisual(step: CarouselStep) {
  const mode = step.visual.mode;

  return (
    <div className="relative h-72 w-full overflow-hidden rounded-2xl border border-white/40 bg-[radial-gradient(circle_at_18%_18%,rgba(59,130,246,0.22),transparent_28%),linear-gradient(135deg,#f8fafc,#eef6ff_48%,#fff7ed)] p-4 shadow-sm dark:border-white/10 dark:bg-[radial-gradient(circle_at_18%_18%,rgba(59,130,246,0.25),transparent_28%),linear-gradient(135deg,#111827,#0f172a_48%,#1c1917)]">
      <div className="absolute right-4 top-4 rounded-full border border-emerald-300/60 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200">
        Live setup
      </div>
      <div className="flex h-full flex-col justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            Nava AI employee setup
          </div>
          <div className="mt-5 grid gap-3">
            {mode === 'hotel' ? <HotelProfileVisual /> : null}
            {mode === 'provider' ? <ProviderVisual /> : null}
            {mode === 'import' ? <ImportVisual /> : null}
            {mode === 'workflow' ? <WorkflowVisual /> : null}
            {mode === 'brain' ? <BrainVisual /> : null}
          </div>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {CAROUSEL_STEPS.map((item) => (
            <div
              key={item.title}
              className={`h-1.5 rounded-full ${
                item.visual.mode === mode
                  ? 'bg-blue-600 dark:bg-blue-400'
                  : 'bg-slate-200 dark:bg-white/10'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function HotelProfileVisual() {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/85 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">The Centurion Hotel</p>
          <p className="mt-1 text-xs text-muted-foreground">Central reservations · 186 rooms · Pretoria</p>
        </div>
        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-400/10 dark:text-blue-200">
          B2B pilot
        </span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        {['4 min SLA', 'Warm formal tone', 'Manager exceptions'].map((item) => (
          <div key={item} className="rounded-xl border bg-slate-50 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderVisual() {
  return (
    <div className="grid gap-3">
      {[
        ['Microsoft 365', 'centurion@legacyhotels.co.za', 'Connected'],
        ['Google Workspace', 'sales@legacyhotels.co.za', 'Available'],
      ].map(([provider, account, status]) => (
        <div key={provider} className="flex items-center justify-between rounded-2xl border border-white/70 bg-white/85 p-3 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10">
          <div>
            <p className="text-sm font-semibold">{provider}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{account}</p>
          </div>
          <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-950">
            {status}
          </span>
        </div>
      ))}
    </div>
  );
}

function ImportVisual() {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/85 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold">Historical email import</span>
        <span className="text-blue-600 dark:text-blue-300">18,420 threads</span>
      </div>
      <div className="mt-3 h-2 rounded-full bg-slate-200 dark:bg-white/10">
        <div className="h-2 w-[86%] rounded-full bg-blue-600 dark:bg-blue-400" />
      </div>
      <div className="mt-4 grid gap-2 text-xs">
        {['Tone examples found', 'Rate clauses extracted', 'Manager approvals detected'].map((item) => (
          <div key={item} className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkflowVisual() {
  const items = ['Individual', 'Groups', 'Travel agents', 'Internal', 'Urgent'];

  return (
    <div className="rounded-2xl border border-white/70 bg-white/85 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10">
      <p className="text-sm font-semibold">Detected operational workflows</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {items.map((item, index) => (
          <span
            key={item}
            className="rounded-full border bg-slate-50 px-3 py-1.5 text-xs font-medium dark:border-white/10 dark:bg-white/5"
          >
            {index + 1}. {item}
          </span>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-center text-[11px]">
        <span className="rounded-xl bg-blue-50 px-2 py-2 text-blue-700 dark:bg-blue-400/10 dark:text-blue-200">Trigger</span>
        <span className="text-muted-foreground">→</span>
        <span className="rounded-xl bg-amber-50 px-2 py-2 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200">API lookup</span>
        <span className="text-muted-foreground">→</span>
        <span className="rounded-xl bg-emerald-50 px-2 py-2 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200">Draft</span>
      </div>
    </div>
  );
}

function BrainVisual() {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/85 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Edit analyzed</p>
          <p className="mt-1 text-xs text-muted-foreground">Human changed release clause order.</p>
        </div>
        <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
          Workflow updated
        </span>
      </div>
      <div className="mt-4 rounded-xl border border-dashed border-blue-300 bg-blue-50/70 p-3 text-xs text-blue-900 dark:border-blue-300/30 dark:bg-blue-400/10 dark:text-blue-100">
        Add node: “For group overflow requests, show 48-hour release clause before total price.”
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
      <DialogContent showOverlay className="bg-panelLight mx-auto w-full max-w-[92%] rounded-2xl border p-0 sm:max-w-[860px] dark:bg-[#111111]">
        <div className="flex flex-col gap-6 p-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-300">
              {activeStep.eyebrow}
            </p>
            <h2 className="text-3xl font-semibold tracking-tight">{activeStep.title}</h2>
          </div>
          <div className="grid gap-5 md:grid-cols-[1.25fr_0.9fr]">
            {buildStepVisual(activeStep)}
            <div className="flex flex-col justify-between gap-4">
              <div>
                <p className="text-sm leading-6 text-muted-foreground">{activeStep.description}</p>
                <div className="mt-5 rounded-2xl border bg-background/60 p-4 dark:bg-white/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Demo promise
                  </p>
                  <p className="mt-2 text-sm font-medium leading-6">
                    This is not another inbox skin. It is the training ground for AI employees that learn hotel operations from every handled email.
                  </p>
                </div>
              </div>
              <div className="grid gap-2 text-xs text-muted-foreground">
                <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                  <span>Historical threads analyzed</span>
                  <span className="font-semibold text-foreground">18.4k</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                  <span>Workflows generated</span>
                  <span className="font-semibold text-foreground">5</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                  <span>Human review stays on</span>
                  <span className="font-semibold text-foreground">exceptions</span>
                </div>
              </div>
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
