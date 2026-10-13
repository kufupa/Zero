import {
  applyPartyBindRule,
  buildPartyMatchCandidates,
  partyMatchEmailContext,
  pickPartyMatch,
  type PartyMatchKind,
  type PartyMatchRow,
} from '../src/ai/party-match-v2.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type RecordedSearch = {
  term: string;
  candidateName: string;
  kind: PartyMatchKind;
  rows: PartyMatchRow[];
  truncated?: boolean;
};

type EvalCase = {
  caseId: string;
  email: {
    fromAddress?: string | null;
    displayName?: string | null;
    subject?: string | null;
    signatureBlock?: string;
    body?: string;
    agency?: string | null;
    endClient?: string | null;
    contactName?: string | null;
    guestNames?: string[];
    quoteLlmParty?: unknown;
  };
  candidateRowsByTerm: RecordedSearch[];
  expected: { nativeId: string | null };
};

function parseCase(line: string, index: number): EvalCase {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`line ${index + 1} must be a JSON object`);
  }
  const row = value as Partial<EvalCase>;
  if (
    typeof row.caseId !== 'string' ||
    !row.email ||
    !Array.isArray(row.candidateRowsByTerm) ||
    !row.expected ||
    !(row.expected.nativeId === null || typeof row.expected.nativeId === 'string')
  ) {
    throw new Error(
      `line ${index + 1} is missing caseId, email, candidateRowsByTerm, or expected.nativeId`,
    );
  }
  return row as EvalCase;
}

function candidateRows(recorded: RecordedSearch[]): PartyMatchRow[] {
  const seen = new Set<string>();
  const rows: PartyMatchRow[] = [];
  for (const search of recorded) {
    if (!search || !Array.isArray(search.rows)) continue;
    for (const row of search.rows) {
      if (!row || (row.kind !== 'company' && row.kind !== 'agency')) continue;
      if (
        typeof row.nativeId !== 'string' ||
        !row.nativeId.trim() ||
        typeof row.name !== 'string' ||
        !row.name.trim()
      )
        continue;
      const key = `${row.kind}:${row.nativeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ kind: row.kind, nativeId: row.nativeId, name: row.name });
    }
  }
  return rows;
}

async function main() {
  const fixture = fileURLToPath(
    new URL('../tests/fixtures/party-match-v2-eval.jsonl', import.meta.url),
  );
  const path = process.argv[2] ?? fixture;
  const source = await readFile(path, 'utf8');
  const cases = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCase);
  if (!cases.length) throw new Error(`no party-match cases found in ${path}`);

  let autoBinds = 0;
  let correctAutoBinds = 0;
  let top3Hits = 0;
  let expectedMatches = 0;
  const falseBinds: string[] = [];

  for (const testCase of cases) {
    const email = testCase.email;
    const body = email.body ?? email.signatureBlock ?? '';
    const payload = {
      agency: email.agency ?? null,
      endClient: email.endClient ?? null,
      contact: { name: email.contactName ?? null },
      quoteLlmParty: email.quoteLlmParty,
    };
    const input = {
      payload,
      fromAddress: email.fromAddress ?? null,
      displayName: email.displayName ?? null,
      subject: email.subject ?? null,
      body,
      guestNames: email.guestNames,
    };
    const candidates = buildPartyMatchCandidates(input);
    const rows = candidateRows(testCase.candidateRowsByTerm);
    const context = partyMatchEmailContext(input);
    // Offline mode intentionally uses the production no-model fallback: only one exact normalized name can be picked.
    const pick = await pickPartyMatch({ adapter: null, candidates, rows, context });
    const decision = applyPartyBindRule({
      candidates,
      rows,
      pick,
      truncated: testCase.candidateRowsByTerm.some((search) => search.truncated === true),
    });
    const boundId = decision.boundParty?.nativeId ?? null;
    if (boundId) {
      autoBinds += 1;
      if (boundId === testCase.expected.nativeId) correctAutoBinds += 1;
      else
        falseBinds.push(
          `${testCase.caseId}:${boundId} (expected ${testCase.expected.nativeId ?? 'none'})`,
        );
    }
    if (testCase.expected.nativeId) {
      expectedMatches += 1;
      if (decision.suggestions.some((row) => row.nativeId === testCase.expected.nativeId))
        top3Hits += 1;
    }
  }

  const percent = (value: number, total: number) =>
    total === 0 ? 'n/a' : `${((value / total) * 100).toFixed(1)}% (${value}/${total})`;
  console.log(`Cases: ${cases.length}`);
  console.log(`Auto-bind precision: ${percent(correctAutoBinds, autoBinds)}`);
  console.log(`Auto-bind rate: ${percent(autoBinds, cases.length)}`);
  console.log(`Top-3 recall: ${percent(top3Hits, expectedMatches)}`);
  if (falseBinds.length) console.log(`False auto-binds: ${falseBinds.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'party-match evaluation failed');
  process.exitCode = 1;
});
