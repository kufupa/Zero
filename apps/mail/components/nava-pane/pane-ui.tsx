import type { ReactNode } from 'react';

/**
 * The pane's design language, taken from the side-pane design spec
 * (docs/superpowers/specs/2026-09-23-centurion-outlook-side-pane-demo.html): white section cards with an uppercase
 * header bar, 32px fields with a red star when required, one full-width blue primary action, and steppers. Every pane
 * section builds on these so the whole pane reads the same way.
 */

export const PANE_COLORS = {
  blue: '#0066cc',
  blueHover: '#0052a3',
  blueLight: '#eff6ff',
  primary: '#1a4332',
  primaryLight: '#eaf4ee',
  red: '#c01823',
  line: '#e2e8f0',
  lineDark: '#cbd5e1',
  subtle: '#f8fafc',
  ink: '#1e293b',
  inkSecondary: '#475569',
  inkMuted: '#64748b',
} as const;

/** A 32px text input or select, as in the design spec. */
export const paneFieldClass =
  'h-8 w-full rounded-[3px] border border-[#cbd5e1] bg-white px-2.5 text-[12.5px] text-[#1e293b] outline-none transition-colors focus:border-[#0066cc] disabled:bg-[#f8fafc] disabled:text-[#64748b]';

/** A multi-line input in the same style. */
export const paneTextareaClass =
  'min-h-16 w-full rounded-[3px] border border-[#cbd5e1] bg-white px-2.5 py-1.5 text-[12.5px] text-[#1e293b] outline-none transition-colors focus:border-[#0066cc]';

