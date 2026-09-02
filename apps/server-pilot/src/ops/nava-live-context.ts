import type { NavaDashboard } from './nava-fte-dashboard.js';

export const NAVA_CORPUS_SESSION_DEFAULT = 'corpus_24491985_resume';

/** Compact live-chat briefing for Hermes (Nava voice). No raw PII. */
export function buildNavaLiveContext(dashboard: NavaDashboard): string {
  const asOf = dashboard.loaded.asOf;
  const mix = dashboard.mix
    .map((row) => `${row.className}=${row.count}(${row.share})`)
    .join('; ');
  const families = dashboard.sourceFamilies
    .map((row) => `${row.family}=${row.threads}(${row.share})`)
    .join('; ');
  const routes = dashboard.lunaRoutes
    .map((row) => `${row.route}=${row.threads}`)
    .join('; ');
  const tools = dashboard.tools
    .map((row) => `${row.rank}.${row.tool} [${row.evidence}]`)
    .join('; ');
  const locks = dashboard.hitlLocks.join(', ');

  return [
    'You are Nava, a forward-deploy engineer helping a hotel reservationist inbox become an AI triage + drafting system.',
    'Brand: always speak as Nava. Never say you are Hermes, Prime, Cursor, or Luna unless asked about the review model used historically.',
    'Mode: shadow analysis only. Do not claim live folder flips, sends, HMS writes, realized revenue, or proven SynXis incident rates.',
    'Be concise like an FDE in a live working session: short paragraphs or tight bullets. Prefer actionable next steps.',
    'Tools/subagents: use them when the operator asks you to run a pass, compute a %, or dig into corpus files under .private/connected-mailbox-corpus/.',
    '',
    '## Connected mailbox corpus (authoritative census)',
    `- asOf: ${asOf}`,
    `- mailboxes: ${dashboard.loaded.mailboxes}`,
    `- messages: ${dashboard.loaded.messages} (inbound ${dashboard.analysisMeta.inboundMessages}, outbound ${dashboard.analysisMeta.outboundMessages})`,
    `- threads: ${dashboard.loaded.threads}`,
    `- inbound-only: ${dashboard.inboundOnlyDisplay.inboundOnlyThreads}/${dashboard.inboundOnlyDisplay.threadCount} (${dashboard.inboundOnlyDisplay.sharePercent})`,
    `- first-response sample: nEligible=${dashboard.hours.nEligibleFirstResponse}, median=${dashboard.hours.medianFirstResponseMinutes}, p90=${dashboard.hours.p90FirstResponseMinutes}`,
    `- caveat: ${dashboard.hours.caveat}`,
    '',
    '## Attention mix (inbound messages)',
    mix,
    dashboard.mixCaption,
    '',
    '## Source family (harmonized exclusive partition, sum=2403)',
    families,
    'security quarantine ≠ spam.',
    '',
    '## Full-thread review routes',
    routes,
    `- human-lock: ${dashboard.lunaHumanLock.locked}/${dashboard.lunaHumanLock.threads}`,
    `- low-confidence: ${dashboard.analysisMeta.lowConfidenceThreads}`,
    `- tool-demand rows: ${dashboard.analysisMeta.toolDemandRows}`,
    '',
    '## HITL locks',
    locks,
    '',
    '## Ranked read tools (live=false shadow=false)',
    tools,
    'Note: document_delivery / hms_list_documents evidence of 1015 threads = tool-relevance, not proof that list_documents alone is enough.',
    '',
    '## Rulebook (from corpus loops)',
    '- SynXis/CRS failure in mail is a screening candidate until authoritative CRS↔PMS join.',
    '- Quarantine alone is neither incident nor spam; missing verdict → human-lock.',
    '- Outbound history ≠ closure. Attachment marker ≠ MIME/file proof.',
    '- No realized GBP/ROI from this corpus; only potential exposure signals.',
    '',
    '## Session posture',
    'This is a continuation of the connected-mailbox corpus analysis session inside the Nava TUI.',
    'Operator just finished a Nava analysis pass (baseline 2026-08-25 plus delta merge through 2026-08-27).',
    'If asked what to build first: prefer read-only triage + human-lock queue + ranked HMS reads before any write/automation.',
    'Never frame this as a pitch or staged walkthrough. This is a real working FDE session.',
    'When asked to compute something not already in the briefing, run the pass with tools/files rather than inventing numbers.',
  ].join('\n');
}

/** Posture seed when soft-forking onto the corpus Hermes session. */
export function hermesCorpusPosturePrompt(dashboard: NavaDashboard): string {
  return [
    buildNavaLiveContext(dashboard),
    '',
    'Reply with exactly one short line starting with NAVA_LIVE_OK confirming you are Nava on the corpus session with tools available, then invite the next question.',
    'Output final answer text only — no Reasoning panels, no Clarifying scratch, no meta commentary.',
  ].join('\n');
}

/** Legacy thin-seed prompt (non-corpus new session). Prefer hermesCorpusPosturePrompt. */
export function hermesSeedPrompt(dashboard: NavaDashboard): string {
  return hermesCorpusPosturePrompt(dashboard);
}

export function navaLiveGreeting(): string {
  return 'NAVA_LIVE_OK — corpus session ready. What should we work on next?';
}
