import { AlertCircle, ArrowRight, CheckCircle2, Clock, Network, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** First-run step 2: the connection check. Next opens the tour once the server ping succeeds. */
export function DiagnosticsScreen({
  pingState,
  serverPingTimeStr,
  pingErrorMessage,
  detectedEmail,
  onRetry,
  onNext,
}: {
  pingState: 'idle' | 'loading' | 'success' | 'error';
  serverPingTimeStr: string | null;
  pingErrorMessage: string | null;
  detectedEmail: string;
  onRetry: () => void;
  onNext: () => void;
}) {
  return (
    <div className="animate-in fade-in nava-pane-scroll flex flex-1 flex-col overflow-y-auto p-4 duration-150">
      <div className="my-auto flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eff6ff] text-[#0066cc]">
          <Network className="h-6 w-6" />
        </div>
        <h1 className="text-base font-bold text-[#1e293b]">Connecting to Nava Services</h1>
        <p className="mt-1 text-xs text-[#64748b]">
          Verifying connection to Nava server and workstation environment.
        </p>

        <div className="my-5 w-full space-y-3 text-left">
          <div
            className={`flex items-start gap-2.5 rounded-sm border p-3 ${
              pingState === 'success'
                ? 'border-emerald-200 bg-emerald-50/50'
                : pingState === 'error'
                  ? 'border-rose-200 bg-rose-50/50'
                  : 'border-[#e2e8f0] bg-white'
            }`}
          >
            {pingState === 'loading' && (
              <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[#0066cc]" />
            )}
            {pingState === 'success' && (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            )}
            {pingState === 'error' && (
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
            )}
            {pingState === 'idle' && <Clock className="h-4 w-4 shrink-0 text-slate-400" />}

            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#1e293b]">
                  Nava Server Connection
                </span>
                {pingState === 'success' && (
                  <span className="text-[10px] font-bold text-emerald-700">CONNECTED</span>
                )}
                {pingState === 'loading' && (
                  <span className="text-[10px] font-bold text-blue-700">CONNECTING…</span>
                )}
                {pingState === 'error' && (
                  <span className="text-[10px] font-bold text-rose-700">ERROR</span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-[#64748b]">
                {pingState === 'success' &&
                  `Centurion Hotel · API server pinged at ${serverPingTimeStr} · Active`}
                {pingState === 'loading' && `Pinging server from ${detectedEmail}…`}
                {pingState === 'error' && (pingErrorMessage || 'Failed to connect to server')}
                {pingState === 'idle' && 'Waiting to initiate handshake…'}
              </div>
            </div>
          </div>

          {pingState === 'success' && (
            <div className="flex items-center gap-2 rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] font-medium text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
              <span>Nava server connected · Workstation API ping verified.</span>
            </div>
          )}

          {pingState === 'error' && (
            <Button
              type="button"
              onClick={onRetry}
              className="w-full bg-rose-600 text-xs text-white hover:bg-rose-700"
            >
              Retry Connection
            </Button>
          )}
        </div>

        <Button
          type="button"
          disabled={pingState !== 'success'}
          onClick={onNext}
          className="flex w-full items-center justify-center gap-2 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023] disabled:opacity-50"
        >
          <span>Next: 60-Second Feature Tour</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
