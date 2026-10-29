# HMS diagnostics

The Stay 360 implementation and its commands remain in the parent folder; see
[Stay 360 commands](../STAY360-ARRIVALS.md). Reusable, standalone probes belong
in this folder. Do not commit guest data, browser captures or credentials.

## Reusable probe

`party-lookup-batch-probe.mjs` checks two synthetic party searches in a borrowed
HMS browser. It reports outcomes and timings, not guest data. Run it only with
the approved EC2, browser and property setup.

The existing `hms-deeplink-probe.mjs` and `session-reuse-probe.mjs` remain in
the parent folder because other workflows and historical references use those
paths.

## Stay 360 Record View findings

[PR #719](https://github.com/kufupa/Zero/pull/719) added a confirmation search
and Record View read in the same browser. In a read-only sample of 10 lookups,
all 10 matched the supplied confirmation, guest, dates, adults and rates; each
returned 118 fields, and all 110 checkbox values were booleans. Peak concurrency
was 10 browsers. This small sample is not a production accuracy measurement.

Search result cells can contain multiple confirmation numbers on separate
lines, so the reader matches the whole line. Short fixed run limits failed
under concurrent load; individual actions now use finite timeouts.

No Note dialog appeared in the sample, so that path is not live-verified. Slow
section expansion may still result in missing fields. Other tabs and unloaded
grid pages are outside the capture.
