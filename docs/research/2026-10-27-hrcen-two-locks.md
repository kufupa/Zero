# HRCEN advisory-lock split

## Finding

At 23:41:04Z and 23:41:30Z on 2026-10-27, a read-only inspection found two different PostgreSQL advisory-lock keys for Centurion on the same database. The inspected processes were `http`, `worker` and `ai-worker`. The EC2 checkout was `92be0e5d2a1`.

| Path | Tenant selection | Result |
|---|---|---|
| Pane and worker HRCEN work | Runtime expected-tenant setting | One key |
| HRCEN staff quote | Staff quote installation descriptor `tenantId` | A different key in all inspected processes |
| Prior Pomerado guard 17 | Fixed key | Matched the worker/pane key, not the staff quote key |

The property lock hashes the tenant and property code together. See `apps/server-pilot/src/hms/property-read-lock.ts:76` and `:239-255`. The worker and pane inputs appear in `apps/server-pilot/src/ai/worker.ts:929` and `:985-988`, and `apps/server-pilot/src/ai/pane-stay-save.ts:592-610`. The quote descriptor and its lock call are in `apps/server-pilot/src/ai/staff-quote-installation.ts:233-241` and `apps/server-pilot/src/ai/staff-quote-run.ts:637-639` and `:762-765`. CLI reads permit an explicit tenant override in `apps/server-pilot/tooling/playwright-quote/read-cli-lease.mjs:105-113`.

## Meaning and limits

The two paths need not exclude each other through their advisory locks. This is a concurrency risk, not evidence that simultaneous browser actions or a guest-impacting collision occurred. Prior trial guard 17 cannot be described as serializing against both currently configured paths. Explicit CLI tenant overrides could produce other keys; their current use was not established.

For this trial, a guard that holds both observed keys, verifies each holder and stops browser work on loss is a candidate mitigation. It is not yet run or proven and does not establish coverage of unknown overrides. This finding does not authorize changing production configuration, restarting services, or changing the product's lock design.
