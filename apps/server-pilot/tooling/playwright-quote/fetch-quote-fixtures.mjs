// Sanitized Hotel Availability data shared by offline reader and projection tests.
export function selectionFixture() {
  const column = {
    value: 1780,
    israteavailable: true,
    restricted: false,
    combClosed: false,
    combClosedToArrival: false,
    combClosedToDeparture: false,
    combMinLOSToArrival: 0,
    combMinLOSToDeparture: 0,
    combMaxLOSToArrival: null,
    combMaxLOSToDeparture: null,
    combMinLOSToThrough: null,
    combMaxLOSToThrough: null,
  };
  const columns = Object.fromEntries([1, 2, 3, 4].map((number) => [`col${number}`, { ...column }]));
  const rate = { code: 'BAR', desc: 'Best Available Rate', currency: 'ZAR', restricted: false, columns };
  const room = {
    code: 'STQN',
    desc: 'Standard Queen',
    children: [rate],
    columns: Object.fromEntries([1, 2, 3, 4].map((number) => [`col${number}`, { value: 3 }])),
  };
  return {
    data: {
      datesList: ['09/24/2026', '09/25/2026', '09/26/2026', '09/27/2026'],
      children: [{ isprop: true, issummary: false, code: 'HRCEN', children: [room] }],
    },
    calendar: {
      headers: ['24-SEP-2026Thursday', '25-SEP-2026Friday', '26-SEP-2026Saturday', '27-SEP-2026Sunday'],
      options: [
        {
          room: { code: 'STQN', inventory: ['3', '3', '3', '3'] },
          rate: 'BAR: Best Available Rate',
          board: 'Bed & Breakfast R',
          prices: ['R1,780.00', 'R1,780.00', 'R1,780.00', 'R1,780.00'],
        },
      ],
    },
    rate,
  };
}

// Compact projection of the sanitized multi-room source response used in fetch-quote.test.mjs.
export function multipleSource() {
  const fixture = selectionFixture();
  const room = fixture.data.children[0].children[0];
  const column = {
    restricted: false,
    israteavailable: true,
    combClosed: false,
    combClosedToArrival: false,
    combClosedToDeparture: false,
    combMinLOSToArrival: 0,
    combMinLOSToDeparture: 0,
    combMaxLOSToArrival: null,
    combMaxLOSToDeparture: null,
    combMinLOSToThrough: null,
    combMaxLOSToThrough: null,
    value: 1780,
  };
  fixture.rate.columns = Object.fromEntries([1, 2, 3, 4].map((number) => [`col${number}`, { ...column }]));
  Object.assign(fixture.rate, {
    isNegotiatedRate: false,
    minLOS: null,
    maxLOS: null,
    minLeadTime: null,
    maxLeadTime: null,
    haspolicies: true,
  });
  room.buildingCode = 'MAIN';
  const second = structuredClone(room);
  second.code = 'STWN';
  second.desc = 'Standard Twin';
  fixture.data.children[0].currency = 'ZAR';
  fixture.data.children[0].children.push(second);
  const visible = structuredClone(fixture.calendar.options[0]);
  visible.room.code = 'STWN';
  fixture.calendar.options.push(visible);
  return fixture;
}

/** G9 HRDAV BAR shop: native BAR/BLRB/BARDIS plus a grid-only WAL Walk-in Rate. */
export function barWalkInSource({ includeNativeWal = false } = {}) {
  const open = {
    israteavailable: true,
    restricted: false,
    combClosed: false,
    combClosedToArrival: false,
    combClosedToDeparture: false,
    combMinLOSToArrival: 0,
    combMinLOSToDeparture: 0,
    combMaxLOSToArrival: null,
    combMaxLOSToDeparture: null,
    combMinLOSToThrough: null,
    combMaxLOSToThrough: null,
  };
  const rateColumns = (amount) =>
    Object.fromEntries([1, 2, 3, 4, 5].map((number) => [`col${number}`, { ...open, value: amount }]));
  const rate = (code, desc, amount) => ({
    code,
    desc,
    currency: 'ZAR',
    isNegotiatedRate: false,
    restricted: false,
    minLOS: null,
    maxLOS: null,
    minLeadTime: null,
    maxLeadTime: null,
    haspolicies: true,
    columns: rateColumns(amount),
  });
  const grid = (code, label, board, amount) => ({
    room: { code: 'STKNG', inventory: ['84', '84', '84', '84', '84'] },
    rate: `${code}: ${label}`,
    board,
    prices: Array(5).fill(`R${Number(amount).toLocaleString('en-US')}.00`),
  });
  const children = [
    rate('BAR', 'Best Available Rate', 4680),
    rate('BLRB', 'Lifestyle Rewards Programme Rate', 4220),
    rate('BARDIS', 'BAR Discount', 3744),
  ];
  if (includeNativeWal) children.push(rate('WAL', 'Walk-in Rate', 4680));
  return {
    data: {
      datesList: ['11/08/2026', '11/09/2026', '11/10/2026', '11/11/2026', '11/12/2026'],
      children: [{
        isprop: true,
        issummary: false,
        code: 'HRDAV',
        currency: 'ZAR',
        children: [{
          code: 'STKNG',
          desc: 'Standard King',
          buildingCode: null,
          children,
          columns: Object.fromEntries([1, 2, 3, 4, 5].map((number) => [`col${number}`, { value: 84 }])),
        }],
      }],
    },
    calendar: {
      headers: [
        '08-NOV-2026Saturday',
        '09-NOV-2026Sunday',
        '10-NOV-2026Monday',
        '11-NOV-2026Tuesday',
        '12-NOV-2026Wednesday',
      ],
      options: [
        grid('BAR', 'Best Available Rate', 'Bed & Breakfast R', 4680),
        grid('BLRB', 'Lifestyle Rewards Programme Rate', 'Bed & Breakfast R', 4220),
        grid('BARDIS', 'BAR Discount', 'Bed & Breakfast R', 3744),
        grid('WAL', 'Walk-in Rate', 'Bed & Breakfast NR', 4680),
      ],
    },
  };
}

export function manyRoomSource(additionalRoomCount = 24) {
  const fixture = multipleSource();
  const property = fixture.data.children[0];
  const baseRoom = property.children[0];
  const baseVisible = fixture.calendar.options[0];
  for (let index = 1; index <= additionalRoomCount; index += 1) {
    const code = `TYPE_${String(index).padStart(2, '0')}`;
    const room = structuredClone(baseRoom);
    room.code = code;
    room.desc = `Room type ${index}`;
    property.children.push(room);
    const visible = structuredClone(baseVisible);
    visible.room.code = code;
    fixture.calendar.options.push(visible);
  }
  return fixture;
}
