import type { Proposal } from './wire';

export function quoteArtifactIds(artifacts: NonNullable<NonNullable<Proposal['stage']>['artifacts']>): [string, string] | null {
  const pdf = artifacts.find(item => item.name === 'Quotation.pdf' && item.mime_type === 'application/pdf');
  const xlsx = artifacts.find(item => item.name === 'Quotation.xlsx' && item.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return artifacts.length === 2 && pdf && xlsx && pdf.id !== xlsx.id ? [pdf.id, xlsx.id] : null;
}
