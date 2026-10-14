import {
  DEFAULT_PATHS,
  buildDomainTruth,
  buildUniverse,
  latestSucceededExtractions,
  readConfDomains,
  readRows,
  scoreTestEmail,
  selectTestEmails,
} from './party-v2-offline-score.js';
import type {
  PartyMatchCandidate,
  PartyMatchKind,
  PartyMatchRow,
} from '../src/ai/party-match-v2.js';
import { normalisePartyName, partyMatchSearchTerms } from '../src/ai/party-match-v2.js';
import type { DomainTruth, JsonRecord } from './party-v2-offline-score.js';

/**
 * Throwaway, offline-only prototype. It adds a sender-domain → HMS agency candidate from repeated,
 * unanimous historical answer-key rows, then delegates retrieval, picking, and binding to the existing
 * party-v2 scorer. No HMS, network, DB, or model calls. The answer key is in-sample evidence, not a
 * production-safe estimate; see docs/research/2026-10-14-party-lookup-v3.md.
 */

function isFoundTruth(row: JsonRecord): boolean {
  return typeof row.outcome === 'string' && row.outcome.toLowerCase() === 'found';
}

function buildUnanimousDomainMap(domains: readonly DomainTruth[]) {
  const map = new Map<string, { name: string; kind: PartyMatchKind; support: number }>();
  for (const domain of domains) {
    const agency = domain.dominantAgency;
    // Do not learn from a one-off or any domain with a competing/absent party label.
    if (
      domain.n < 2 ||
      !agency ||
      agency.count < 2 ||
      agency.count !== domain.n ||
      domain.agencies.length !== 1
    )
      continue;
    map.set(domain.domain, { name: agency.name, kind: 'agency', support: agency.count });
  }
  return map;
}

function candidateForMap(name: string, kind: PartyMatchKind): PartyMatchCandidate {
  // Prototype only: unanimous, repeated historical labels are treated as a strong claim. The
  // production binder remains unchanged and still enforces kind/name/uniqueness/truncation gates.
  return { name, kind, source: 'sender_domain_label', strength: 'strong' };
}

function expectedMatch(
  row: PartyMatchRow | null,
  expected: { kind: PartyMatchKind; name: string },
): boolean {
  return Boolean(
    row &&
      row.kind === expected.kind &&
      normalisePartyName(row.name) === normalisePartyName(expected.name),
  );
}

