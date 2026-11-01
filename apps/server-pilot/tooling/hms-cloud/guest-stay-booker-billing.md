# Stage Booker and billing reference on a fake draft

`stageGuestStayBookerBilling(page, input)` is an internal, draft-only HRCEN
adapter. It never calls Save, sends a message, cancels a stay, or integrates
with `create-reservation.mjs`. Use a caller-owned page with the shared
read-only context guard already installed and serialize all page actions. Create
the browser context with `serviceWorkers: 'block'` and set
`serviceWorkersBlocked: true` to attest that prerequisite. The adapter also
requires the pinned Playwright client's private `context._options.serviceWorkers`
to be `block` and its public `context.serviceWorkers()` to return an empty array.
It checks again before and after page actions. This private property is not a
stable Playwright API; if unavailable, changed, or inconsistent, the adapter
fails closed. Service-worker requests can bypass Playwright routing. The existing
`withBookingLookupSession` bootstrap does not explicitly block service workers,
so it does not by itself satisfy this prerequisite. Do not use it on a real guest.

**Important:** Once preflight succeeds, this tool installs a page-lifetime
route that blocks page-intercepted POST and other mutating methods, plus dangerous GET
paths and write-style `pageaction` queries. It remains in force until the page
closes, even on success. This protects against delayed field-change requests,
but also prevents later lookups, rate changes and Save on that page. Stage on
a separate fake-draft page; this is not a drop-in step in the create flow.
Other page routes must use `route.fallback()`, never `route.continue()`, or
they can bypass this fence. A blocked request or uncertain result means discard
the page and inspect/reconcile independently before another attempt. A request
already dispatched to HMS can still complete.

## Input

```js
import { stageGuestStayBookerBilling } from './guest-stay-booker-billing.mjs';

const result = await stageGuestStayBookerBilling(page, {
  propertyCode: 'HRCEN',
  serviceWorkersBlocked: true,
  bookerName: 'Synthetic Booker',
  bookerContact: 'synthetic@example.invalid',
  billingReference: 'PO-SYNTHETIC-123',
});
```

| Input | Native field | Meaning |
| --- | --- | --- |
| `bookerName` | `caller` | Booker Name |
| `bookerContact` | `udfchar06` | Booker Contact, not a confirmation-recipient instruction |
| `billingReference` | `billingreference` | Billing Reference |

Provide at least one field. An omitted property is left untouched; `''` means
explicit clear. `undefined`, `null`, nonstrings, control characters, unknown
keys and values over 4000 characters are rejected before staging. Text is not
trimmed. The input element and Ext component length limits are checked before
any change. Unsupported controls, native component data or submit readbacks fail
closed. The adapter does not infer values from an email, historical frequency,
profile, address or confirmation-recipient field.

The current saved-record adapter maps `caller` and `udfchar06` to those Booker
labels. The scout's new-stay `readGuestStayForm` observed all three native
names as visible, enabled and non-readonly, but Billing Reference had no label
in that observation. A prior form inventory recorded its label as Billing
Reference. Visibility and history do **not** establish billing writeability,
field semantics, lack of side effects or persistence. Existing
`setGuestStayText` has separate live unsaved Booker readback evidence. The
wrapper's three-field live unsaved staging observation is described below.

## Guards and output

- Preflight requires the Cloud origin, HRCEN, an unsaved `New` form, blank
  confirmation, its native blank draft IDs and a stable booking session.
- The form's displayed and native names must be Proof Labtest, with arrival and
  departure in 2027 or later and arrival before departure. A nonblank guest ID
  requires the current same-page verified fake profile; nonblank A/R IDs require
  current same-page A/R proof. Other guarded reservation, stay and profile IDs
  must be blank. Unverified or stale selections fail closed.
- Every supplied field must have one visible, editable component in that form,
  equal DOM, native value and native submit data before staging. Its own length
  limit applies. The Booker actions reuse `setGuestStayText`; Billing Reference
  uses the text control directly behind the stricter page fence.
- After each field and again at the end, the adapter compares visible value,
  Ext value and submit data, identity, visible fields, scalar native-record
  values and the unrequested Booker/billing controls. A changed scalar target
  model must equal the requested value; an unchanged model is explicitly
  reported as `unchanged_preimage`. Unexpected effects, native disagreement,
  blocked requests, stale proof or a dialog stop further changes. The default
  whole-action deadline is 30 seconds; the optional third argument `timeoutMs`
  can shorten it, but cannot extend it beyond 30 seconds.
- `updated_unsaved` and `unchanged_unsaved` return each requested value and its
  visible, native and submit readbacks, scalar model status, observed changed
  field names, and `persistence: 'not_attempted'`. They do **not** prove HMS
  would save these values. Returned field values are private.
- `input_gap` and `unsupported` describe preflight failures. `execution_failure`
  indicates no setter was attempted. `action_uncertain` means a setter may
  have changed the draft. It includes fields verified before the failure and,
  when available, changed field names and separate `blockedRequestCount`
  (outer lifetime fence) and `innerBlockedRequestCount` (delegated Booker
  guard). Counts describe aborts observed before return and contain no request
  details. It does not roll back or claim success. Never retry on that page.
- A native dialog, blocked request, unsafe context or deadline immediately
  quarantines the page and requests `page.close({ runBeforeUnload: false })` without accepting the
  dialog. Page closure is intended to interrupt in-flight operations, and delegated
  setter calls are gated against issuing follow-up actions while retaining the
  original page identity and its delegated busy lock. Closure is not
  awaited, so `pageCloseRequested` does not prove the page closed. A failed or
  stalled close cannot cancel an already-dispatched browser operation or HMS
  request; isolate the page and independently dispose the context before reuse.
  No post-interruption readback is attempted.
- `changes.modelCoverage` lists native record keys whose non-scalar values were
  not compared. Hidden server-side effects and changes within those values are
  not observed. The field named `model` is not an independent saved readback.
  Full server persistence and all side effects remain unknown.

## Live unsaved staging observation

On 2026-11-01, one HRCEN draft was opened in an independent Chromium context
with service workers blocked and the shared read-only guard installed. The
current same-page Proof Labtest profile and blank-confirmation new draft were
verified before the 2027-09-14 to 2027-09-16 dates were entered. The profile
proof and dates were checked again before staging. The adapter was invoked once
with all three synthetic values. No Save or send was attempted.

All three fields changed from blank and their visible, native component and
native submit values matched the requested synthetic values. The native record
model retained its blank preimage for each field. Only the three requested
visible fields changed; no scalar record fields changed. The adapter reported
`updated_unsaved`, no unexpected dialog and zero requests blocked by its fence
during staging. It kept that fence until the page closed. This is not a saved
record readback and does not prove persistence, semantic correctness or hidden
server-side effects.

The shared read-only guard blocked the observed vault card-entry POST during
draft opening. An external chat GET was also aborted during setup; the reason
for that abort is not established. No failed request was observed during the
adapter invocation. Private before/after screenshots, field readbacks, profile
proof, adapter result and request-failure records are in the mode-0700
`/home/orca/.local/share/zero/research/booker-billing-proof/2026-11-01T23-18-54-308Z-661680/`
directory; files are mode 0600. These are private and must not be committed.

An initial independent setup did not reach the adapter because opening Guest
Stay failed. Its exact cause was not captured. The successful setup first
followed the existing Stay 360 navigation path, but this does not establish the
cause of the first failure.

The synthetic tests are `guest-stay-booker-billing.test.mjs`. Run them only
through the approved remote test route. This dispatch did not run local tests
or typechecks.
