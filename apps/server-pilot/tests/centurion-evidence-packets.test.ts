import { describe, expect, it } from 'vitest';
import {
  createPacketGenerator,
  createPacketRunKey,
  type EvidencePacket,
  type PrivatePacketInput,
} from '../scripts/centurion-evidence-packets.js';

// Synthetic only; every private identifier intentionally includes a canary.
const canary = 'PRIVATE-CANARY-guest@example.test-/private/file-2027-05-06';
const input = (): PrivatePacketInput => ({
  version: 'centurion-evidence-packet-v1',
  kind: 'case',
  searchWindow: 'full',
  windowSourceId: `${canary}:window-source-version`,
  manifestId: `${canary}:manifest`,
  caseId: `${canary}:case`,
  pdfId: `${canary}:pdf`,
  parentId: `${canary}:parent`,
  search: {
    snapshot: 'complete', candidates: 'partial', participants: 'partial',
    headers: 'unavailable', pdfText: 'unknown', hms: 'complete',
  },
  candidateCountBand: 'two_to_ten',
  structuralPageCompleteness: 'not_requested',
  structuralCountBand: 'unknown',
  structuralPageCountBand: 'unknown',
  claims: [{
    claimId: `${canary}:claim`,
    subjectId: `${canary}:pdf`,
    objectId: `${canary}:candidate`,
    proposition: 'exact_address',
    status: 'supported',
    inspection: 'inspected',
    evidence: [{
      evidenceId: `${canary}:evidence`,
      sourceId: `${canary}:candidate`,
      observationSourceId: null,
      subjectId: `${canary}:pdf`,
      objectId: `${canary}:candidate`,
      sourceRole: 'candidate_message',
      provenanceAvailable: true,
      type: 'address',
      attachmentAttribution: 'not_applicable',
      identityRelation: 'unresolved',
      parentAddressRoles: ['current_from'],
      candidateAddressRoles: ['current_to'],
      headerRelation: 'none',
      headerDirection: 'none',
      mailboxClassification: 'hotel_only',
      confirmationEquality: 'unknown',
      confirmationStrength: 'unknown',
      dateRelation: 'unknown',
      observationConflict: 'not_applicable',
      comparisonField: 'not_applicable',
      comparisonOutcome: 'not_applicable',
      objectObservationTime: 'not_applicable',
    }],
  }],
  nextCursor: `${canary}:cursor`,
  nextStructuralCursor: null,
});

function scope() {
  const value = input();
  return { manifestId: value.manifestId, caseId: value.caseId, searchWindow: value.searchWindow,
    windowSourceId: value.windowSourceId, parentId: value.parentId };
}

function runKey(): Buffer {
  const result = createPacketRunKey();
  if (!result.ok) throw new Error('Synthetic run key failed');
  return result.value;
}

function generated(generator = createPacketGenerator(runKey())) {
  const result = generator.generate(input());
  if (!result.ok) throw new Error('Unexpected synthetic fixture failure');
  return { generator, packet: result.value };
}

// Exercise every leaf, including every enum/boolean, ID, and cursor.
function leafPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leafPaths(item, [...prefix, index]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...prefix, key]));
  }
  return [prefix];
}
function setPath(value: unknown, path: (string | number)[], replacement: unknown) {
  let cursor = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path[path.length - 1]!] = replacement;
}

