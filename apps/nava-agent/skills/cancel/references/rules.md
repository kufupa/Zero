# Cancellation scope and fees

For an identifiable current cancellation that staff can select, publish an editable `propose` action. Link one `cancel` action to one booking. Use the verified HMS confirmation, or `reservation_id: null` with editable guest/date hints for staff selection.

Set `action.details.requested_scope` from the mail: `whole_stay` for the named booking as a whole, `specific_room` for a clearly named room or part, and `unspecified` when unclear. Add editable field specs for `/actions/0/details/requested_scope`, `/actions/0/details/cancellation_reason`, `/actions/0/details/cancellation_note`, and known guest/date hints. Copy an explicit guest reason to `cancellation_note`; leave `cancellation_reason` blank until staff selects an exact current HMS option. `Test Reservations` is Labtest-only. The native cancel tool prepares whole-stay requests only; warn staff when they must handle another scope directly in HMS.

Read current status. Do not submit a second cancellation for a stay that already shows `Cancelled`. Staff alone clicks Go. Preflight does not prove linked-room coverage or future fee policy. Keep unreturned fees unknown, not zero or waived. Show an exact penalty and leave the choice to staff. If the charge changes, Prepare again. If a penalty dialog remains after status changes to `Cancelled`, use the pane's separate staff charge step, not another cancellation. After an uncertain Save, re-read HMS before retrying.

## Corpus evidence

The curated pool has 54 request rows / 51 threads. A SHA-256 sample used 50 unique threads, earliest request per thread; no sampled sender matched the simple known-OTA, internal, or no-reply screen. Request-evidence lexical screens (not field gold): cancel wording 36/50; release/withdraw 8/50; room terms 8/50; partial-scope terms 4/50; stated-reason terms 6/50; fee terms 0/50. Only 2/54 full-pool rows had a confirmation pointer, both in one thread.

All 50 rows have one model-linked reply; 45/50 later hotel messages are in the source thread. First-reply screens found cancellation-complete wording in 25/50 and fee terms in 3/50. These are text signals, not verified HMS outcomes or an audited template. A separate six-thread purposive review found four partial-scope examples and one late-fee exchange. The samples support no default reason, fee, or waiver.
