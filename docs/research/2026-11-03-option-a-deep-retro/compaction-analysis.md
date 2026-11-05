# Compaction and stale-prompt failure

Primary record, not model psychology. After first compaction, replacement history repeatedly retains last ordinary user request to produce a goal prompt, while goal-activation message is absent from replacement user history. Goal continuation still carries file-pointer objective; coordinator should have re-read it and resumed execution. Instead it regenerated prompts seven times.

| Compaction finished UTC | Last ordinary user request | Goal-activation message retained? | Source |
|---|---|---|---|
| 14:43:46 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | True | [rollout:50](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:50) |
| 15:29:13 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:1188](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:1188) |
| 15:55:30 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:1828](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:1828) |
| 16:26:00 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:2605](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:2605) |
| 17:02:10 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:3571](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:3571) |
| 17:37:55 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:4460](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:4460) |
| 18:15:13 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:5236](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:5236) |
| 19:06:16 | Cool. Give me the full /goal-style prompt that I can copy-paste into this chat. | False | [rollout:6089](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-e8d8-7920-aa59-130947660926_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl:6089) |

## Prompt generation intervals

Measured first stale-task commentary → final regenerated prompt. Excludes compaction and subsequent reconciliation. Does not imply workers stopped.

| Start UTC | End UTC | min |
|---|---|---:|
| 15:29:36 | 15:31:15 | 1.65 |
| 15:55:50 | 15:57:26 | 1.60 |
| 16:26:20 | 16:28:58 | 2.63 |
| 17:02:27 | 17:04:32 | 2.08 |
| 17:38:11 | 17:39:58 | 1.78 |
| 18:15:30 | 18:18:10 | 2.67 |
| 19:06:36 | 19:08:18 | 1.70 |

Total = 14.12 coordinator min. Separate compaction total =24.57 min. Parallel work continued. No evidence supports adding these to an exact deploy-delay number.
