# Trace the real Centurion payment workflow

Type: task
Labels: wayfinder:task
Status: resolved
Assignee: /root/centurion_capabilities
Blocked by: none
Mode: AFK

**Map:** [Centurion end-to-end reservation agent](../map.md)

## Question

What do the existing Centurion corpus, owner asks, staff evidence and HMS source establish about prepaid booking requests, vouchers, proof of payment, attaching documents, guarantee/deposit status and recording money? Which exact screens or staff actions remain unobserved?

Reuse the existing evidence. Do not equate a voucher or a sender's claim with cleared money; an extraction prompt currently calls a voucher paid while a different triage path treats the paid claim as unverified. The reviewed Da Vinci interview describes deposit dates and voucher attachment but does not demonstrate payment posting. Distinguish Centurion facts from other-property statements and flag the minimum missing observation.

No payment, guest write, email or external contact is authorized by this evidence task.

**Starting evidence:** [corpus facts](../../../docs/context/FACTS.md) · [staff workflow](../../../docs/research/2026-10-20-arch-lanes/l5-reservationist-workflow.md) · [amend and payment analysis](../../../docs/research/2026-10-20-arch-lanes/l2-amend-payment.md) · [extraction rules](../../../apps/server-pilot/src/ai/extraction/extract.ts) · [triage rules](../../../apps/server-pilot/src/ai/triage.ts).

## Answer

**Resolved: evidence assessment only. The actual Centurion staff payment workflow still needs observation before it can be implemented as complete.** The owner now wants Nava to follow that full workflow, rather than stop at attaching a receipt.

- **Centurion voucher versus payment:** the owner reported that an agency voucher with a receipt can be a booking request. In a 35-voucher sample, 24 requested booking and none contained explicit proof of payment; that small sample does not prove vouchers are never accompanied by proof. Keep a voucher, a sender's paid claim, documentary proof, an agency guarantee and verified posted/cleared money as distinct facts. [Owner and sample](../../../docs/context/FACTS.md#L28), [owner detail](../../../docs/context/FACTS.md#L56).
- **Guarantee and deposit are separate:** among 1,174 Centurion HMS letters, 1,163 used provisional wording and 1,114 showed zero deposit. These are historical letter counts, not current ledger balances, verified settlement, or a booking funnel. In 223 heuristic amendment candidates, 44 had some paid evidence, 54 unpaid evidence and 125 unknown; those labels include claims and older letters, not independently verified cash. [Census and method](../../../docs/research/2026-10-20-arch-lanes/l2-amend-payment.md#L5), [payment categories](../../../docs/research/2026-10-20-arch-lanes/l2-amend-payment.md#L74).
- **Current code is not the full workflow:** the extraction prompt calls any voucher a paid booking; the payment SOP also says that, while its actual proof workflow only matches and acknowledges and explicitly must not claim posting. The voucher triage branch marks payment only on an explicit sender claim and labels it unverified. These are distinct paths with inconsistent instructions; source alone does not establish runtime behavior. [Extraction](../../../apps/server-pilot/src/ai/extraction/extract.ts#L74), [payment SOP](../../../apps/server-pilot/src/ai/aop/payment-proof-sop.ts#L1), [triage](../../../apps/server-pilot/src/ai/triage.ts#L1118).
- **Attachment and readback are different from posting:** the guarded driver describes Guest Stay → Documents → Create/Upload Document → document-list readback, and binds the selected PDF to a stay; it refuses unless `ATTACH_VERIFIED=true`. This is code, not proof that it is currently enabled or that money was posted. `hms_read_folio` is listed but its registry has `live: false` and reports role-masked money values; its contract denies posting and settlement. [Attachment driver](../../../apps/server-pilot/tooling/playwright-quote/attach-document.mjs#L1), [binding](../../../apps/server-pilot/src/ai/pane-hms-write.ts#L251), [folio registry](../../../apps/server-pilot/src/hms/read-tools.ts#L492), [folio read contract](../../../apps/server-pilot/src/hms/folio-read-contract.ts#L14). HMS payment-confirmation templates 012/014 are identified in owner Centurion screenshots, but their actual trigger and recipient in this flow are unproven. [Template evidence](../../../docs/research/2026-10-28-hrdav-cms-message-id-codes.md#L5).
- **Da Vinci evidence only:** staff described attaching agency vouchers, checking company and notes, and reviewing Infor deposit-due dates. No Infor screen order or money posting was shown; do not import these as Centurion's procedure. [Interview](../../../docs/research/2026-10-20-arch-lanes/l5-reservationist-workflow.md#L28).

**Minimum missing Centurion observations:** reuse an existing sanitized staff trace if available; otherwise obtain a separately authorized observation. Follow a genuine voucher/POP from finding the exact stay and verifying payer/amount/reference against the staff's trusted money source, through any document upload, guarantee/deposit status check or change, and any actual payment/folio posting or finance handoff. Capture the screen names, fields, staff roles, trigger, and before/after independent readback; establish which status means claimed, guaranteed, posted or cleared, and whether CMS 012/014 is sent and to whom. Also identify how partial payments or one payment for multiple room records are allocated. The [Deposit Ledger probe](../../../apps/server-pilot/scripts/hms-deposit-ledger-reprove.mjs#L2) names a possible screen path; it does not show that Centurion staff use it or how they post.
