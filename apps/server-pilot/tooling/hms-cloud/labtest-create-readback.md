# Labtest create readback

`readLabtestCreate` opens a confirmation with a fresh saved-stay session and
compares its visible Record View against the expected Proof Labtest create.
It reports missing, ambiguous and mismatched fields; notes are compared exactly.
An omitted source or organization is not compared. Child ages are represented
by the counts and age bands exposed by Record View, not exact individual ages.

`reconcileLabtestCreate` makes a fresh, read-only same-arrival Labtest census
and reads each matching candidate when the census is complete. It returns the
census, confirmations and comparisons as evidence, not as proof that any one
candidate was created by the caller. It never saves, retries, sends or changes
a reservation. The caller must keep an uncertain create uncertain until the
evidence is independently resolved. Outputs can contain personal data; keep
them private.
