# Parked research: Centurion group PDFs

**Status: to do later.** Owner requested this on 2026-11-01. Group work and XLSX rooming remain parked; do not run queries, classify mail, or build group tools as part of this note.

## Question

The earlier confirmation study selected outbound PDFs using HMS-style confirmation evidence. The owner suspects some group-stay documents are instead assembled manually in Word or Excel and exported to PDF, with different filenames. If so, the earlier confirmation cohort could underrepresent group work. This is a **hypothesis**, not an established fact: unmatched PDFs need not be group-related, and some group documents may use the HMS naming pattern.

## Future discovery

1. From an explicitly authorised, verified read-only source, identify Centurion outbound messages with PDF attachments. Record the time range, mailbox, population and selection rules.
2. Classify or filter out only the **verified** automatic HMS confirmation naming pattern(s), retaining a separate count and a way back to every excluded item. Treat missing or unusual filenames as unknown, not automatically non-group.
3. For the remaining PDF candidates, inspect subjects and filenames; use an appropriately authorised LLM analysis if helpful. Classify likely group-related, other, and uncertain with a reason. Inspect content only when needed and permitted. Do not assume every remaining PDF is a group document.
4. Preserve a **private, source-linked manifest** containing attachment filename and identifier, parent message ID, thread ID, mailbox, date, and classification/evidence, so each original email can be found. Keep guest details and attachment content private; do not put them in Git.
5. Validate a sample of both excluded and retained documents, including uncertain cases. Report counts and sampling limits; check duplicates and repeated versions before treating documents as unique bookings or requests.

Use a read-only SQL query only in a later authorised run, against a verified target. Preserve existing evidence and privacy rules. Earlier corpus context: [five-day Centurion corpus](2026-10-30-centurion-five-day-corpus.md) and [three-day reread](2026-10-29-centurion-three-day-reread.md).
