# Stay 360 reader verification

On 2026-10-30, these checks used Playwright against the real Centurion PMS in
read-only mode. Guest values and confirmation numbers are intentionally omitted.
These are exploratory checks, not a production reliability measurement. They
exercised the combined development version, including lookup improvements in a
subsequent change.

- **1a to 1c:** selected a confirmation, opened Record View and Guest Details,
  and verified that the selected confirmation and active tabs matched.
- **Duplicate confirmation:** lookup without a name returned
  `AMBIGUOUS_CONFIRMATION` with two candidates; name and arrival-date hints
  selected the intended match. Conflicting hints were also checked.
- **Blank search name:** a real search row had no name, although the opened
  details card did. With no name hint the full read succeeded; with a name hint,
  lookup returned `CONFIRMATION_HINT_UNVERIFIED` and the blank candidate.
- **Search date window:** two real reservations outside the initial window were
  found after moving the calendar backwards and forwards, including a
  single-digit start day. Both arrival-date hints selected the expected record.
- **Name matching:** targeted synthetic cases covered title-like surnames,
  prefixed titles, conflicting names and incomplete or blank names.
- **Notes during Record View:** two parallel reads of the same reservation had
  previously timed out after the Notes popup blocked a click (about 46 seconds
  total, including a 30-second click timeout). After the shared handler was
  added, both full reads succeeded in 19.1 and 21.4 seconds. Each automatically
  closed a real Notes popup and returned its notes with private file captures.
- **Wait and dialog safety:** simulated popups inserted into an authenticated
  PMS page verified that Notes closes during a passive wait. An unrelated
  dialog was left open; when it appeared alongside Notes, the operation
  stopped with `UNEXPECTED_DIALOG` without clicking either Close button.
- **Cross-frame safety:** reproduced a Notes popup closing while an unrelated
  dialog was open in the other frame. After the fix, simulated Notes and Other
  dialogs were placed in both frame arrangements on a live PMS page; both runs
  returned `UNEXPECTED_DIALOG` without closing either dialog.
- **Arrival output:** inserted a simulated Notes popup on a live PMS page;
  the arrival read closed it and returned its private capture in `notes`.

The reader modules also passed `node --check`; `git diff --check` passed.
Notes are captured before closing. Only dialogs explicitly titled `Note` or
`Notes` with a unique Close button are handled automatically.
