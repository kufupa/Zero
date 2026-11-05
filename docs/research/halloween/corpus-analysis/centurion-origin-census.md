# Centurion sender-origin census

**Finding, 2026-11-01:** sender origin and the work requested need separate labels. The saved snapshot includes **118** incoming `synxis.com` rows whose subjects contain `reservation failed to integrate`; all 118 also have a no-reply sender clue. Earlier, the owner confirmed that examples of this alert required staff to check bookings. The new 118 is a subject-pattern count, not a review proving 118 separate staff tasks or Nava-supported cases.

## Scope and counts

The saved Centurion snapshot covers stored dates **27 July–29 October 2026**, ending at `2026-10-29T17:27:24.399Z`. It contains **11,211 incoming and 4,830 outgoing source rows**. All 16,041 selected rows have usable stored date prefixes. These are saved-source counts, not proof of complete delivery or mailbox capture. The snapshot has 1,171 unresolved duplicate candidates; retain source rows rather than treating these as established duplicates. Stored-date timezone is unverified. See [source inventory](../corpus-experiments/month-source-inventory.md#scope-and-method).

Selected exact `From` hosts among inbound source rows:

| Exact host | All saved inbound | No-reply sender clue | Subject contains failure phrase |
|---|---:|---:|---:|
| `synxis.com` | 902 | 861 | 118 |
| `booking.com` | 348 | 348 | 0 |
| `profitroom.com` | 234 | 232 | 0 |
| `travelit.co.za` | 262 | 0 | 0 |
| `nexustravel.co.za` | 206 | 0 | 0 |
| `legacyhotels.co.za` | 2,946 | 0 | 0 |

The first three exact hosts together account for **1,484 / 11,211 (13.2%)** inbound rows. Across all hosts, **2,218 / 11,211 (19.8%)** have a no-reply sender clue. These are not counts of all OTA mail or of automated, ignorable or actionable messages. These selected-host rows had no multiple-`From` addresses, so the three host counts do not overlap in this snapshot. A no-reply address is a clue, not proof of automation; an exact `From` host is not authentication and does not establish the sender's role or the message's requested work. Other domains and subdomains are not included in the three host counts. The current [source matcher](../../../../apps/server-pilot/src/ai/mail-source.ts) also accepts registered-host subdomains, so this exact-host census is not its routing count.

The saved snapshot's available canonical header keys are `Message-ID`, `In-Reply-To`, and `References`; it has no raw MIME. Consequently it cannot verify automation headers such as `Auto-Submitted`. This is a source limitation, not evidence that those headers were absent in the original messages.

### Most frequent inbound sender hosts

A separate scan ranked **all** exact `From` hosts, rather than checking only a selected list. These are the 16 hosts with at least 100 saved inbound rows; together they account for 7,159 of 11,211 rows. No inbound row had a missing parseable host or multiple `From` addresses in this snapshot. The remaining 4,052 rows came from lower-frequency hosts. Hosts are reported exactly as stored; domains and subdomains are not combined.

| Exact `From` host | Saved inbound rows |
|---|---:|
| `legacyhotels.co.za` | 2,946 |
| `synxis.com` | 902 |
| `gmail.com` | 501 |
| `booking.com` | 348 |
| `grfeedback-b.com` | 313 |
| `nedbank.co.za` | 267 |
| `travelit.co.za` | 262 |
| `mailgun.tvlinc.com` | 235 |
| `profitroom.com` | 234 |
| `nexustravel.co.za` | 206 |
| `atlantiscorporate.co.za` | 193 |
| `fortimail-01.vox.co.za` | 173 |
| `guestrevuapp.com` | 171 |
| `fortimail-02.vox.co.za` | 161 |
| `renniesbcdtravel.com` | 138 |
| `thompsons.co.za` | 109 |

[Ranked-domain script](rank-inbound-domains.py); all 16 counts were independently rechecked with [source-origin-counts.py](source-origin-counts.py). A sender host alone does not establish message type, authentication, a staff action, or whether Nava could help.

### Most frequent outbound recipient hosts

The following exact `To` hosts each occur in at least 100 of the **4,830 saved outbound rows**. A row can have multiple recipient hosts, so these counts can overlap. **516** rows have no parseable `To` host and **250** have more than one; CC and BCC are not counted. These are saved rows, not proof of delivery or distinct recipients. Hosts and subdomains remain separate.

| Exact `To` host | Saved outbound rows |
|---|---:|
| `legacyhotels.co.za` | 1,124 |
| `gmail.com` | 446 |
| `nexustravel.co.za` | 198 |
| `atlantiscorporate.co.za` | 185 |
| `guest.booking.com` | 169 |
| `tollink.co.za` | 158 |
| `destinitravel.co.za` | 102 |

The [aggregate-only recipient-domain script](rank-outbound-domains.py) parses `To` fields from the same pinned source and active transport. It suppresses hosts below its minimum reporting threshold and never prints addresses or message contents.

In the previously studied **28 September–23 October** window, the same saved snapshot contains 3,843 inbound and 1,386 outbound rows, including 422 `synxis.com` inbound rows. **51** of those subjects contain the failure phrase, all with a no-reply sender clue. This window overlaps the full snapshot and is not additional volume. A second, independently written [local recheck](recheck-centurion-census.py) reproduced the relevant subject counts; it found `modification` in 115 of the 118 full-snapshot subjects and `cancellation` in the other three. These are subject words, not verified HMS outcomes or independently reviewed labels.

The [historical fact record](../../../context/FACTS.md#reservation-and-quote-behavior) reports 84 failed-integration messages in a different July 30–October 13 corpus, with an owner-confirmed staff check. Restricting the present snapshot to those stored dates also yields 84 subject-pattern matches, including 81 subjects with `modification` and three with `cancellation`; however, its inbound and SynXis totals differ from that historical corpus. Matching counts do not prove the same individual rows. A subject match can include replies or repeated notices; this census does not interpret message bodies, ascertain completion, or de-duplicate related alerts.

## Check against earlier action labels

The [R3 study](../../2026-10-13/r3-workflow-truth.md#method) has 400 stratified, single-analyst labels. A local aggregate-only join compared each label's `message_id` with the saved snapshot's `sourceRowId`, then required the original R3 message and the current snapshot row to have identical stored subject, body, parsed `From` address and inbound direction, with the current row on the Centurion active transport. **345** labels met those conditions. Among the **33** matching rows with a no-reply sender clue, the earlier analyst marked **three** as needing work (two `new_booking`, one `amend`) and 30 as `no_action`.

This is another counterexample to treating a no-reply clue as proof of no work. It is not a population rate: the original sample was stratified, selected channel hosts were excluded, 55 labeled rows were not in this exact-match subset, and the single analyst used later thread/outcome context. The labels do not establish the new plan's counterfactual support. The private inputs are the R3 `labels.tsv` and `messages.jsonl.gz` named by the [R3 method](../../2026-10-13/r3-workflow-truth.md#method), plus the manifest-identified saved Centurion JSONL; the [recheck script](recheck-centurion-census.py) prints no message data or per-message identifiers.

## Use for triage research

- Record known sender/channel origin as one dimension and a no-reply or template clue as another. Do not infer `no work`, `spam`, or `fully automated` from either alone. Travel-agent mail remains in scope under current product rules.
- Record a failed-integration subject match as a separate **candidate exception requiring review**. Its exact phrase is useful for an initial flag but will miss variants and cannot establish work without context. The [source registry](../../../../apps/server-pilot/config/mail-source-rules.js) recognizes `synxis.com` as a channel, and the [worker](../../../../apps/server-pilot/src/ai/worker.ts) can route a trusted non-direct source to `automated-channel` before model triage. The [triage source](../../../../apps/server-pilot/src/ai/triage.ts) also treats `failed to integrate` as a routine-system signal; the [extraction prompt](../../../../apps/server-pilot/src/ai/extraction/extract.ts) tells the action classifier to label integration errors `no_action`, even though its separate `kind` instructions classify their reservation action. Branches, product policy and deployed behavior need review before proposing a runtime change; this census does not establish that any of the 118 rows took that path. A potential future lookup is not evidence that the currently planned tools complete this workflow.
- Reclassify the full inbound frame, including excluded/channel sources and a sample of messages without any pattern, before estimating false skips or potential help. The earlier R3 action percentages excluded selected channel sources and do not measure this full frame.

## Reproduce

Run [source-origin-counts.py](source-origin-counts.py) locally against the owner-only saved JSONL identified by its manifest. It prints aggregate counts, caller-supplied host/transport labels and a source fingerprint; it does not print email addresses, subjects, bodies, or per-message identifiers and does not modify the source. For this census the JSONL SHA-256 was `ec9d30c47e2ef0a3dd61ae6db795e1f730feb5e853b9cf76025f523d7a4e6625`.

```sh
python3 -I -B docs/research/halloween/corpus-analysis/source-origin-counts.py \
  "$CENTURION_CORPUS_JSONL" --transport transport-centurion \
  --host synxis.com --host booking.com --host profitroom.com \
  --host travelit.co.za --host nexustravel.co.za --host legacyhotels.co.za
```

Add `--start 2026-09-28 --end 2026-10-23` for the comparison window. The script counts rows whose scope includes `active_transport` and whose exact transport ID is selected; directions and timestamps come from the saved source. Host matching is case-insensitive and exact. The subject signal is the case-insensitive literal phrase `reservation failed to integrate`; the no-reply signal matches `noreply`, `no-reply`, `no_reply`, or `no.reply` in the parsed sender local part. Other automated-message patterns are not measured.

Reproduce the separate subject-window breakdown and historical-label cross-check with:

```sh
python3 -I -B docs/research/halloween/corpus-analysis/recheck-centurion-census.py \
  "$CENTURION_CORPUS_JSONL" --transport transport-centurion \
  --historical-messages /home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz \
  --historical-labels /home/orca/nava-research/scripts/r3/labels.tsv
```

The recheck reads the old and new stored bodies locally for equality, without printing them. Its windows and old source schema are Centurion-study-specific; it is not a general Da Vinci analysis.

For Da Vinci, first verify that its saved export has this schema, identify the correct property transports and window, and run per transport as well as for the combined set. Combined source-row counts can include copies in multiple mailboxes; a separate, documented message-linkage analysis is needed before calling them distinct emails. Adapt the reader if the source schema differs. No live mailbox or HMS query is required by this script.
