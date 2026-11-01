# Labtest create readback

`readLabtestCreate` opens a confirmation with a fresh saved-stay session and
compares its visible Record View against the expected Proof Labtest create.
It reports missing, ambiguous and mismatched fields; notes are compared exactly.
An omitted source or organization is not compared. Child ages are represented
by the counts and age bands exposed by Record View, not exact individual ages.

The expected stay, guest ID, note, room, rate, displayed guarantee and all
three child bands are required. `guarantee` is the displayed label, not the
native `guaranteeType` code. For example:

```js
await readLabtestCreate({
  confirmation: '123456-1',
  stay: { arrival: '2027-03-15', departure: '2027-03-17' },
  expected: {
    arrival: '2027-03-15', departure: '2027-03-17', guestId: '123',
    adults: 2, children: 0, childBands: { child1: 0, child2: 0, child3: 0 },
    roomType: 'DLXKNG', ratePlan: 'BAR', note: 'Proof Labtest example',
    guarantee: 'Non-Guaranteed Individual', organization: '',
  },
});
```

`reconcileLabtestCreate` makes a fresh, read-only same-arrival Labtest census
and reads each matching candidate when the census is complete. It returns the
census, confirmations and comparisons as evidence, not as proof that any one
candidate was created by the caller. It never saves, retries, sends or changes
a reservation. The caller must keep an uncertain create uncertain until the
evidence is independently resolved. Outputs can contain personal data; keep
them private.
