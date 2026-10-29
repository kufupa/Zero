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

## Browser resource benchmark

`stay360-benchmark.mjs` runs the same confirmation and Record View readers in
separate Chromium browsers. The private input is a mode-0600 JSON array; each
item supplies `confirmation`, `guest`, `arrival`, `departure`, `adults`,
`averageRate` and `totalRate` as expected values. Guest data is
never printed by the benchmark.

Run it inside a cgroup v2 scope with a finite memory limit, for example:

```sh
sudo systemd-run --scope --uid=orca -p MemoryMax=10G -p MemorySwapMax=1G -p CPUQuota=600% -p TasksMax=8192 \
  node apps/server-pilot/tooling/playwright-quote/diagnostics/stay360-benchmark.mjs \
  --input .private/stay360-benchmark/inputs.json --mode headless --count 10 --delay-ms 200
```

For headed Chromium, put `xvfb-run -a -s '-screen 0 1440x1000x24'` before
`node` and use `--mode headed`; the X server is included in the scope's resource
measurements. The runner repeats input rows when `--count` exceeds the input
length. It fetches credentials before spacing Chromium launch requests by the
requested delay, and reports the observed process-start intervals: actual starts
can bunch up under load. It samples CPU, cgroup memory (including cache), browser
count and disk I/O, and stops its workers if scope memory reaches 85% of the
limit or host available memory falls below 4 GiB. It reports aggregate checks
and timings only.

### 2026-10-29 measurements

One read-only batch per setting on the same VPS, with a six-core CPU quota and
1 GiB swap limit per scope. Peak RAM is cgroup memory, including cache and, for
headed runs, Xvfb. The ten-browser scopes had a 12 GiB cap; the sixteen-browser
scopes had a 16 GiB cap. Wall time includes credentials, login, both readers and
browser shutdown.

| Browsers | Mode | Passed | Wall | Peak RAM | CPU time | Disk written |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10 | Headless | 10/10 | 42.8 s | 6.5 GiB | 250 s | 162 MiB |
| 10 | Headed | 10/10 | 51.4 s | 7.6 GiB | 302 s | 252 MiB |
| 16 | Headless | 16/16 | 71.2 s | 10.2 GiB | 413 s | 552 MiB |
| 16 | Headed | 16/16 | 88.6 s | 11.6 GiB | 515 s | 319 MiB |

The sample contains ten real confirmations, with six repeated in the 16-browser
runs. Expected values came from earlier diagnostic records; independent ground
truth has not been established. All returned 118 fields; no Note dialog
appeared. These single batches are not a production accuracy or capacity bar.

The ten-browser runs spaced worker starts by 200 ms. The sixteen-browser runs
spaced Chromium launch requests by 200 ms after fetching credentials; actual
process starts varied under load. The original process counter also counted an
extra transient process in the headed 16-browser run, so its process-start
intervals are not reliable. The counter now checks the browser's parent.

An earlier 10-headed run passed only 5/10 with a four-second search-field wait;
a later headless run hit the ten-second Record View limit. The readers now use
30-second limits, and the batches above passed after that change. We did not
attempt 100 browsers: rough linear scaling from 16 suggests 64–72 GiB of scoped
RAM alone, more than the VPS has available. That estimate is not a measurement.
