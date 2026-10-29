# Centurion Stay 360 and arrivals

`centurion-stay360.mjs` starts a fresh Chromium, logs in to Centurion, and opens
Stay 360. Pass an async function to `withCenturionStay360Page` to use that page;
the browser closes after the function returns. Each invocation owns its own
browser. There is no fixed total runtime limit; individual readiness steps may
still have their own timeouts. Development and routine reads use headless mode,
which supports Playwright screenshots. Pass `{ headless: false }` as the second
argument when a headed comparison is needed.

`arrival-ui.mjs` exports `readArrivalFromStay360(page, arrivalNumber)`.
`read-arrival-ui.mjs` joins the two steps. From the worktree root:

```sh
node apps/server-pilot/tooling/playwright-quote/read-arrival-ui.mjs --arrival 1
```

The arrival number is 1-based; if omitted, it defaults to 1. The command prints
raw JSON that can contain guest information. Keep actual values private.

## Current output

| Field | Meaning |
| --- | --- |
| `ok` | The UI actions and extraction finished without an error. This alone does not prove reservation details loaded. |
| `arrivalNumber` | The requested visible arrival row number. |
| `selectedArrivalRow` | Raw text of the selected row from the arrivals list. |
| `details.visibleFormFields` | Visible inputs outside the arrivals grid, each with `label` and `value`; empty values are kept. This includes search controls, not just reservation fields. |
| `details.visibleGridText` | Text from other visible outer grids, excluding the arrivals grid. |
| `details.visiblePageTextOutsideGrids` | Visible page text outside grids, including navigation and other surrounding text. |
| `details.captureScope` | The script's description of its capture scope; it is not proof that a reservation opened. |
| `method` | How the UI was accessed. |
| `elapsedMs` | Total wrapper runtime in milliseconds. |

Field labels come from a nearby form label, then `aria-label`, `name`,
`placeholder`, or element ID. Select fields return selected option text.
Unlabelled inputs are omitted. Hidden and password inputs are excluded;
hidden tabs are not opened. The selected arrivals row is retained separately,
but the rest of the arrivals list is excluded. These are the current capture
limits, not a complete inventory of the reservation.

Errors return `ok: false`, `phase`, `elapsedMs`, and `error`.

## What we observed

In a successful first-arrival run, the row was selected and page text was
returned. The two captured form fields were `search` and `appmenusearch`, both
empty; these were search inputs, not evidence that reservation fields were
empty. No other grid text was captured in that run. It did not establish that
reservation details had loaded.

## For future tools

Keep the fields requested by the caller easy to find, and retain additional
visible data separately instead of silently dropping it. Preserve empty values
and useful context such as the label, page or section, and field type when
available. Distinguish observed values from inferred ones. This is guidance for
future output design: the current tool returns the fields listed above, not a
separate requested/additional schema or extra field metadata.

Do not put guest values or credentials in source files, examples, or shared
notes. Password fields remain excluded.

## Search for a confirmation

```sh
node apps/server-pilot/tooling/playwright-quote/read-confirmation-ui.mjs --confirmation CONFIRMATION-NUMBER
```

The command starts the same Centurion browser, searches Stay 360, selects one
exact confirmation match and prints JSON. No match, duplicate matches, or capped
search results stop the lookup. `readConfirmationFromStay360(page, confirmation)`
can also be called with an already-open page so another action can follow it.

`selectedRow` contains the matching search row. `details.cards` contains the
rendered Stay 360 cards, their source fields, raw card text and any rendered
card grids; `details.visibleFormFields` and `details.visiblePageTextOutsideGrids`
retain other rendered controls and text. Field values are raw UI text and can
include adjacent labels; a `null` value means the control could not be read.
Hidden or collapsed content and unopened tabs are not opened. This does not open
Record View.

The JSON contains guest information. Save it only in a private location, for
example after `umask 077`; do not commit it or include it in shared notes.

## Read Record View

```sh
node apps/server-pilot/tooling/playwright-quote/read-record-view-ui.mjs --confirmation CONFIRMATION-NUMBER
```

The command keeps the 1a result, opens Record View in the same browser, checks
its confirmation number, expands the rendered form sections and returns fields,
checkbox states, displayed text and current grid pages. Other tabs, hidden
content and unloaded grid pages are excluded. The reusable page action is
`readRecordViewFromStay360(page, confirmation)` after selecting the confirmation.

An exact `Note` or `Notes` dialog is captured in the JSON and saved under the
private `.private/stay360-confirmation/` directory before its Close button is
clicked. Other dialogs stop the read. The browser's read-only guard is
heuristic; it does not prove every possible mutating request is blocked.
