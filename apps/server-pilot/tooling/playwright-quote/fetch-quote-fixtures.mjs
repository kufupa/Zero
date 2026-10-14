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