export function Section({
  title,
  step,
  icon,
  action,
  children,
  id,
}: {
  title: string;
  /** The step number in the pane's flow, shown before the title. */
  step?: number;
  icon?: ReactNode;
  /** A small control on the right of the header bar. */
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  // shrink-0: in the pane's scroll body (a flex column) an overflow-hidden card may otherwise shrink to nothing.
  return (
    <section id={id} aria-label={title} className="shrink-0 overflow-hidden rounded-[4px] border border-[#e2e8f0] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-3 py-[9px]">
        <h3 className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.4px] text-[#475569]">
          {step !== undefined ? (
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#1a4332] text-[10.5px] text-white">
              {step}
            </span>
          ) : null}
          {icon}
          {title}
        </h3>
        {action}
      </div>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </section>
  );
}

/** "from email": marks a value Nava read from the email, so staff know to check it. */
export function FromEmailTag() {
  return (
    <span className="rounded-[2px] bg-[#eff6ff] px-1 py-px text-[10px] font-semibold text-[#0066cc]">from email</span>
  );
}

export function Field({
  label,
  htmlFor,
  required = false,
  fromEmail = false,
  hint,
  aside,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  fromEmail?: boolean;
  hint?: ReactNode;
  /** Right-aligned text in the label row, e.g. a total. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11.5px] font-semibold text-[#475569]">
        <label htmlFor={htmlFor} className="flex items-center gap-1.5">
          <span>
            {label}
            {required ? (
              <span aria-hidden className="ml-0.5 font-bold text-[#c01823]">
                *
              </span>
            ) : null}
          </span>
          {fromEmail ? <FromEmailTag /> : null}
        </label>
        {aside ? <span className="font-normal text-[#64748b]">{aside}</span> : null}
      </div>
      {children}
      {hint ? <p className="text-[11px] text-[#64748b]">{hint}</p> : null}
    </div>
  );
}

/**
 * The one main action of a step: full-width blue. While it runs, a loading bar takes its place. When it is disabled,
 * the reason shows under it, so staff never face a dead button without knowing why.
 */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  disabledReason,
  loading = false,
  loadingText,
  type = 'button',
  icon,
  className = '',
  tone = 'blue',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string | null;
  loading?: boolean;
  loadingText?: string;
  type?: 'button' | 'submit';
  icon?: ReactNode;
  className?: string;
  /** Blue for the step's action; green for the reply that creates the draft. */
  tone?: 'blue' | 'green';
}) {
  return (
    <div className="flex flex-col gap-1">
      {loading ? (
        <div
          role="status"
          className="flex h-[38px] items-center gap-2.5 rounded-[3px] border border-[#bfdbfe] bg-[#eff6ff] px-2.5 text-[12px] font-semibold text-[#0066cc]"
        >
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#0066cc] border-t-transparent" />
          {loadingText ?? 'Working…'}
        </div>
      ) : (
        <button
          type={type}
          onClick={onClick}
          disabled={disabled}
          className={`flex h-[38px] w-full items-center justify-center gap-2 rounded-[3px] text-[13px] font-bold text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc] disabled:cursor-not-allowed disabled:bg-[#cbd5e1] disabled:text-[#64748b] ${className} ${
            tone === 'green' ? 'bg-[#1a4332] hover:bg-[#143528]' : 'bg-[#0066cc] hover:bg-[#0052a3]'
          }`}
        >
          {icon}
          {children}
        </button>
      )}
      {disabled && !loading && disabledReason ? (
        <p className="text-center text-[11px] text-[#64748b]">{disabledReason}</p>
      ) : null}
    </div>
  );
}

/** A secondary action: white with a blue outline. */
export function SecondaryButton({
  children,
  onClick,
  disabled = false,
  disabledReason,
  type = 'button',
  icon,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string | null;
  type?: 'button' | 'submit';
  icon?: ReactNode;
  className?: string;
}) {
  const button = (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-[3px] border border-[#0066cc] bg-white px-3 text-[12px] font-semibold text-[#0066cc] transition-colors hover:bg-[#eff6ff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc] disabled:cursor-not-allowed disabled:border-[#cbd5e1] disabled:text-[#94a3b8] ${className}`}
    >
      {icon}
      {children}
    </button>
  );
  if (!disabled || !disabledReason) return button;
  return (
    <div className="flex flex-col gap-1">
      {button}
      <p className="text-center text-[11px] text-[#64748b]">{disabledReason}</p>
    </div>
  );
}

/** A text-style action, e.g. "Change dates". */
export function LinkButton({
  children,
  onClick,
  ariaExpanded,
}: {
  children: ReactNode;
  onClick?: () => void;
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      className="rounded-[3px] text-[11.5px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
    >
      {children}
    </button>
  );
}

/** − n + for a count, e.g. rooms. A null value is not entered yet: it shows "–", and + starts it at 1 (or min). */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  label,
  disabled = false,
}: {
  value: number | null;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** Names the count for screen readers and tests, e.g. "Rooms for stay 1". */
  label: string;
  disabled?: boolean;
}) {
  const buttonClass =
    'flex h-[26px] w-[26px] items-center justify-center bg-[#f8fafc] text-[13px] font-bold text-[#475569] hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:text-[#cbd5e1]';
  return (
    <div role="group" aria-label={label} className="flex items-center overflow-hidden rounded-[3px] border border-[#cbd5e1]">
      <button
        type="button"
        aria-label={`Fewer: ${label}`}
        className={buttonClass}
        disabled={disabled || value === null || value <= min}
        onClick={() => value !== null && onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span aria-live="polite" className="w-8 bg-white text-center text-[12px] font-bold text-[#1e293b]">
        {value ?? '–'}
      </span>
      <button
        type="button"
        aria-label={`More: ${label}`}
        className={buttonClass}
        disabled={disabled || (value !== null && value >= max)}
        onClick={() => onChange(value === null ? Math.max(min, 1) : Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

const NOTICE_TONES = {
  info: 'border-[#bfdbfe] bg-[#eff6ff] text-[#1e3a8a]',
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  error: 'border-[#fecaca] bg-[#fef2f2] text-[#991b1b]',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
} as const;

/** A one-line message inside a step. Keep it short: one fact and what to do. */
export function Notice({
  tone = 'info',
  children,
  role,
}: {
  tone?: keyof typeof NOTICE_TONES;
  children: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div role={role} className={`rounded-[3px] border px-2.5 py-1.5 text-[11.5px] ${NOTICE_TONES[tone]}`}>
      {children}
    </div>
  );
}

/** A folded group of optional fields, e.g. "Extras". Closed by default. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-[3px] border border-[#e2e8f0]">
      <summary className="flex cursor-pointer select-none items-center justify-between bg-[#f8fafc] px-2.5 py-[7px] text-[11.5px] font-semibold text-[#475569] [&::-webkit-details-marker]:hidden">
        {summary}
        <span aria-hidden className="transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-3 p-2.5">{children}</div>
    </details>
  );
}
