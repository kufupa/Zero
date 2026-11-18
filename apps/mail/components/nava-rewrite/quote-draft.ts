import type { Proposal } from './wire';

export function quoteArtifactIds(artifacts: NonNullable<NonNullable<Proposal['stage']>['artifacts']>): string[] | null {
  if (!artifacts.length || artifacts.length % 2 || new Set(artifacts.map(item=>item.id)).size!==artifacts.length ||
      new Set(artifacts.map(item=>item.name.toLowerCase())).size!==artifacts.length) return null;
  return artifacts.every((item,index)=>index%2===0
    ? item.mime_type==='application/pdf' && item.name.endsWith('.pdf')
    : item.mime_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && item.name.endsWith('.xlsx'))
    ? artifacts.map(item=>item.id) : null;
}
