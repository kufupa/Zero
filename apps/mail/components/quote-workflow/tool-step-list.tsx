import { canRunQuoteStep, formatQuoteStepInputs } from '@/lib/quote-workflow/session';
import type { QuoteToolStep, QuoteToolStepStatus } from '@/lib/quote-workflow/types';

const STEP_STATUS_LABEL: Record<QuoteToolStepStatus, string> = {
  queued: 'Waiting',
  ready: 'Ready',
  running: 'Running…',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function ToolStepList({
  steps,
  runningStepId,
  onRunNext,
  onRunStep,
}: {
  steps: QuoteToolStep[];
  runningStepId?: string | null;
  onRunNext?: () => void;
  onRunStep?: (stepId: string) => void;
}) {
  if (steps.length === 0 && !onRunNext) return null;
  const running = Boolean(runningStepId);
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Searches in HMS</h3>
      <p className="text-[11px] text-[#64748b]">
        These searches only read from HMS. They run one at a time.
      </p>
      {steps.map((step) => (
        <div key={step.id} className="flex flex-col gap-1 border-t border-[#e2e8f0] pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[#1e293b]">{step.title}</span>
            <span className="text-[10px] font-bold uppercase text-[#64748b]">{STEP_STATUS_LABEL[step.status] ?? step.status}</span>
          </div>
          {step.retryGuidance ? (
            <p className="text-[11px] text-amber-800">{step.retryGuidance}</p>
          ) : null}
          <p className="text-[11px] text-[#64748b]">{formatQuoteStepInputs(step.inputs)}</p>
          <button
            type="button"
            className="h-7 self-start rounded-xs border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b] disabled:opacity-40"
            onClick={() => onRunStep?.(step.id)}
            disabled={!onRunStep || !canRunQuoteStep(step, steps, runningStepId ?? null)}
          >
            Run {step.title}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onRunNext}
        disabled={running}
        className="flex h-9 w-full items-center justify-center rounded-xs bg-[#0066cc] text-xs font-bold text-white hover:bg-[#0052a3] disabled:bg-slate-300"
      >
        Run next
      </button>
      <p className="text-[11px] text-[#64748b]">Runs the next search that is ready. One at a time.</p>
    </section>
  );
}
