/** Host-owned workflow guidance. Source facts and native choices retain their existing guards. */
export type WorkflowGuidanceStage = 'extract' | 'synthesis';
export type WorkflowGuidanceScope = 'quote' | 'create' | 'amend' | 'cancel' | 'filing' | 'triage';
export type WorkflowGuidanceItem = {
  id: string;
  propertyCode: string;
  stage: WorkflowGuidanceStage;
  workflows: WorkflowGuidanceScope[];
  trigger: { allOf?: string[]; anyOf?: string[]; noneOf?: string[] };
  authority: 'observed_example' | 'advisory_convention' | 'owner_policy';
  guidance: string;
  sourceRecords: Array<{ sourceId: string; originalHash: string; family: string; time: { availableAt: string } }>;
};
export type WorkflowGuidanceCatalog = { version: string; catalogDigest: string; items: WorkflowGuidanceItem[] };
export type WorkflowGuidanceProjection = Pick<WorkflowGuidanceItem, 'authority' | 'guidance'>;
export type WorkflowGuidanceReceipt = {
  generationId: string; messageId: string; threadId: string; stage: WorkflowGuidanceStage;
  catalogDigest: string | null; version: string | null;
  selectedItemIds: string[]; sourceIds: string[];
  skipped: Array<{ id: string; reason: string }>;
  selectedCount: number; serializedCharacters: number;
  outcome: 'selected' | 'none_eligible' | 'invalid' | 'unavailable';
};
const scopes = new Set<string>(['quote', 'create', 'amend', 'cancel', 'filing', 'triage']);
const tokens = (text: string): string[] => text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
const contains = (text: string[], phrase: string[]): boolean => text.some((_, index) =>
  phrase.every((token, offset) => text[index + offset] === token));
const phrasesValid = (phrases: unknown): boolean => phrases === undefined || Array.isArray(phrases) &&
  phrases.every((phrase) => typeof phrase === 'string' && tokens(phrase).length > 0) &&
  new Set(phrases.map((phrase) => tokens(phrase).join(' '))).size === phrases.length;
function catalogValid(catalog: WorkflowGuidanceCatalog): boolean {
  return typeof catalog.version === 'string' && Boolean(catalog.version.trim()) &&
    typeof catalog.catalogDigest === 'string' && /^[a-f0-9]{64}$/.test(catalog.catalogDigest) &&
    Array.isArray(catalog.items) && new Set(catalog.items.map((item) => item?.id)).size === catalog.items.length &&
    catalog.items.every((item) => item && typeof item.id === 'string' && Boolean(item.id.trim()) &&
      typeof item.propertyCode === 'string' && Boolean(item.propertyCode.trim()) &&
      ['extract', 'synthesis'].includes(item.stage) && Array.isArray(item.workflows) && item.workflows.length > 0 &&
      item.workflows.every((scope) => scopes.has(scope)) && new Set(item.workflows).size === item.workflows.length &&
      (item.stage !== 'extract' || item.workflows.every((scope) => scope === 'triage')) &&
      ['observed_example', 'advisory_convention', 'owner_policy'].includes(item.authority) &&
      typeof item.guidance === 'string' && Boolean(item.guidance.trim()) && item.trigger &&
      [item.trigger.allOf, item.trigger.anyOf, item.trigger.noneOf].every(phrasesValid) &&
      Array.isArray(item.sourceRecords) && item.sourceRecords.length > 0 && item.sourceRecords.every((source) =>
        source && typeof source.sourceId === 'string' && Boolean(source.sourceId) &&
        typeof source.originalHash === 'string' && /^[a-f0-9]{64}$/.test(source.originalHash) &&
        typeof source.family === 'string' && Boolean(source.family) && Number.isFinite(Date.parse(source.time?.availableAt))));
}