function missCategory(
  candidates: readonly PartyMatchCandidate[],
  expected: { kind: PartyMatchKind; name: string },
): string {
  const strong = candidates.filter((candidate) => candidate.strength === 'strong');
  const sameKind = strong.filter((candidate) => candidate.kind === expected.kind);
  const orgWords =
    /\b(?:pty|ltd|proprietary|limited|incorporated|llc|llp|cc|travel|travels|tours?|agency|services|holdings|group|hotel|university|management|solutions|consulting|international|africa|company|mining)\b/iu;
  const personLike = (name: string) => {
    const words = name
      .trim()
      .replace(/^(?:mr|mrs|ms|miss|dr|prof)\.?\s+/iu, '')
      .split(/\s+/u);
    return (
      words.length >= 2 &&
      words.length <= 4 &&
      !orgWords.test(name) &&
      words.every((word) => /^\p{Lu}[\p{L}'’.-]*$/u.test(word))
    );
  };
  if (sameKind.some((candidate) => personLike(candidate.name)))
    return 'person-like candidate vs organization';
  if (!sameKind.length && strong.some((candidate) => candidate.kind !== expected.kind))
    return 'agency vs end-client kind mismatch';
  if (!strong.length || strong.every((candidate) => candidate.source.startsWith('sender_domain_')))
    return 'domain-only / no named organization';

  const wanted = normalisePartyName(expected.name);
  const wantedTokens = new Set(
    wanted.split(/\s+/u).filter((token) => token.length >= 3 && !orgWords.test(token)),
  );
  const close = sameKind.map((candidate) => {
    const found = normalisePartyName(candidate.name);
    const foundTokens = new Set(
      found.split(/\s+/u).filter((token) => token.length >= 3 && !orgWords.test(token)),
    );
    const overlap = [...foundTokens].filter((token) => wantedTokens.has(token)).length;
    const contains = wanted.includes(found) || found.includes(wanted);
    const initials = [...wantedTokens].map((token) => token[0]).join('');
    const acronym =
      initials.length >= 2 &&
      (found.split(' ').includes(initials) || wanted.split(' ').includes(found));
    const grams = (value: string) =>
      new Set(
        Array.from({ length: Math.max(0, value.length - 2) }, (_, index) =>
          value.slice(index, index + 3),
        ),
      );
    const left = grams(wanted);
    const right = grams(found);
    const similarity =
      left.size + right.size
        ? [...left].filter((gram) => right.has(gram)).length /
          (left.size + right.size - [...left].filter((gram) => right.has(gram)).length)
        : 0;
    return { overlap, contains, acronym, similarity };
  });
  if (close.some((row) => row.contains || row.acronym || row.overlap > 0))
    return 'alias / abbreviation / missing tokens';
  if (close.some((row) => row.similarity >= 0.2)) return 'typo / spelling variation';
  const planned = candidates.flatMap((candidate) =>
    partyMatchSearchTerms(candidate.name).map(normalisePartyName),
  );
  if (planned.some((term) => term === wanted)) return 'search budget / term-plan miss';
  return 'organization absent from extracted signals';
}

function metrics(rows: Awaited<ReturnType<typeof scoreTestEmail>>[], total: number) {
  let binds = 0;
  let correct = 0;
  let perfectBinds = 0;
  let perfectCorrect = 0;
  let retrieved = 0;
  let pickerRows = 0;
  for (const row of rows) {
    if (row.truthRetrieved) retrieved += 1;
    if (row.truthInPickerRows) pickerRows += 1;
    if (row.perfectDecision.boundParty) {
      perfectBinds += 1;
      if (expectedMatch(row.perfectDecision.boundParty, row.testEmail.expected))
        perfectCorrect += 1;
    }
    if (!row.fallbackDecision.boundParty) continue;
    binds += 1;
    if (expectedMatch(row.fallbackDecision.boundParty, row.testEmail.expected)) correct += 1;
  }
  return {
    binds,
    correct,
    perfectBinds,
    perfectCorrect,
    precision: binds ? `${((correct / binds) * 100).toFixed(1)}%` : 'n/a',
    rate: `${((binds / total) * 100).toFixed(1)}% (${binds}/${total})`,
    retrieved: `${retrieved}/${total}`,
    pickerRows: `${pickerRows}/${total}`,
  };
}

async function main() {
  const [truthRows, confDomains, messages, extractionRows] = await Promise.all([
    readRows(DEFAULT_PATHS.truth),
    readConfDomains(DEFAULT_PATHS.confDomain),
    readRows(DEFAULT_PATHS.messages),
    readRows(DEFAULT_PATHS.extractions),
  ]);
  const domainTruth = buildDomainTruth(truthRows, confDomains);
  const domainMap = buildUnanimousDomainMap(domainTruth.domains);
  const sample = selectTestEmails({
    messages,
    extractionsByMessage: latestSucceededExtractions(extractionRows),
    domains: domainTruth.domains,
    maxPerDomain: 5,
  });
  const universe = buildUniverse(truthRows.filter(isFoundTruth));
  const universeByKind = new Map<PartyMatchKind, PartyMatchRow[]>([
    ['agency', universe.filter((row) => row.kind === 'agency')],
    ['company', universe.filter((row) => row.kind === 'company')],
  ]);

  const baseline = [];
  const mapped = [];
  let mappedCases = 0;
  for (const email of sample.selected) {
    const before = await scoreTestEmail(email, universeByKind);
    const learned = domainMap.get(email.domain);
    if (learned) mappedCases += 1;
    const after = learned
      ? await scoreTestEmail(email, universeByKind, null, [
          candidateForMap(learned.name, learned.kind),
        ])
      : before;
    baseline.push(before);
    mapped.push(after);
  }

  const before = metrics(baseline, sample.selected.length);
  const after = metrics(mapped, sample.selected.length);
  const bindGain = after.binds - before.binds;
  const precisionDelta =
    after.precision === before.precision ? 'unchanged' : `${before.precision} → ${after.precision}`;
  const missCounts = new Map<string, number>();
  for (const row of baseline) {
    if (row.truthRetrieved) continue;
    const category = missCategory(row.candidates, row.testEmail.expected);
    missCounts.set(category, (missCounts.get(category) ?? 0) + 1);
  }
  process.stdout.write(
    [
      'OFFLINE PROTOTYPE ONLY — no HMS, network, DB, or model calls.',
      `Cases: ${sample.selected.length}; answer-key domains: ${domainTruth.domains.length}; unanimous map entries (≥2 labels, no disagreement): ${domainMap.size}; mapped cases: ${mappedCases}/${sample.selected.length}.`,
      '',
      '| Scenario | Auto-bind | Correct binds | Precision | Truth retrieved | Truth in picker rows |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      `| Existing scorer | ${before.rate} | ${before.correct}/${before.binds} | ${before.precision} | ${before.retrieved} | ${before.pickerRows} |`,
      `| + unanimous domain candidate | ${after.rate} | ${after.correct}/${after.binds} | ${after.precision} | ${after.retrieved} | ${after.pickerRows} |`,
      '',
      `Net auto-bind change: ${bindGain >= 0 ? '+' : ''}${bindGain}/${sample.selected.length}; precision ${precisionDelta}.`,
      `Perfect-picker ceiling (same strict bind gate): ${before.perfectCorrect}/${sample.selected.length} → ${after.perfectCorrect}/${sample.selected.length}.`,
      '',
      'Reconstructed no-retrieval miss signatures (heuristics over extracted candidates; not the missing live-picker trace):',
      '| Category | Cases |',
      '| --- | ---: |',
      ...[...missCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => `| ${category} | ${count} |`),
      'Caveat: domain labels come from the same answer-key corpus used to define this cohort; this is an optimistic, in-sample replay, not independent validation or authorization to bind in production.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'domain-map prototype failed'}\n`,
  );
  process.exitCode = 1;
});
