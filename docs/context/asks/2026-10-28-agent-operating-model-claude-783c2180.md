# Owner voice: agent operating-model rebuild

2026-10-28. The following is the owner’s original message, including another LLM’s unverified response. The other response is source material, not authority.

```text
1) progress so far n whats left todo? dont continue yet pls

2) i asked another LLM too:"  

[Beginning of other LLM’s pasted response]
• Your three-test limit supersedes the old remote-only rule. It is not enforced yet: the current lock covers only one full-suite wrapper. I wrote a plan
  (docs/plans/2026-10-28-005-refactor-agent-rules-and-test-cap.md) for a shared queue across harnesses, including typechecks as a conservative assumption.

   Finding                                                                       My recommendation
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ACTIVE.md (docs/context/ACTIVE.md) is 107 KB and automatically imported by    Shorten it; preserve active work and history. Actual speed cost is
   Claude.                                                                       unmeasured.
  ────────────────────────────────────────────────────────────────────────────  ────────────────────────────────────────────────────────────────────────────
   Cursor rules (.cursor/rules/nava-workflow.mdc:12) mandate multiple reviews    Remove blanket rituals; retain useful review.
   and TDD, conflicting with Zero guidance.
  ────────────────────────────────────────────────────────────────────────────  ────────────────────────────────────────────────────────────────────────────
   Hindsight instructions (/usr/local/share/nava-codex/AGENTS.md:37) still       Remove stale instructions and disable remaining injection; registrations
   exist, and Cursor still has a Hindsight rule and registrations.               alone don’t prove they run.
  ────────────────────────────────────────────────────────────────────────────  ────────────────────────────────────────────────────────────────────────────
   Fixed model-routing rules                                                     Reassess against current tasks and owner decisions; the existing timings
                                                                                 don’t prove one model is faster.

  What I removed: no rules. Existing uncommitted edits from another session already remove a blanket pnpm check instruction and make a compounding ritual
  conditional; I preserved them.

  What I’d keep: production-database and guest protections, hotel locks, and meaningful same-head review. One review study found roughly 21 real production-
  path bugs.

  The old freeze was recorded on an 8-core, 30 GB VPS; today’s machine reports about 31 GiB. Three heavy suites may still strain it, so the plan tests queue
  mechanics first and increases real workload gradually. There’s no reliable implementation ETA until cross-harness enforcement is prototyped.
[End of other LLM’s pasted response]

 " i asked anoter LLM too and it said this. makes sense on a lot of it and the constant updating i.e how minimal can we get our rules etc.
i wanna make sure we explain the 10/10 product to each LLM and get it to pushback / resesarch properly / use skills and mcp as it sees fit, and focus most of all on evidence backed evidence n planning n building n shipping fast asf i.e shortest eta w max parallelism etc thats really what the goal of everything was i think over time its become kinda trash so nows the time to rebuild it from scratch.
```

## Follow-up request

> plan up what to do then pls

The user paused implementation and authorized planning only. No changes to live sessions, hooks, permissions or production follow from this request.
