import { canRunQuoteStep, formatQuoteStepInputs } from '@/lib/quote-workflow/session';
import type { QuoteToolStep, QuoteToolStepStatus } from '@/lib/quote-workflow/types';
import { SecondaryButton } from '@/components/nava-pane/pane-ui';

const STEP_STATUS_LABEL: Record<QuoteToolStepStatus, string> = {
  queued: 'Waiting',
  ready: 'Ready',
  running: 'Running…',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Each HMS search with its own Run button, for staff who want one search at a time. The main action,
 * Search availability, sits in the pane.
 */
export function ToolStepList({
  steps,
  runningStepId,
  onRunStep,
  blockReason,
}: {
  steps: QuoteToolStep[];
  runningStepId?: string | null;
  onRunStep?: (stepId: string) => void;
  /** Plain-English reason a runnable step must wait (for example, a PDF is still owed). */
  blockReason?: (step: QuoteToolStep) => string | null;
}) {
  const runnable = (step: QuoteToolStep) => canRunQuoteStep(step, steps, runningStepId ?? null);
  const waitingFor = (step: QuoteToolStep) => (runnable(step) ? blockReason?.(step) ?? null : null);
  // Why a step cannot run, for the muted line under its button. Every disabled button says why.
  const idleReason = (step: QuoteToolStep) => {
    if (step.status === 'succeeded') return 'Already done.';
    if (step.status === 'running' || runningStepId === step.id) return 'Running now.';
    if (!onRunStep) return 'Not available here.';
    if (runningStepId) return 'Another search is running.';
    return 'Waits for an earlier search.';
  };
  if (steps.length === 0) return <p className="text-[11px] text-[#64748b]">Nothing to search yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      {steps.map((step) => {
        const wait = waitingFor(step);
        const enabled = Boolean(onRunStep) && runnable(step) && !wait;
        return (
          <div key={step.id} className="flex flex-col gap-1 border-t border-[#e2e8f0] pt-2 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-[#1e293b]">{step.title}</span>
              <span className="text-[10px] font-bold uppercase text-[#64748b]">{STEP_STATUS_LABEL[step.status] ?? step.status}</span>
            </div>
            {wait ? <p className="text-[11px] text-amber-800">{wait}</p> : null}
            <p className="text-[11px] text-[#64748b]">{formatQuoteStepInputs(step.inputs)}</p>
            <SecondaryButton
              className="self-start"
              disabled={!enabled}
              onClick={() => onRunStep?.(step.id)}
            >
              <span>Run</span>
              <span>{step.title}</span>
            </SecondaryButton>
            {enabled || wait ? null : <p className="text-[11px] text-[#64748b]">{idleReason(step)}</p>}
          </div>
        );
      })}
    </div>
  );
}
