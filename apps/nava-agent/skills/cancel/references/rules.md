# Cancellation scope + fees

- K01 Current explicit cancel/release existing stay → cancel. “No longer checking in/travelling” may indicate intent; still establish saved target. Quote withdrawal with no booked stay → no HMS cancellation. Subject “Quotation” does not prove booking absent.
- K02 Resolve property + native reservation + guest/stay. Confirmation ref informs candidate lookup, not guessed native ID. Missing/ambiguous target → clarify; failed lookup never claims “no booking exists.”
- K03 Preserve requested individual/room/stay scope. Remove entire extra room → that item cancel; remove last night → date amendment; unrelated dates/guests remain. Group/share/associated reservation header not proof complete scope. Unsupported group cancellation → staff review, retaining independent individual task.
- K04 Fresh cancelled status → never second cancel. Report actual status, cancellation number if exposed; missing identifier remains unknown. In-house, completed, no-show, conflicting/unknown or native-unsupported state → staff review, not skip active ask. Current writer supports `Reserved`; script scope not new hotel policy.
- K05 Native order: verify target → current reason code + meaning and note → preview fee and supported charge/waive choice before Go → commit → fresh readback. No guessed reason code. Missing supported native preview/choice → staff review.
- K06 Preflight fee/policy may be `unknown_precommit`/unknown. Deposit, balance, zero folio, native prepaid flag never prove no cancellation charge. Show actual native penalty text/amount/currency when available. No invented waiver/fee/late threshold.
- K07 / R9: one Go. Show native fee and supported charge/waive choice in `waiting_go` before staff Go (fee wording in 5–10/51 threads; staff outcomes varied). Never auto-accept changed/new charge or ask for second Go in same flow. If native fee only appears after commit, report mismatch, fresh-read cancellation and actual charge, then staff review; never re-cancel to reach dialog.
- K08 Publish before `hms_save`; real staff Go, Labtest exception per common. Fresh target + saved Cancelled state establish outcome; cancellation identifier and charge where exposed retained. Missing/disagreeing readback → explicit uncertainty; no success fabricated from dialog click or email reply.
- K09 Already cancelled confirmed → status reply/skip write. Missing evidence → needs info; unsupported native scope/status/charge → staff review. No blanket auto-decline policy. No fake stage when cancel adapter absent.

## Fields in native staff order

Target/property/guest/stay + affected room → status → live cancellation reason code/meaning → cancellation note → penalty preview/decision when exposed → Save → status/cancellation number/charge readback.

`apps/server-pilot/tooling/hms-cloud/guest-stay-cancel*`, `cancellation-preflight-session*`, `cancel-association-scope.mjs` support this transaction. Complete visual order and all-property parity not proved. Native helper note limit 200 chars; expose limit if that handler applies, never silently truncate supplied reason. Preflight currently read/prepare only, not commit proof.

No native body/key/count pinning. Verify intended target, scope, status, reason and actual charge outcome.
