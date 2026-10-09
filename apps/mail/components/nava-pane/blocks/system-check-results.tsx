import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { SystemCheckResults } from '../use-system-check';

/** Review block: the four system-check results, shown at the foot of the tool once a check has run. */
export function SystemCheckResultsBlock({ results }: { results: SystemCheckResults }) {
  return (
    <div id="system-check-results" className="flex flex-col gap-1.5 rounded-sm border border-[#e2e8f0] bg-[#f8fafc] p-3 text-xs">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[#64748b]">
        System check results
      </p>
      <div className="flex items-center justify-between text-[#1e293b]">
        <span>1. Outlook add-in connected</span>
        {results.bridge ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <AlertCircle className="h-4 w-4 text-rose-500" />
        )}
      </div>
      <div className="flex items-center justify-between text-[#1e293b]">
        <span>2. Selected email readable</span>
        {results.activeEmail ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <AlertCircle className="h-4 w-4 text-rose-500" />
        )}
      </div>
      <div className="flex items-center justify-between text-[#1e293b]">
        <span>3. Outlook folders readable</span>
        {results.folderTable ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <AlertCircle className="h-4 w-4 text-rose-500" />
        )}
      </div>
      <div className="flex items-center justify-between text-[#1e293b]">
        <span>4. Nava server reachable</span>
        {results.serverPing ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <AlertCircle className="h-4 w-4 text-rose-500" />
        )}
      </div>
    </div>
  );
}
