import { extractReservationistPlan } from '../src/ai/reservationist-extraction.js';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';

const at = '2026-10-04T08:00:00Z';
async function extract(
  rows: string[],
  roomValues: unknown[],
  guests: unknown[] = [],
  mode: 'combined' | 'task_first' = 'combined',
) {
  const text = ['Please quote.', '12–15 October 2026', ...rows].join('\n');
  const sourceHash = createHash('sha256').update(text).digest('hex');
  const source = (quote: string) => ({
    attachmentId: 'message:allocation',
    sourceHash,
    page: 1,
    quote,
  });
  const rooms = roomValues.map((value, index) => ({
    id: `room-${index}`,
    kind: 'room',
    value,
    disclosure: 'guest',
    source: source(rows[index]!),
  }));
  const guestFacts = guests.map((value: any, index) => ({
    id: `guest-${index}`,
    kind: 'guest',
    value,
    disclosure: 'guest',
    source: source(rows[Number(value.roomRef) - 1]!),
  }));
  const facts = [...rooms, ...guestFacts];
  const task = {
    id: 'quote',
    kind: 'quote',
    factIds: facts.map((fact) => fact.id),
    source: source('Please quote.'),
  };
  let calls = 0;
  const invoke = vi.fn(async (request: any) => {
    const isTasks = ++calls === 1;
    return {
      output:
        mode === 'task_first'
          ? isTasks
            ? { facts: [], tasks: [{ ...task, factIds: [] }], unresolvedAsks: [] }
            : {
                facts,
                assignments: [{ taskId: 'quote', factIds: task.factIds }],
                unresolvedAsks: [],
              }
          : { facts, tasks: [task], unresolvedAsks: [] },
    };
  });
  const result = await extractReservationistPlan({
    adapter: { invoke, reserveCalls: vi.fn(async () => {}) } as never,
    mode: mode === 'combined' ? undefined : mode,
    messages: [{ id: 'allocation', at, direction: 'inbound', text }],
    causalAt: at,
    admissions: [],
    signal: new AbortController().signal,
  });
  return { result, invoke };
}

it.each(['combined', 'task_first'] as const)(
  'accepts source-bound explicit ordinal/numbered rooms in %s extraction',
  async (mode) => {
    const rows = [
      '1st Room - couple - Pastors Alex & Jamie Example',
      '2nd Room - 1 person - Morgan Sample',
      'Room 3: 1 adult - Robin Visitor',
    ];
    const roomValues = [
      { roomRef: '1', quantity: 1, adults: 2, childAges: [] },
      { roomRef: '2', quantity: 1, adults: 1, childAges: [] },
      { roomRef: '3', quantity: 1, adults: 1, childAges: [] },
    ];
    const guests = [
      { firstName: 'Alex', lastName: 'Example', roomRef: '1' },
      { firstName: 'Jamie', lastName: 'Example', roomRef: '1' },
      { firstName: 'Morgan', lastName: 'Sample', roomRef: '2' },
    ];
    const { result, invoke } = await extract(rows, roomValues, guests, mode);
    expect(result.facts.filter((fact) => fact.kind === 'room').map((fact) => fact.value)).toEqual(
      roomValues,
    );
    expect(result.facts.filter((fact) => fact.kind === 'guest').map((fact) => fact.value)).toEqual(
      guests,
    );
    expect(
      result.facts.every(
        (fact) => fact.verification === 'text_verified' && fact.authority === 'customer_claim',
      ),
    ).toBe(true);
    expect(result.tasks[0].factIds).toHaveLength(6);
    const factPrompt = invoke.mock.calls.at(-1)![0].systemPrompt;
    expect(factPrompt).toContain('numbered or ordinal room labels');
    expect(factPrompt).toContain('local allocation identifiers');
    expect(factPrompt).toContain('never native room IDs');
    expect(factPrompt).toContain('missing child ages');
  },
);

it.each([
  ['1st Room - 1 adult and 2 children', { roomRef: '1', quantity: 1, adults: 1, childAges: [] }],
  [
    '1st Room - 1 adult and 2 children aged 7',
    { roomRef: '1', quantity: 1, adults: 1, childAges: [7] },
  ],
  ['1st Room - couple and child aged 7', { roomRef: '1', quantity: 1, adults: 2, childAges: [] }],
  ['1st Room - 1 person - child aged 7', { roomRef: '1', quantity: 1, adults: 1, childAges: [] }],
  ['1st Room - 2 people', { roomRef: '1', quantity: 1, adults: 2, childAges: [] }],
  [
    '1st Room - single occupancy - child aged 7',
    { roomRef: '1', quantity: 1, adults: 1, childAges: [] },
  ],
  ['1st Room - couple - 1 adult', { roomRef: '1', quantity: 1, adults: 2, childAges: [] }],
  ['1st Room - 2 rooms - 1 adult each', { roomRef: '1', quantity: 1, adults: 1, childAges: [] }],
  ['1st Room - not required - 1 adult', { roomRef: '1', quantity: 1, adults: 1, childAges: [] }],
  [
    'Two rooms - Alex Example and Morgan Sample',
    { roomRef: '1', quantity: 1, adults: 1, childAges: [] },
  ],
  [
    'From: Earlier request\n1st Room - 1 adult',
    { roomRef: '1', quantity: 1, adults: 1, childAges: [] },
  ],
])('rejects unsupported or contradictory allocation %s', async (row, value) => {
  await expect(extract([row], [value])).rejects.toThrow('entailed');
});

it('retains complete explicit child ages on a numbered adult allocation', async () => {
  const value = { roomRef: '2', quantity: 1, adults: 1, childAges: [7, 12] };
  const { result } = await extract(['2nd Room - 1 adult and 2 children aged 7 and 12'], [value]);
  expect(result.facts[0].value).toEqual(value);
});

it('does not borrow an ordinal label or guest assignment from another row', async () => {
  await expect(
    extract(['2nd Room - 1 adult'], [{ roomRef: '1', quantity: 1, adults: 1, childAges: [] }]),
  ).rejects.toThrow('entailed');
  await expect(
    extract(
      ['1st Room - 1 adult - Alex Example', '2nd Room - 1 adult - Morgan Sample'],
      [],
      [{ firstName: 'Morgan', lastName: 'Sample', roomRef: '1' }],
    ),
  ).rejects.toThrow('entailed');
});

it('retains single occupancy without inventing a native room or guest age', async () => {
  const value = { roomRef: '4', quantity: 1, adults: 1, childAges: [] };
  const { result } = await extract(['4th Room - single occupancy'], [value]);
  expect(result.facts[0].value).toEqual(value);
  expect(result.facts[0].value).not.toHaveProperty('roomIndex');
  expect(result.facts[0].value).not.toHaveProperty('age');
});

it('accepts an explicit couple count when the matching total person count is printed', async () => {
  const value = { roomRef: '1', quantity: 1, adults: 2, childAges: [] };
  const { result } = await extract(
    ['1st Room - 2 people (Couple) Pastors Alex & Jamie Example'],
    [value],
  );
  expect(result.facts[0].value).toEqual(value);
});

it('rejects a person count contradicting independently explicit adult occupancy', async () => {
  await expect(
    extract(
      ['1st Room - 3 people (Couple)'],
      [{ roomRef: '1', quantity: 1, adults: 2, childAges: [] }],
    ),
  ).rejects.toThrow('entailed');
});