describe('Centurion evidence inspection packets', () => {
  it('hashes every source identifier and cursor while preserving only allowlisted facts', () => {
    const { generator, packet } = generated();
    expect(JSON.stringify(packet)).not.toContain(canary);
    expect(JSON.stringify(packet)).not.toContain('guest@example.test');
    expect(JSON.stringify(packet)).not.toContain('/private/file');
    expect(JSON.stringify(packet)).not.toContain('2027-05-06');
    expect(packet.caseId).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.claims[0]?.subjectId).toBe(packet.pdfId);
    expect(packet.search).toEqual(input().search);
    expect(packet.claims[0]?.evidence[0]).toMatchObject({
      sourceRole: 'candidate_message', provenanceAvailable: true, mailboxClassification: 'hotel_only',
    });
    expect(generator.validate(packet)).toEqual({ ok: true, value: packet });
    const serialized = generator.serialize(packet);
    expect(serialized).toEqual({ ok: true, value: JSON.stringify(packet) });
    expect(JSON.stringify(serialized)).not.toContain(canary);
    expect(generator.resolvePrivateCursor(packet.nextCursor, scope())).toEqual({ ok: true, value: input().nextCursor });
  });

  it('uses domain-separated run-local HMACs and never emits the key', () => {
    const key = runKey();
    const a = createPacketGenerator(key);
    const b = createPacketGenerator(key);
    const c = createPacketGenerator(runKey());
    const source = input();
    source.caseId = source.pdfId;
    const aResult = a.generate(source);
    const bResult = b.generate(source);
    const cResult = c.generate(source);
    if (!aResult.ok || !bResult.ok || !cResult.ok) throw new Error('Fixture failed');
    expect(aResult.value).toEqual(bResult.value);
    expect(aResult.value.caseId).not.toBe(aResult.value.pdfId);
    expect(aResult.value.caseId).not.toBe(cResult.value.caseId);
    expect(JSON.stringify(aResult.value)).not.toContain(key.toString('hex'));
    expect(c.validate(aResult.value)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    expect(c.resolvePrivateCursor(aResult.value.nextCursor, { ...scope(), caseId: source.caseId })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
  });

  it('fails closed for canary values in every model-visible field', () => {
    const { generator, packet } = generated();
    for (const path of leafPaths(packet)) {
      const mutated = structuredClone(packet);
      setPath(mutated, path, canary);
      const result = generator.validate(mutated);
      expect(result, `field ${path.join('.')}`).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it('rejects unissued well-formed opaque IDs, including forged cursors', () => {
    const { generator, packet } = generated();
    for (const path of leafPaths(packet).filter((path) => {
      const key = path[path.length - 1];
      return typeof key === 'string' && (key.endsWith('Id') || key === 'nextCursor' || key === 'nextStructuralCursor');
    })) {
      const mutated = structuredClone(packet);
      setPath(mutated, path, 'a'.repeat(64));
      expect(generator.validate(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    }
    expect(generator.resolvePrivateCursor('a'.repeat(64), scope())).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
  });

  it('rejects unexpected keys at every object level, including private text and error fields', () => {
    const { generator, packet } = generated();
    const objectPaths: (string | number)[][] = [[], ['search'], ['claims', 0], ['claims', 0, 'evidence', 0]];
    for (const path of objectPaths) {
      for (const key of ['subject', 'body', 'name', 'filename', 'path', 'date', 'error', canary]) {
        const source = structuredClone(input());
        const out = structuredClone(packet);
        const add = (root: unknown) => {
          let target = root as Record<string | number, unknown>;
          for (const part of path) target = target[part] as Record<string | number, unknown>;
          target[key] = canary;
        };
        add(source);
        add(out);
        const inputResult = generator.generate(source);
        const packetResult = generator.validate(out);
        expect(inputResult).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(packetResult).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
        expect(generator.serialize(out)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
        expect(JSON.stringify([inputResult, packetResult])).not.toContain(canary);
      }
    }
  });

  it('rejects invalid enums, booleans, missing keys and unsupported provenance', () => {
    const { generator } = generated();
    for (const path of leafPaths(input())) {
      const last = path[path.length - 1];
      if (typeof last === 'string' && (last.endsWith('Id') || last === 'nextCursor' || last === 'nextStructuralCursor')) continue;
      const source = structuredClone(input());
      setPath(source, path, canary);
      expect(generator.generate(source), `field ${path.join('.')}`).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    const noEvidence = input();
    noEvidence.claims[0]!.evidence = [];
    expect(generator.generate(noEvidence)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const noProvenance = input();
    noProvenance.claims[0]!.evidence[0]!.provenanceAvailable = false;
    expect(generator.generate(noProvenance)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const weakSameStay = input();
    weakSameStay.claims[0]!.proposition = 'same_stay';
    expect(generator.generate(weakSameStay)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const missing = structuredClone(input()) as Partial<PrivatePacketInput>;
    delete missing.search;
    expect(generator.generate(missing)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('retains duplicate reasons, zero results, missing sources and partial searches without inference', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    source.parentId = null;
    source.nextCursor = null;
    source.search.candidates = 'partial';
    source.candidateCountBand = 'zero';
    source.claims[0]!.status = 'unknown';
    source.claims[0]!.proposition = 'same_stay';
    source.claims[0]!.evidence.push({ ...source.claims[0]!.evidence[0]! });
    const result = generator.generate(source);
    if (!result.ok) throw new Error('Fixture failed');
    expect(result.value).toMatchObject({ parentId: null, nextCursor: null, candidateCountBand: 'zero', search: { candidates: 'partial' } });
    expect(result.value.claims[0]?.status).toBe('unknown');
    expect(result.value.claims[0]?.evidence).toHaveLength(2);
  });

  it('never exposes exception text or input in failure paths', () => {
    const { generator } = generated();
    const throwing = new Proxy({}, { get() { throw new Error(canary); }, ownKeys() { throw new Error(canary); } });
    const results = [generator.generate(throwing), generator.validate(throwing), generator.resolvePrivateCursor(canary, scope())];
    expect(results).toEqual([
      { ok: false, error: { code: 'INTERNAL_ERROR' } },
      { ok: false, error: { code: 'INVALID_PACKET' } },
      { ok: false, error: { code: 'INVALID_CURSOR' } },
    ]);
    expect(JSON.stringify(results)).not.toContain(canary);
    const invalid = createPacketGenerator(Buffer.alloc(31));
    expect(invalid.generate(input())).toEqual({ ok: false, error: { code: 'INVALID_RUN_KEY' } });
    expect(invalid.validate({})).toEqual({ ok: false, error: { code: 'INVALID_RUN_KEY' } });
    expect(invalid.serialize({})).toEqual({ ok: false, error: { code: 'INVALID_RUN_KEY' } });
    expect(invalid.resolvePrivateCursor(canary, scope())).toEqual({ ok: false, error: { code: 'INVALID_RUN_KEY' } });
  });

  it('rejects ID namespace substitution even when tokens were issued in this run', () => {
    const { generator, packet } = generated();
    const swapped: EvidencePacket = { ...packet, caseId: packet.pdfId };
    expect(generator.validate(swapped)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
  });

  it('requires proposition-appropriate evidence with jointly matched endpoints and provenance', () => {
    const generator = createPacketGenerator(runKey());
    type Claim = PrivatePacketInput['claims'][number];
    type Evidence = Claim['evidence'][number];
    const variants: { proposition: Claim['proposition']; evidence: Partial<Evidence>[] }[] = [
      { proposition: 'attachment_parent', evidence: [{ type: 'attachment', attachmentAttribution: 'verified_snapshot_parent', identityRelation: 'not_applicable', sourceRole: 'pdf' }] },
      { proposition: 'same_thread', evidence: [{ type: 'thread', identityRelation: 'not_applicable', sourceRole: 'parent_message' }] },
      { proposition: 'exact_header', evidence: [{ type: 'header', identityRelation: 'not_applicable', headerRelation: 'in_reply_to', headerDirection: 'parent_to_target' }] },
      { proposition: 'exact_address', evidence: [{ type: 'address', parentAddressRoles: ['current_from'], candidateAddressRoles: ['current_to'] }] },
      { proposition: 'same_stay', evidence: [
        { type: 'confirmation_token', identityRelation: 'not_applicable', confirmationEquality: 'equal', confirmationStrength: 'labeled' },
        { type: 'date', identityRelation: 'not_applicable', dateRelation: 'overlaps', sourceId: `${canary}:pdf` },
      ] },
      { proposition: 'document_version', evidence: [{ type: 'document_version', identityRelation: 'not_applicable', sourceRole: 'pdf' }] },
      { proposition: 'later_observation', evidence: [{ type: 'observation', identityRelation: 'not_applicable', sourceRole: 'hms_observation', objectObservationTime: 'after' }] },
    ];
    for (const variant of variants) {
      const source = input();
      const claim = source.claims[0]!;
      const base = claim.evidence[0]!;
      claim.proposition = variant.proposition;
      if (variant.proposition === 'attachment_parent') {
        claim.objectId = source.parentId!;
        base.objectId = claim.objectId;
        base.sourceId = source.pdfId;
      }
      claim.evidence = variant.evidence.map((overrides, i) => ({ ...base, ...overrides, evidenceId: `ev-${i}` }));
      expect(generator.generate(source).ok, variant.proposition).toBe(true);

      // Matching type without provenance, plus unrelated provenanced item, is insufficient.
      const split = structuredClone(source);
      split.claims[0]!.evidence[0]!.provenanceAvailable = false;
      split.claims[0]!.evidence.push({ ...base, evidenceId: 'unrelated', type: 'other', identityRelation: 'not_applicable' });
      expect(generator.generate(split), variant.proposition).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });

      const wrongEndpoint = structuredClone(source);
      wrongEndpoint.claims[0]!.evidence[0]!.objectId = 'different-source';
      expect(generator.generate(wrongEndpoint), variant.proposition).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });

      const wrongSource = structuredClone(source);
      wrongSource.claims[0]!.evidence[0]!.sourceId = 'unrelated-source';
      expect(generator.generate(wrongSource), variant.proposition).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });

      const wrongKind = structuredClone(source);
      wrongKind.claims[0]!.evidence[0]!.type = 'other';
      expect(generator.generate(wrongKind), variant.proposition).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    const singleSource = input();
    singleSource.claims[0]!.proposition = 'same_stay';
    singleSource.claims[0]!.evidence = [
      { ...singleSource.claims[0]!.evidence[0]!, type: 'confirmation_token', identityRelation: 'not_applicable', confirmationEquality: 'equal', confirmationStrength: 'labeled' },
      { ...singleSource.claims[0]!.evidence[0]!, type: 'date', identityRelation: 'not_applicable', dateRelation: 'same' },
    ];
    expect(generator.generate(singleSource)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const weakToken = input();
    weakToken.claims[0]!.proposition = 'same_stay';
    weakToken.claims[0]!.evidence = [
      { ...weakToken.claims[0]!.evidence[0]!, type: 'confirmation_token', identityRelation: 'not_applicable', confirmationEquality: 'equal', confirmationStrength: 'unlabeled_numeric' },
      { ...weakToken.claims[0]!.evidence[0]!, type: 'date', identityRelation: 'not_applicable', dateRelation: 'same' },
    ];
    expect(generator.generate(weakToken)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects valid-enum edits and recombinations of issued packets at output boundary', () => {
    const { generator, packet } = generated();
    const otherInput = input();
    otherInput.caseId += '-other';
    otherInput.pdfId += '-other';
    otherInput.claims[0]!.claimId += '-other';
    otherInput.claims[0]!.subjectId = otherInput.pdfId;
    otherInput.claims[0]!.evidence[0]!.subjectId = otherInput.pdfId;
    otherInput.candidateCountBand = 'one';
    const other = generator.generate(otherInput);
    if (!other.ok) throw new Error('Fixture failed');
    const edits: ((value: EvidencePacket) => void)[] = [
      (value) => { value.candidateCountBand = 'one'; },
      (value) => { value.search.snapshot = 'unknown'; },
      (value) => { value.claims[0]!.status = 'candidate'; },
      (value) => { value.claims[0]!.inspection = 'uninspected'; },
      (value) => { value.claims[0]!.evidence[0]!.mailboxClassification = 'unknown'; },
      (value) => { value.claims[0]!.evidence[0]!.parentAddressRoles = ['current_cc']; },
      (value) => { value.caseId = other.value.caseId; },
      (value) => { value.claims = other.value.claims; },
      (value) => { value.nextCursor = other.value.nextCursor; },
    ];
    for (const edit of edits) {
      const mutated = structuredClone(packet);
      edit(mutated);
      expect(generator.validate(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
      expect(generator.serialize(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    }
    expect(generator.serialize(other.value).ok).toBe(true);
  });

  it('binds cursor issuance and private resolution to both case and manifest', () => {
    const { generator, packet } = generated();
    const samePositionOtherCase = input();
    samePositionOtherCase.caseId += '-other';
    const otherCase = generator.generate(samePositionOtherCase);
    const samePositionOtherManifest = input();
    samePositionOtherManifest.manifestId += '-other';
    const otherManifest = generator.generate(samePositionOtherManifest);
    if (!otherCase.ok || !otherManifest.ok) throw new Error('Fixture failed');
    expect(otherCase.value.nextCursor).not.toBe(packet.nextCursor);
    expect(otherManifest.value.nextCursor).not.toBe(packet.nextCursor);
    expect(generator.resolvePrivateCursor(packet.nextCursor, scope())).toEqual({ ok: true, value: input().nextCursor });
    expect(generator.resolvePrivateCursor(packet.nextCursor, { ...scope(), caseId: samePositionOtherCase.caseId })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(generator.resolvePrivateCursor(packet.nextCursor, { ...scope(), manifestId: samePositionOtherManifest.manifestId })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(generator.resolvePrivateCursor(packet.nextCursor, { ...scope(), searchWindow: 'reviewed' })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(generator.resolvePrivateCursor(packet.nextCursor, { ...scope(), windowSourceId: 'other' })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(generator.resolvePrivateCursor(packet.nextCursor, { ...scope(), parentId: 'other' })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(generator.resolvePrivateCursor(packet.nextCursor, { ...scope(), extra: canary })).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
  });


  it('keeps all uninspected or insufficient claims unknown while retaining deterministic evidence', () => {
    const generator = createPacketGenerator(runKey());
    for (const inspection of ['uninspected', 'insufficient'] as const) {
      for (const status of ['supported', 'candidate', 'conflicting'] as const) {
        const source = input();
        source.claims[0]!.inspection = inspection;
        source.claims[0]!.status = status;
        expect(generator.generate(source), `${inspection}/${status}`).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
      }
      const structural = input();
      structural.claims[0]!.inspection = inspection;
      structural.claims[0]!.status = 'unknown';
      const result = generator.generate(structural);
      if (!result.ok) throw new Error('Fixture failed');
      expect(result.value.claims[0]!.evidence[0]!.type).toBe('address');
      expect(result.value.claims[0]!.status).toBe('unknown');
      expect(generator.serialize(result.value).ok).toBe(true);
    }
    const inspectedCandidate = input();
    inspectedCandidate.claims[0]!.status = 'candidate';
    expect(generator.generate(inspectedCandidate).ok).toBe(true);
  });

  it('requires contradictory comparable evidence with provenance on both endpoints', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    const base = claim.evidence[0]!;
    claim.proposition = 'document_version';
    claim.status = 'conflicting';
    claim.evidence = [
      { ...base, evidenceId: 'one', sourceId: claim.subjectId, type: 'document_version', identityRelation: 'not_applicable', sourceRole: 'pdf', observationConflict: 'conflict', comparisonField: 'arrival', comparisonOutcome: 'different' },
      { ...base, evidenceId: 'two', sourceId: claim.objectId, type: 'document_version', identityRelation: 'not_applicable', sourceRole: 'pdf', observationConflict: 'conflict', comparisonField: 'arrival', comparisonOutcome: 'different' },
    ];
    expect(generator.generate(source).ok).toBe(true);
    const changes: ((value: PrivatePacketInput) => void)[] = [
      (value) => { value.claims[0]!.evidence = []; },
      (value) => { value.claims[0]!.evidence[0]!.provenanceAvailable = false; },
      (value) => { value.claims[0]!.evidence[0]!.objectId = 'unrelated'; },
      (value) => { value.claims[0]!.evidence[1]!.sourceId = value.claims[0]!.subjectId; },
      (value) => { value.claims[0]!.evidence[1]!.evidenceId = value.claims[0]!.evidence[0]!.evidenceId; },
      (value) => { value.claims[0]!.evidence[1]!.observationConflict = 'unknown'; },
      (value) => { value.claims[0]!.evidence[1]!.observationConflict = 'consistent'; },
      (value) => { value.claims[0]!.evidence[1]!.type = 'observation'; },
      (value) => { value.claims[0]!.proposition = 'exact_address'; },
      (value) => { value.claims[0]!.inspection = 'uninspected'; },
      (value) => { value.claims[0]!.inspection = 'insufficient'; },
    ];
    for (const change of changes) {
      const invalid = structuredClone(source);
      change(invalid);
      expect(generator.generate(invalid)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    // Conflict assertions about unrelated evidence never promote the claim.
    const unrelated = structuredClone(source);
    unrelated.claims[0]!.evidence.push({ ...base, sourceId: 'unrelated', type: 'other', identityRelation: 'not_applicable', observationConflict: 'conflict' });
    unrelated.claims[0]!.evidence[1]!.provenanceAvailable = false;
    expect(generator.generate(unrelated)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
  });


  it('accepts conflicts only from comparable signals appropriate to each proposition', () => {
    const generator = createPacketGenerator(runKey());
    type Claim = PrivatePacketInput['claims'][number];
    type Evidence = Claim['evidence'][number];
    const cases: { proposition: Claim['proposition']; evidence: Partial<Evidence> }[] = [
      { proposition: 'attachment_parent', evidence: { type: 'attachment', attachmentAttribution: 'verified_snapshot_parent', identityRelation: 'not_applicable' } },
      { proposition: 'same_thread', evidence: { type: 'thread', identityRelation: 'not_applicable' } },
      { proposition: 'exact_header', evidence: { type: 'header', identityRelation: 'not_applicable', headerRelation: 'references', headerDirection: 'parent_to_target' } },
      { proposition: 'exact_address', evidence: { type: 'address', parentAddressRoles: ['current_from'], candidateAddressRoles: ['current_to'] } },
      { proposition: 'same_stay', evidence: { type: 'confirmation_token', identityRelation: 'not_applicable', confirmationEquality: 'different', confirmationStrength: 'structured' } },
      { proposition: 'document_version', evidence: { type: 'document_version', identityRelation: 'not_applicable', comparisonField: 'arrival', comparisonOutcome: 'different' } },
      { proposition: 'later_observation', evidence: { type: 'observation', identityRelation: 'not_applicable', comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'after' } },
    ];
    for (const entry of cases) {
      const source = input();
      const claim = source.claims[0]!;
      const base = claim.evidence[0]!;
      claim.status = 'conflicting';
      claim.proposition = entry.proposition;
      if (entry.proposition === 'attachment_parent') { claim.objectId = source.parentId!; base.objectId = claim.objectId; }
      claim.evidence = [claim.subjectId, claim.objectId].map((sourceId, i) => ({
        ...base, ...entry.evidence, evidenceId: `conflict-${i}`, sourceId, observationConflict: 'conflict',
        ...(entry.proposition === 'attachment_parent' ? { sourceRole: i === 0 ? 'pdf' as const : 'parent_message' as const } : {}),
      }));
      expect(generator.generate(source).ok, entry.proposition).toBe(true);
    }
    const mixed = input();
    const claim = mixed.claims[0]!;
    const base = claim.evidence[0]!;
    claim.status = 'conflicting';
    claim.proposition = 'same_stay';
    claim.evidence = [
      { ...base, sourceId: claim.subjectId, type: 'document_version', identityRelation: 'not_applicable', observationConflict: 'conflict', comparisonField: 'arrival', comparisonOutcome: 'different' },
      { ...base, sourceId: claim.objectId, type: 'observation', identityRelation: 'not_applicable', observationConflict: 'conflict', comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'after' },
    ];
    expect(generator.generate(mixed)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
  });


  it('preserves endpoint role provenance and header direction as fixed facts', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    claim.evidence[0]!.parentAddressRoles = ['current_from', 'original_to'];
    claim.evidence[0]!.candidateAddressRoles = ['current_to', 'original_from'];
    const header = { ...claim.evidence[0]!, evidenceId: `${canary}:header`, type: 'header' as const, identityRelation: 'not_applicable' as const,
      parentAddressRoles: [], candidateAddressRoles: [], headerRelation: 'references' as const,
      headerDirection: 'parent_to_target' as const };
    source.claims.push({ ...claim, claimId: `${canary}:header-claim`, proposition: 'exact_header', evidence: [header] });
    const result = generator.generate(source);
    if (!result.ok) throw new Error('Fixture failed');
    expect(result.value.claims[0]!.evidence[0]).toMatchObject({
      parentAddressRoles: ['current_from', 'original_to'], candidateAddressRoles: ['current_to', 'original_from'],
    });
    expect(result.value.claims[1]!.evidence[0]!.headerDirection).toBe('parent_to_target');
    const reversed = structuredClone(result.value);
    reversed.claims[1]!.evidence[0]!.headerDirection = 'target_to_parent';
    expect(generator.serialize(reversed)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    const wrongHeader = structuredClone(source);
    wrongHeader.claims[1]!.evidence[0]!.headerDirection = 'shared';
    expect(generator.generate(wrongHeader)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const noParentRole = structuredClone(source);
    noParentRole.claims[0]!.evidence[0]!.parentAddressRoles = [];
    expect(generator.generate(noParentRole)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(result.value)).not.toContain(canary);
  });

  it('keeps attributable PDF and later-HMS comparison facts opaque and immutable', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    const base = claim.evidence[0]!;
    claim.proposition = 'later_observation';
    claim.status = 'conflicting';
    claim.objectId = `${canary}:hms`;
    claim.evidence = [
      { ...base, evidenceId: `${canary}:pdf-evidence`, sourceId: claim.subjectId, objectId: claim.objectId,
        type: 'observation', identityRelation: 'not_applicable', sourceRole: 'pdf', parentAddressRoles: [], candidateAddressRoles: [],
        observationConflict: 'conflict', comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'after' },
      { ...base, evidenceId: `${canary}:hms-evidence`, sourceId: claim.objectId, objectId: claim.objectId,
        type: 'observation', identityRelation: 'not_applicable', sourceRole: 'hms_observation', parentAddressRoles: [], candidateAddressRoles: [],
        observationConflict: 'conflict', comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'after' },
    ];
    const result = generator.generate(source);
    if (!result.ok) throw new Error('Fixture failed');
    expect(result.value.claims[0]!.evidence.map((item) => item.sourceRole)).toEqual(['pdf', 'hms_observation']);
    expect(result.value.claims[0]!.evidence[1]).toMatchObject({ comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'after' });
    expect(JSON.stringify(result.value)).not.toContain(canary);
    const mutated = structuredClone(result.value);
    mutated.claims[0]!.evidence[1]!.comparisonField = 'departure';
    expect(generator.serialize(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    for (const change of [
      (item: typeof claim.evidence[number]) => { item.comparisonField = 'departure'; },
      (item: typeof claim.evidence[number]) => { item.comparisonOutcome = 'equal'; },
      (item: typeof claim.evidence[number]) => { item.objectObservationTime = 'unknown'; },
      (item: typeof claim.evidence[number]) => { item.provenanceAvailable = false; },
    ]) {
      const invalid = structuredClone(source);
      change(invalid.claims[0]!.evidence[1]!);
      expect(generator.generate(invalid)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
  });

  it('resumes authenticated candidate and structural cursor mappings without replay', () => {
    const secret = runKey();
    const generator = createPacketGenerator(secret);
    const source = input();
    source.structuralPageCompleteness = 'partial';
    source.structuralCountBand = 'two_to_ten';
    source.structuralPageCountBand = 'one';
    source.nextStructuralCursor = `${canary}:structural-position`;
    const issued = generator.generate(source);
    if (!issued.ok) throw new Error('Fixture failed');
    const packet = issued.value;
    expect(packet.nextCursor).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.nextStructuralCursor).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(packet)).not.toContain(canary);
    expect(generator.resolvePrivateCursor(packet.nextStructuralCursor, scope(), 'structural')).toEqual({ ok: true, value: source.nextStructuralCursor });
    expect(generator.resolvePrivateCursor(packet.nextStructuralCursor, scope())).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(generator.resolvePrivateCursor(packet.nextCursor, scope(), 'structural')).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    const saved = generator.exportCursorState();
    if (!saved.ok) throw new Error('Fixture failed');
    const resumed = createPacketGenerator(secret, saved.value);
    expect(resumed.resolvePrivateCursor(packet.nextCursor, scope())).toEqual({ ok: true, value: source.nextCursor });
    expect(resumed.resolvePrivateCursor(packet.nextStructuralCursor, scope(), 'structural')).toEqual({ ok: true, value: source.nextStructuralCursor });
    expect(resumed.resolvePrivateCursor(packet.nextStructuralCursor, { ...scope(), caseId: 'other' }, 'structural')).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    // A full-packet MAC permits same-key validation without an issuance registry.
    expect(resumed.validate(packet)).toEqual({ ok: true, value: packet });
    expect(resumed.generate(source).ok).toBe(true);
    expect(resumed.validate(packet).ok).toBe(true);
    const tampered = structuredClone(saved.value);
    tampered.entries[0]!.position = canary;
    expect(createPacketGenerator(secret, tampered).generate(source)).toEqual({ ok: false, error: { code: 'INVALID_CURSOR_STATE' } });
    const truncated = structuredClone(saved.value);
    truncated.entries.pop();
    expect(createPacketGenerator(secret, truncated).exportCursorState()).toEqual({ ok: false, error: { code: 'INVALID_CURSOR_STATE' } });
    expect(createPacketGenerator(runKey(), saved.value).exportCursorState()).toEqual({ ok: false, error: { code: 'INVALID_CURSOR_STATE' } });
  });


  it('binds attachment provenance to the packet PDF and actual parent', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    claim.proposition = 'attachment_parent';
    claim.objectId = source.parentId!;
    claim.evidence[0] = { ...claim.evidence[0]!, sourceId: source.pdfId, subjectId: source.pdfId,
      objectId: source.parentId!, sourceRole: 'pdf', type: 'attachment', attachmentAttribution: 'verified_snapshot_parent', identityRelation: 'not_applicable' };
    expect(generator.generate(source).ok).toBe(true);
    const changes: ((value: PrivatePacketInput) => void)[] = [
      (value) => { value.claims[0]!.subjectId = value.parentId!; },
      (value) => { value.claims[0]!.objectId = 'unrelated-parent'; },
      (value) => { value.claims[0]!.evidence[0]!.sourceId = value.parentId!; },
      (value) => { value.parentId = null; },
    ];
    for (const change of changes) {
      const invalid = structuredClone(source); change(invalid);
      expect(generator.generate(invalid)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
  });


  it('distinguishes verified, ambiguous and inventory-only attachment attribution', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    claim.proposition = 'attachment_parent';
    claim.objectId = source.parentId!;
    claim.status = 'unknown';
    claim.inspection = 'uninspected';
    claim.evidence[0] = { ...claim.evidence[0]!, sourceId: source.pdfId, subjectId: source.pdfId,
      objectId: source.parentId!, sourceRole: 'pdf', type: 'attachment', identityRelation: 'not_applicable',
      attachmentAttribution: 'verified_snapshot_parent', provenanceAvailable: true };
    const values = ['verified_snapshot_parent', 'ambiguous_snapshot_occurrence', 'inventory_only_reference', 'unknown'] as const;
    for (const attribution of values) {
      const candidate = structuredClone(source);
      candidate.claims[0]!.evidence[0]!.attachmentAttribution = attribution;
      candidate.claims[0]!.evidence[0]!.provenanceAvailable = attribution === 'verified_snapshot_parent';
      const issued = generator.generate(candidate);
      if (!issued.ok) throw new Error('Fixture failed');
      expect(issued.value.claims[0]).toMatchObject({ status: 'unknown', inspection: 'uninspected', evidence: [
        expect.objectContaining({ attachmentAttribution: attribution, provenanceAvailable: attribution === 'verified_snapshot_parent' }),
      ] });
      const changed = structuredClone(issued.value);
      changed.claims[0]!.evidence[0]!.attachmentAttribution = attribution === 'verified_snapshot_parent' ? 'unknown' : 'verified_snapshot_parent';
      expect(generator.serialize(changed)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
      const invalid = structuredClone(candidate);
      invalid.claims[0]!.evidence[0]!.provenanceAvailable = !invalid.claims[0]!.evidence[0]!.provenanceAvailable;
      expect(generator.generate(invalid)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
      if (attribution !== 'verified_snapshot_parent') {
        for (const status of ['supported', 'candidate', 'conflicting'] as const) {
          const promoted = structuredClone(candidate);
          promoted.claims[0]!.inspection = 'inspected'; promoted.claims[0]!.status = status;
          expect(generator.generate(promoted)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
      }
      expect(JSON.stringify(issued.value)).not.toContain(canary);
    }
    const emptyCandidate = structuredClone(source);
    emptyCandidate.claims[0]!.status = 'candidate'; emptyCandidate.claims[0]!.inspection = 'inspected';
    emptyCandidate.claims[0]!.evidence = [];
    expect(generator.generate(emptyCandidate)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const missing = structuredClone(source);
    missing.claims[0]!.evidence[0]!.attachmentAttribution = 'not_applicable';
    expect(generator.generate(missing)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const wrongType = input();
    wrongType.claims[0]!.evidence[0]!.attachmentAttribution = 'inventory_only_reference';
    expect(generator.generate(wrongType)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const unknownKey = structuredClone(source) as unknown as { claims: Array<{ evidence: Array<Record<string, unknown>> }> };
    delete unknownKey.claims[0]!.evidence[0]!.attachmentAttribution;
    expect(generator.generate(unknownKey)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('verifies stateless reconstructed cursor positions and bounds state across pages and restarts', () => {
    const secret = runKey();
    const generator = createPacketGenerator(secret, undefined, { cursorMode: 'stateless' });
    const source = input();
    const cursorScope = { manifestId: source.manifestId, caseId: source.caseId, searchWindow: source.searchWindow,
      windowSourceId: source.windowSourceId, parentId: source.parentId };
    const firstState = generator.exportCursorState();
    if (!firstState.ok) throw new Error('Fixture failed');
    let first: EvidencePacket | undefined;
    for (let index = 0; index < 100; index++) {
      source.nextCursor = `synthetic-position-${index}`;
      const issued = generator.generate(source);
      if (!issued.ok) throw new Error('Fixture failed');
      first ??= issued.value;
      expect(generator.verifyCursorPosition(issued.value.nextCursor, cursorScope, source.nextCursor)).toEqual({ ok: true, value: true });
    }
    expect(generator.exportCursorState()).toEqual(firstState);
    expect(first!.nextCursor).not.toContain('synthetic-position');
    const restored = createPacketGenerator(secret, firstState.value, { cursorMode: 'stateless' });
    expect(restored.validate(first)).toEqual({ ok: true, value: first });
    expect(restored.verifyCursorPosition(first!.nextCursor, cursorScope, 'synthetic-position-0')).toEqual({ ok: true, value: true });
    for (const changedScope of [
      { ...cursorScope, manifestId: 'other' }, { ...cursorScope, caseId: 'other' },
      { ...cursorScope, searchWindow: 'reviewed' }, { ...cursorScope, windowSourceId: 'other' },
      { ...cursorScope, parentId: 'other' },
    ]) expect(restored.verifyCursorPosition(first!.nextCursor, changedScope, 'synthetic-position-0')).toEqual({ ok: true, value: false });
    expect(restored.verifyCursorPosition(first!.nextCursor, cursorScope, 'synthetic-position-1')).toEqual({ ok: true, value: false });
    expect(restored.verifyCursorPosition(first!.nextCursor, cursorScope, 'synthetic-position-0', 'structural')).toEqual({ ok: true, value: false });
    expect(restored.verifyCursorPosition(canary, cursorScope, 'synthetic-position-0')).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(restored.resolvePrivateCursor(first!.nextCursor, scope())).toEqual({ ok: false, error: { code: 'INVALID_CURSOR' } });
    const changed = structuredClone(first!); changed.search.snapshot = 'unknown';
    expect(restored.validate(changed)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    expect(createPacketGenerator(runKey(), undefined, { cursorMode: 'stateless' }).validate(first)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    expect(JSON.stringify(first)).not.toContain(canary);
  });

  it('rejects contradictory structural page state and safely hides all new fields', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    source.nextStructuralCursor = canary;
    expect(generator.generate(source)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    source.structuralPageCompleteness = 'complete';
    expect(generator.generate(source)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    source.structuralPageCompleteness = 'partial';
    source.structuralCountBand = 'two_to_ten';
    source.structuralPageCountBand = 'one';
    const result = generator.generate(source);
    if (!result.ok) throw new Error('Fixture failed');
    for (const [path, value] of [
      [['structuralPageCompleteness'], 'unknown'],
      [['structuralCountBand'], 'one'],
      [['structuralPageCountBand'], 'zero'],
      [['claims', 0, 'evidence', 0, 'parentAddressRoles', 0], 'original_from'],
      [['claims', 0, 'evidence', 0, 'candidateAddressRoles', 0], 'original_to'],
      [['claims', 0, 'evidence', 0, 'headerDirection'], 'unknown'],
      [['claims', 0, 'evidence', 0, 'comparisonField'], 'arrival'],
      [['claims', 0, 'evidence', 0, 'comparisonOutcome'], 'equal'],
      [['claims', 0, 'evidence', 0, 'objectObservationTime'], 'after'],
    ] as Array<[(string | number)[], string]>) {
      const mutated = structuredClone(result.value);
      setPath(mutated, path, value);
      expect(generator.validate(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
      expect(generator.serialize(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    }
  });


  it('rejects inconsistent header and comparison facts even before inspection', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    source.claims[0]!.status = 'unknown';
    source.claims[0]!.inspection = 'uninspected';
    const item = source.claims[0]!.evidence[0]!;
    item.type = 'header';
    item.identityRelation = 'not_applicable';
    item.headerRelation = 'references';
    item.headerDirection = 'shared';
    expect(generator.generate(source)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    item.headerDirection = 'parent_to_target';
    item.comparisonField = 'unknown';
    item.comparisonOutcome = 'different';
    expect(generator.generate(source)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    item.comparisonField = 'arrival';
    item.observationConflict = 'consistent';
    expect(generator.generate(source)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    item.observationConflict = 'conflict';
    expect(generator.generate(source).ok).toBe(true);
  });



  it('rejects contradictory concrete confirmation comparison fields', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    source.claims[0]!.status = 'unknown'; source.claims[0]!.inspection = 'uninspected';
    const item = source.claims[0]!.evidence[0]!;
    item.comparisonField = 'confirmation'; item.observationConflict = 'unknown';
    for (const [outcome, equality] of [['equal', 'different'], ['different', 'equal']] as const) {
      item.comparisonOutcome = outcome; item.confirmationEquality = equality;
      expect(generator.generate(source)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    item.comparisonOutcome = 'equal'; item.confirmationEquality = 'equal';
    expect(generator.generate(source).ok).toBe(true);
    item.confirmationEquality = 'unknown';
    expect(generator.generate(source).ok).toBe(true);
  });

  it('emits neutral confirmation corroboration only for a surfaced address candidate', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const address = source.claims[0]!;
    address.subjectId = source.parentId!;
    address.status = 'unknown'; address.inspection = 'uninspected';
    address.evidence[0]!.subjectId = address.subjectId;
    const candidate = address.objectId;
    const base = address.evidence[0]!;
    const token = { ...base, type: 'confirmation_token' as const, identityRelation: 'not_applicable' as const,
      parentAddressRoles: [], candidateAddressRoles: [], subjectId: source.pdfId, objectId: candidate,
      confirmationEquality: 'equal' as const, confirmationStrength: 'labeled' as const };
    source.claims.push({ claimId: `${canary}:confirmation-claim`, subjectId: source.pdfId, objectId: candidate,
      proposition: 'confirmation_corroboration', status: 'unknown', inspection: 'uninspected', evidence: [
        { ...token, evidenceId: `${canary}:pdf-token`, sourceId: source.pdfId, sourceRole: 'pdf', observationSourceId: `${canary}:extract` },
        { ...token, evidenceId: `${canary}:mail-token`, sourceId: candidate, sourceRole: 'candidate_message', observationSourceId: null,
          confirmationStrength: 'unlabeled_numeric' },
      ] });
    const issued = generator.generate(source);
    if (!issued.ok) throw new Error('Synthetic fixture failed');
    const claim = issued.value.claims[1]!;
    expect(claim).toMatchObject({ proposition: 'confirmation_corroboration', status: 'unknown', inspection: 'uninspected' });
    expect(claim.evidence.map((item) => item.confirmationStrength)).toEqual(['labeled', 'unlabeled_numeric']);
    expect(claim.subjectId).toBe(issued.value.pdfId);
    expect(claim.objectId).toBe(issued.value.claims[0]!.objectId);
    expect(claim.evidence[0]!.observationSourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.value.claims.some((item) => item.proposition === 'same_stay')).toBe(false);
    expect(JSON.stringify(issued.value)).not.toContain(canary);
    const mutated = structuredClone(issued.value);
    mutated.claims[1]!.evidence[1]!.confirmationStrength = 'labeled';
    expect(generator.serialize(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    const different = structuredClone(source);
    for (const item of different.claims[1]!.evidence) {
      item.confirmationEquality = 'different'; item.confirmationStrength = 'labeled';
    }
    const differentResult = generator.generate(different);
    if (!differentResult.ok) throw new Error('Synthetic fixture failed');
    expect(differentResult.value.claims[1]).toMatchObject({ status: 'unknown', inspection: 'uninspected', evidence: [
      expect.objectContaining({ confirmationEquality: 'different', confirmationStrength: 'labeled' }),
      expect.objectContaining({ confirmationEquality: 'different', confirmationStrength: 'labeled' }),
    ] });
    expect(differentResult.value.claims.some((item) => item.proposition === 'same_stay')).toBe(false);
    const structured = structuredClone(different);
    structured.claims[1]!.evidence[0]!.confirmationStrength = 'structured';
    structured.claims[1]!.evidence[1]!.confirmationStrength = 'structured';
    expect(generator.generate(structured).ok).toBe(true);
    for (const index of [0, 1]) for (const strength of ['unlabeled_numeric', 'unknown'] as const) {
      const weak = structuredClone(different);
      weak.claims[1]!.evidence[index]!.confirmationStrength = strength;
      expect(generator.generate(weak)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    const disagreement = structuredClone(different);
    disagreement.claims[1]!.evidence[0]!.confirmationEquality = 'equal';
    expect(generator.generate(disagreement)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const alteredRelation = structuredClone(differentResult.value);
    alteredRelation.claims[1]!.evidence[0]!.confirmationEquality = 'equal';
    expect(generator.serialize(alteredRelation)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });

    const bad: ((value: PrivatePacketInput) => void)[] = [
      (value) => { value.claims[1]!.status = 'supported'; value.claims[1]!.inspection = 'inspected'; },
      (value) => { value.claims[1]!.status = 'candidate'; value.claims[1]!.inspection = 'inspected'; },
      (value) => { value.claims[1]!.status = 'conflicting'; value.claims[1]!.inspection = 'inspected'; },
      (value) => { value.claims[1]!.inspection = 'inspected'; },
      (value) => { value.claims[1]!.inspection = 'insufficient'; },
      (value) => { value.claims.shift(); },
      (value) => { value.parentId = null; },
      (value) => { value.claims[0]!.subjectId = 'other-parent'; },
      (value) => { value.claims[0]!.objectId = 'other-candidate'; },
      (value) => { value.claims[0]!.evidence[0]!.provenanceAvailable = false; },
      (value) => { value.claims[0]!.evidence[0]!.sourceId = 'other-candidate'; },
      (value) => { value.claims[0]!.evidence[0]!.parentAddressRoles = []; },
      (value) => { value.claims[1]!.subjectId = 'other-pdf'; },
      (value) => { value.claims[1]!.objectId = 'other-candidate'; },
      (value) => { value.claims[1]!.evidence.pop(); },
      (value) => { value.claims[1]!.evidence[0]!.provenanceAvailable = false; },
      (value) => { value.claims[1]!.evidence[1]!.provenanceAvailable = false; },
      (value) => { value.claims[1]!.evidence[0]!.observationSourceId = null; },
      (value) => { value.claims[1]!.evidence[0]!.observationSourceId = value.pdfId; },
      (value) => { value.claims[1]!.evidence[0]!.observationSourceId = value.parentId; },
      (value) => { value.claims[1]!.evidence[1]!.observationSourceId = 'invented-extract'; },
      (value) => { value.claims[1]!.evidence[0]!.sourceId = value.claims[1]!.objectId; },
      (value) => { value.claims[1]!.evidence[1]!.sourceId = value.pdfId; },
      (value) => { value.claims[1]!.evidence[1]!.evidenceId = value.claims[1]!.evidence[0]!.evidenceId; },
      (value) => { value.claims[1]!.evidence[1]!.confirmationEquality = 'different'; },
      (value) => { value.claims[1]!.evidence[1]!.confirmationStrength = 'unknown'; },
    ];
    for (const change of bad) {
      const invalid = structuredClone(source); change(invalid);
      const result = generator.generate(invalid);
      expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it('emits attributed observation comparisons without assuming HMS timing or same stay', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    const base = claim.evidence[0]!;
    claim.proposition = 'observation_comparison';
    claim.status = 'unknown';
    claim.inspection = 'uninspected';
    claim.objectId = `${canary}:hms`;
    claim.evidence = [
      { ...base, evidenceId: `${canary}:pdf-comparison`, sourceId: claim.subjectId, observationSourceId: `${canary}:extract-v1`, objectId: claim.objectId,
        type: 'observation', identityRelation: 'not_applicable', sourceRole: 'pdf', parentAddressRoles: [], candidateAddressRoles: [],
        comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'unknown', observationConflict: 'unknown' },
      { ...base, evidenceId: `${canary}:hms-comparison`, sourceId: claim.objectId, observationSourceId: claim.objectId, objectId: claim.objectId,
        type: 'observation', identityRelation: 'not_applicable', sourceRole: 'hms_observation', parentAddressRoles: [], candidateAddressRoles: [],
        comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'unknown', observationConflict: 'unknown' },
    ];
    for (const time of ['before', 'same', 'after', 'unknown'] as const) {
      for (const outcome of ['equal', 'different', 'unknown', 'not_comparable'] as const) {
        const candidate = structuredClone(source);
        for (const evidence of candidate.claims[0]!.evidence) {
          evidence.objectObservationTime = time;
          evidence.comparisonOutcome = outcome;
        }
        const result = generator.generate(candidate);
        if (!result.ok) throw new Error('Fixture failed');
        expect(result.value.claims[0]).toMatchObject({ proposition: 'observation_comparison', status: 'unknown', inspection: 'uninspected' });
        expect(result.value.claims[0]!.evidence.map((item) => item.sourceRole)).toEqual(['pdf', 'hms_observation']);
        expect(result.value.claims.every((item) => item.proposition !== 'same_stay')).toBe(true);
        expect(JSON.stringify(result.value)).not.toContain(canary);
      }
    }
    const supported = structuredClone(source);
    supported.claims[0]!.status = 'supported';
    expect(generator.generate(supported)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    supported.claims[0]!.inspection = 'inspected';
    expect(generator.generate(supported).ok).toBe(true);
    const conflicting = structuredClone(supported);
    conflicting.claims[0]!.status = 'conflicting';
    expect(generator.generate(conflicting)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    for (const evidence of conflicting.claims[0]!.evidence) evidence.observationConflict = 'conflict';
    expect(generator.generate(conflicting).ok).toBe(true);
  });

  it('fails closed on unattributed or inconsistent observation comparisons', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const claim = source.claims[0]!;
    const base = claim.evidence[0]!;
    claim.proposition = 'observation_comparison';
    claim.status = 'unknown';
    claim.inspection = 'uninspected';
    claim.objectId = `${canary}:hms`;
    claim.evidence = [
      { ...base, evidenceId: 'pdf-evidence', sourceId: claim.subjectId, observationSourceId: `${canary}:extract-v1`, objectId: claim.objectId,
        type: 'observation', identityRelation: 'not_applicable', sourceRole: 'pdf', comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'before' },
      { ...base, evidenceId: 'hms-evidence', sourceId: claim.objectId, observationSourceId: claim.objectId, objectId: claim.objectId,
        type: 'observation', identityRelation: 'not_applicable', sourceRole: 'hms_observation', comparisonField: 'arrival', comparisonOutcome: 'different', objectObservationTime: 'before' },
    ];
    const changes: ((value: PrivatePacketInput) => void)[] = [
      (value) => { value.claims[0]!.evidence.pop(); },
      (value) => { value.claims[0]!.evidence[1]!.provenanceAvailable = false; },
      (value) => { value.claims[0]!.evidence[1]!.sourceId = 'unrelated'; },
      (value) => { value.claims[0]!.evidence[1]!.sourceRole = 'pdf'; },
      (value) => { value.claims[0]!.evidence[0]!.observationSourceId = null; },
      (value) => { value.claims[0]!.evidence[0]!.observationSourceId = value.claims[0]!.subjectId; },
      (value) => { value.claims[0]!.evidence[0]!.observationSourceId = value.claims[0]!.objectId; },
      (value) => { value.claims[0]!.evidence[1]!.observationSourceId = null; },
      (value) => { value.claims[0]!.evidence[1]!.observationSourceId = 'other-observation'; },
      (value) => { value.claims[0]!.evidence[1]!.type = 'other'; },
      (value) => { value.claims[0]!.evidence[1]!.objectId = 'different'; },
      (value) => { value.claims[0]!.evidence[1]!.evidenceId = value.claims[0]!.evidence[0]!.evidenceId; },
      (value) => { value.claims[0]!.evidence[1]!.comparisonField = 'departure'; },
      (value) => { value.claims[0]!.evidence[1]!.comparisonOutcome = 'equal'; },
      (value) => { value.claims[0]!.evidence[1]!.objectObservationTime = 'after'; },
      (value) => { value.claims[0]!.evidence[1]!.objectObservationTime = 'not_applicable'; },
      (value) => { value.claims[0]!.objectId = value.claims[0]!.subjectId; },
      (value) => {
        const claim = value.claims[0]!;
        claim.subjectId = 'other-pdf';
        for (const item of claim.evidence) {
          item.subjectId = claim.subjectId;
          if (item.sourceRole === 'pdf') item.sourceId = claim.subjectId;
        }
      },
    ];
    for (const change of changes) {
      const invalid = structuredClone(source);
      change(invalid);
      const result = generator.generate(invalid);
      expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(JSON.stringify(result)).not.toContain(canary);
    }
    const accepted = generator.generate(source);
    if (!accepted.ok) throw new Error('Fixture failed');
    expect(accepted.value.claims[0]!.evidence[0]!.observationSourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.value.claims[0]!.evidence[0]!.observationSourceId).not.toBe(accepted.value.pdfId);
    expect(accepted.value.claims[0]!.evidence[1]!.observationSourceId).toBe(accepted.value.claims[0]!.objectId);
    const differentExtract = structuredClone(source);
    differentExtract.claims[0]!.evidence[0]!.observationSourceId = `${canary}:extract-v2`;
    const second = generator.generate(differentExtract);
    if (!second.ok) throw new Error('Fixture failed');
    expect(second.value.claims[0]!.evidence[0]!.observationSourceId).not.toBe(accepted.value.claims[0]!.evidence[0]!.observationSourceId);
    expect(second.value.pdfId).toBe(accepted.value.pdfId);
    const mutated = structuredClone(accepted.value);
    mutated.claims[0]!.evidence[1]!.comparisonOutcome = 'equal';
    expect(generator.serialize(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
  });


  it('authenticates the search window and emits only opaque attributable provenance', () => {
    const key = runKey();
    const generator = createPacketGenerator(key);
    const source = input();
    const full = generator.generate(source);
    if (!full.ok) throw new Error('Fixture failed');
    expect(full.value.searchWindow).toBe('full');
    expect(full.value.windowSourceId).toMatch(/^[0-9a-f]{64}$/);
    expect(full.value.windowSourceId).not.toBe(full.value.manifestId);
    expect(JSON.stringify(full.value)).not.toContain(canary);
    expect(JSON.stringify(generator.serialize(full.value))).not.toContain(canary);

    const reviewedSource = structuredClone(source);
    reviewedSource.searchWindow = 'reviewed';
    const reviewed = generator.generate(reviewedSource);
    if (!reviewed.ok) throw new Error('Fixture failed');
    expect(reviewed.value.searchWindow).toBe('reviewed');
    expect(reviewed.value.windowSourceId).toBe(full.value.windowSourceId);
    const altered = structuredClone(full.value);
    altered.searchWindow = 'reviewed';
    // This exact packet was independently issued, so test an unissued combination below.
    const newProvenance = structuredClone(source);
    newProvenance.windowSourceId = `${canary}:different-window-version`;
    const other = generator.generate(newProvenance);
    if (!other.ok) throw new Error('Fixture failed');
    altered.windowSourceId = other.value.windowSourceId;
    expect(generator.validate(altered)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    expect(generator.serialize(altered)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    const otherRun = createPacketGenerator(runKey()).generate(source);
    if (!otherRun.ok) throw new Error('Fixture failed');
    expect(otherRun.value.windowSourceId).not.toBe(full.value.windowSourceId);
  });

  it('keeps unavailable window provenance null and rejects malformed window fields', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    source.searchWindow = 'reviewed';
    source.windowSourceId = null;
    source.search.snapshot = 'unknown';
    const result = generator.generate(source);
    if (!result.ok) throw new Error('Fixture failed');
    expect(result.value).toMatchObject({ searchWindow: 'reviewed', windowSourceId: null, search: { snapshot: 'unknown' } });
    const invalidWindow = { ...source, searchWindow: canary };
    expect(generator.generate(invalidWindow)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const invalidId = { ...source, windowSourceId: '' };
    expect(generator.generate(invalidId)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const extra = { ...source, windowSourceDetails: canary };
    const failure = generator.generate(extra);
    expect(failure).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(failure)).not.toContain(canary);
    const mutated = { ...result.value, searchWindow: 'full' };
    expect(generator.serialize(mutated)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
  });


  it('preserves explicit unresolved and verified-distinct address identities without inference', () => {
    const generator = createPacketGenerator(runKey());
    const source = input();
    const unresolved = generator.generate(source);
    if (!unresolved.ok) throw new Error('Fixture failed');
    expect(unresolved.value.claims[0]!.evidence[0]!.identityRelation).toBe('unresolved');
    expect(JSON.stringify(unresolved.value)).not.toContain(canary);
    const altered = structuredClone(unresolved.value);
    altered.claims[0]!.evidence[0]!.identityRelation = 'distinct_source_identity';
    expect(generator.validate(altered)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    expect(generator.serialize(altered)).toEqual({ ok: false, error: { code: 'INVALID_PACKET' } });
    source.claims[0]!.evidence[0]!.identityRelation = 'distinct_source_identity';
    const distinct = generator.generate(source);
    if (!distinct.ok) throw new Error('Fixture failed');
    expect(distinct.value.claims[0]!.evidence[0]!.identityRelation).toBe('distinct_source_identity');
  });

  it('rejects missing, unsafe or inapplicable identity-relation facts', () => {
    const generator = createPacketGenerator(runKey());
    const missing = structuredClone(input());
    delete (missing.claims[0]!.evidence[0]! as Partial<PrivatePacketInput['claims'][number]['evidence'][number]>).identityRelation;
    expect(generator.generate(missing)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const address = input();
    address.claims[0]!.evidence[0]!.identityRelation = 'not_applicable';
    expect(generator.generate(address)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    const header = input();
    header.claims[0]!.status = 'unknown';
    header.claims[0]!.inspection = 'uninspected';
    header.claims[0]!.evidence[0]!.type = 'header';
    header.claims[0]!.evidence[0]!.headerRelation = 'references';
    header.claims[0]!.evidence[0]!.headerDirection = 'parent_to_target';
    expect(generator.generate(header)).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    header.claims[0]!.evidence[0]!.identityRelation = 'not_applicable';
    expect(generator.generate(header).ok).toBe(true);
    const unsafe = structuredClone(header) as unknown as { claims: Array<{ evidence: Array<{ identityRelation: string }> }> };
    unsafe.claims[0]!.evidence[0]!.identityRelation = canary;
    const error = generator.generate(unsafe);
    expect(error).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(error)).not.toContain(canary);
  });

});
