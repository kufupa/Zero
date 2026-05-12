import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AiOpsBrainGraphNode } from '@/lib/demo/ai-ops-brain';
import { Button } from '@/components/ui/button';
import { PlugZap } from 'lucide-react';

type AiOpsApiPopoverProps = {
  node: AiOpsBrainGraphNode;
};

export function AiOpsApiPopover({ node }: AiOpsApiPopoverProps) {
  if (!node.apiConfig) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          className="border border-cyan-300/30 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/20"
        >
          <PlugZap className="h-4 w-4" />
          Connect API
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="left"
        className="w-96 border-white/10 bg-[#080b12] p-0 text-slate-100 shadow-2xl shadow-black/50"
      >
        <div className="border-b border-white/10 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200">API setup</p>
          <h3 className="mt-2 text-base font-semibold">{node.apiConfig.title}</h3>
        </div>
        <div className="space-y-4 p-4 text-sm">
          <InfoBlock label="Recommended" value={node.apiConfig.recommended} />
          <InfoBlock label="Fallback" value={node.apiConfig.fallback} />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Needed fields</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {node.apiConfig.fields.map((field) => (
                <span key={field} className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[11px]">
                  {field}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Used for</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-slate-300">
              {node.apiConfig.usedFor.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-1">
            <Button type="button" size="xs" className="bg-cyan-300 text-slate-950 hover:bg-cyan-200">
              Connect
            </Button>
            <Button type="button" size="xs" variant="ghost" className="border border-white/10 text-slate-200">
              Upload CSV
            </Button>
            <Button type="button" size="xs" variant="ghost" className="border border-white/10 text-slate-400">
              Skip demo
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-100">{value}</p>
    </div>
  );
}
