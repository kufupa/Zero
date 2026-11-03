# Mechanical metrics

Cutoff 19:14 UTC. Turn spans include waits; command timings are host-observed events. Parallel sums are not elapsed time. Detection heuristic; inspect linked raw events before causal attribution.

| Agent | Turn min | Commands | Detected test cmds | Test cmd min (sum) | Detected native probes |
|---|---:|---:|---:|---:|---:|
| /root/coordinator | 267.13 | 707 | 9 | 2.28 | 7 |
| /root/release_recon | 10.21 | 34 | 0 | 0.0 | 0 |
| /root/u0_shared | 17.69 | 93 | 7 | 0.86 | 0 |
| /root/u3_amend | 39.65 | 300 | 1 | 0.01 | 1 |
| /root/u0_review | 5.19 | 92 | 0 | 0.0 | 0 |
| /root/u1_create | 80.95 | 627 | 36 | 7.8 | 7 |
| /root/u2_filing_cancel | 29.57 | 288 | 11 | 0.68 | 0 |
| /root/u3_sol | 226.98 | 527 | 21 | 1.94 | 12 |
| /root/tranche1_review | 17.18 | 334 | 0 | 0.0 | 0 |
| /root/u2_cutover_fixes | 47.68 | 462 | 25 | 2.64 | 0 |
| /root/goal_prompt_scope_check | 2.16 | 4 | 0 | 0.0 | 0 |
| /root/u1_final_recovery_review | 22.65 | 186 | 0 | 0.0 | 0 |
| /root/u2_final_cutover_review | 8.35 | 172 | 0 | 0.0 | 0 |
| /root/release_pane_canary_recon | 5.67 | 45 | 0 | 0.0 | 0 |
| /root/u3_ai_mail_final_review | 3.35 | 109 | 0 | 0.0 | 0 |
| /root/u3_cancel_restore | 26.8 | 189 | 17 | 2.78 | 0 |
| /root/u2_shared_final_review | 10.0 | 146 | 0 | 0.0 | 0 |
| /root/remote_mailbox_selector_recon | 3.88 | 18 | 0 | 0.0 | 0 |
| /root/u5_profile_contract_recon | 3.83 | 29 | 0 | 0.0 | 0 |
| /root/u5_native_new_read_recon | 78.06 | 881 | 6 | 1.11 | 41 |
| /root/tranche1_guest_email_canary_recon | 51.93 | 157 | 0 | 0.0 | 11 |
| /root/u5_profile_new_contract_research | 7.04 | 36 | 0 | 0.0 | 0 |
| /root/u3_retained_target_rate_source | 4.92 | 41 | 0 | 0.0 | 0 |

## Usage (deduplicated response IDs; not billing)

- gpt-6-luna: input 41,069,575; cached input 39,795,512; output 497,435.
- gpt-6.1-sol: input 136,495,853; cached input 133,351,800; output 868,251.
- gpt-6.1-terra: input 414,941,144; cached input 406,256,234; output 1,636,817.

Actual dollar costs unavailable from rollouts; do not invent pricing or convert these into billed spend. Input includes repeated cached context.

## Compaction events

- 14:43:46: 1.72 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:55.
- 15:29:13: 2.21 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:1193.
- 15:55:30: 2.38 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:1833.
- 16:26:00: 2.91 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:2610.
- 17:02:10: 2.69 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:3576.
- 17:37:55: 2.98 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:4465.
- 18:15:13: 3.32 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:5241.
- 19:06:16: 6.36 min; rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:6094.