export function selectReservationWorkflowV2Guidance(input: {
  catalog: WorkflowGuidanceCatalog | null;
  stage: WorkflowGuidanceStage;
  propertyCode: string;
  currentRequestText: string;
  workflows?: string[];
  cutoff: string;
  excludedFamilies?: readonly string[];
  generationId: string;
  messageId: string;
  threadId: string;
  previousExtract?: WorkflowGuidanceProjection[];
}): { projection: WorkflowGuidanceProjection[]; receipt: WorkflowGuidanceReceipt } {
  const previous = input.previousExtract ?? [];
  const receipt: WorkflowGuidanceReceipt = { generationId: input.generationId, messageId: input.messageId,
    threadId: input.threadId, stage: input.stage, catalogDigest: input.catalog?.catalogDigest ?? null,
    version: input.catalog?.version ?? null, selectedItemIds: [], sourceIds: [], skipped: [],
    selectedCount: previous.length, serializedCharacters: JSON.stringify({ extract: previous, synthesis: [] }).length,
    outcome: input.catalog ? 'none_eligible' : 'unavailable' };
  if (!input.catalog) return { projection: [], receipt };
  if (!catalogValid(input.catalog) || !Number.isFinite(Date.parse(input.cutoff))) {
    receipt.outcome = 'invalid'; return { projection: [], receipt };
  }
  const text = tokens(input.currentRequestText);
  const excluded = new Set([`thread:${input.threadId}`, ...(input.excludedFamilies ?? [])]);
  const candidates: Array<{ item: WorkflowGuidanceItem; concrete: boolean; score: number }> = [];
  for (const item of input.catalog.items) {
    let reason: string | undefined;
    const concrete = item.workflows.some((scope) => scope !== 'triage' && input.workflows?.includes(scope));
    if (item.propertyCode !== input.propertyCode) reason = 'property';
    else if (item.stage !== input.stage) reason = 'stage';
    else if (item.sourceRecords.some((source) => Date.parse(source.time.availableAt) > Date.parse(input.cutoff))) reason = 'future_source';
    else if (item.sourceRecords.some((source) => excluded.has(source.family))) reason = 'excluded_family';
    else if (!concrete && !item.workflows.includes('triage')) reason = 'workflow';
    const all = (item.trigger.allOf ?? []).map(tokens);
    const any = (item.trigger.anyOf ?? []).map(tokens);
    const none = (item.trigger.noneOf ?? []).map(tokens);
    if (!reason && (!all.every((phrase) => contains(text, phrase)) ||
      any.length > 0 && !any.some((phrase) => contains(text, phrase)) || none.some((phrase) => contains(text, phrase)))) reason = 'trigger';
    if (reason) { receipt.skipped.push({ id: item.id, reason }); continue; }
    candidates.push({ item, concrete, score: all.reduce((total, phrase) => total + phrase.length, 0) +
      Math.max(0, ...any.filter((phrase) => contains(text, phrase)).map((phrase) => phrase.length)) });
  }
  candidates.sort((a, b) => Number(b.concrete) - Number(a.concrete) || b.score - a.score ||
    (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  const projection: WorkflowGuidanceProjection[] = [];
  for (const { item } of candidates) {
    const next = [...projection, { authority: item.authority, guidance: item.guidance }];
    const payload = input.stage === 'extract' ? { extract: next, synthesis: [] } : { extract: previous, synthesis: next };
    const count = (input.stage === 'extract' ? 0 : previous.length) + next.length;
    const length = JSON.stringify(payload).length;
    if (count > 8 || length > 12_000) {
      receipt.skipped.push({ id: item.id, reason: count > 8 ? 'item_limit' : 'character_limit' }); continue;
    }
    projection.push(next[next.length - 1]);
    receipt.selectedItemIds.push(item.id);
    receipt.sourceIds.push(...item.sourceRecords.map((source) => source.sourceId));
    receipt.selectedCount = count; receipt.serializedCharacters = length;
  }
  receipt.sourceIds = [...new Set(receipt.sourceIds)];
  receipt.outcome = projection.length ? 'selected' : 'none_eligible';
  return { projection, receipt };
}
