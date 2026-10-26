# Afternoon instruction audit
Window: 11:00–15:50Z [chat-pm.md:38–57,4336–4370]. Times normalized UTC.
Afternoon only; morning used only to check fix status [morning-retro.md:129–139].

## Breaks and owner corrections
| UTC | Quote | Audit |
|---|---|---|
| 11:00/11:13Z | Coord: “Reply prune A”; owner: “I don't know what pruning means…you didn't give me full context.” [chat-pm.md:52,83] | Owner still lacked disk map, options, and T2 meaning; decision-ready miss. Later gave full inventory and safe steps [AGENTS.md:84–86; chat-pm.md:240–260,301]. |
| 11:18/11:23Z | Coord: “8 more code units…5½–7 hours”; owner: “I don't believe that…what's going on?” [chat-pm.md:245,262] | Reply omitted ETA parts. Ledger basis was serial 7×40×1.2=336m, p75≈420m; owner forced replan [eta-or2.jsonl:8; feedback-evidence-backed-numbers.md:7,13–14]. |
| 11:34–11:40Z | Coord: “2 hours…2¾ h”; owner: “is our method really fastest + best and optimal?”; coord later: “80 minutes…2 h” [chat-pm.md:597,701,858] | Owner correctly challenged seam/parallelism. Later chat forecast 80/120m did not replace ledger 120/165m; unresolved basis mismatch [eta-or2.jsonl:9–10; feedback-eta-evidence-first.md:7–11]. |
| 11:44Z | Owner: “We're using cursor with grok 4.6 high as a lane” and “prompt it explicitly” [chat-pm.md:874–877] | Owner corrected CLI/model and no-memory prompting; coordinator verified Cursor command and added checklist [chat-pm.md:883,931–950]. |
| 11:50Z | Coord: “HMSDOWN had edited 5 files.” [chat-pm.md:1059] | Supervision risk: restarted despite known edits; no drift shown. Memory says restart only for drift/no progress [feedback-subagent-supervision.md:7–13; chat-pm.md:999–1000,1052–1062]. |
| 12:00–12:32Z | Owner: “what are these??”; “fix the main failures”; “we're just doing training with davinci not centurion” [chat-pm.md:1262,1295,1760] | Script names were jargon; owner steered to fixing main and corrected meeting risk. Coordinator explained, tried Argon, then checked Da Vinci read-only [chat-pm.md:1287–1292,1307–1335,1762–1777]. |
| 12:09–12:13Z | Coord: “screen changes would have shipped invisible.” [chat-pm.md:1551] | Initial UI ETA missed unmounted controls; corrected after mount check. Evidence/preflight miss, transparent repair [chat-pm.md:1425–1444,1496,1551–1561; eta-or2.jsonl:12,18]. |
| 14:41Z | Coord: “Adding resultDigest…then writing a test” [chat-pm.md:3331] | Opus coordinator directly edited feature code. Routing conflicts: PRODUCT says Luna; AGENTS/current memory say Grok via Cursor. Opus fits neither [PRODUCT.md:50; AGENTS.md:38; feedback-model-routing.md:74–103]. |
| 15:27Z | Coord: “rough guess…not checked against the ETA ledger”; owner: “u should always check it against ETA ledger” [chat-pm.md:3963,3972] | Direct break of read-ledger-before-every-ETA rule. Coordinator then queried ledger, saved feedback, and rebuilt estimates [CLAUDE.md:27–35; feedback-eta-ledger.md:11,21–23; chat-pm.md:3974–4029]. |
| 15:35Z | Coord: “I let #607 through at 544 product lines, over the 500 cap…5 review rounds.” [chat-pm.md:4164] | Explicit PR-size and review-budget override; violates limits and “>500 refused” memory [AGENTS.md:34–37; feedback-speed-mode-default.md:8–14; eta-or2.jsonl:18]. |
| 15:44Z | Coord: “Conflict markers got pushed. Fixing that now.” [chat-pm.md:4295] | Closeout quality slip, caught before PR merge; ETA log marks rule breach [chat-pm.md:4283–4318; eta-or2.jsonl:20]. |

## Every user-facing ETA (repeats grouped)
| Given (UTC) | Number + basis stated | Outcome |
|---|---|---|
| 11:18Z | T2 “5½–7h”; disk change “about 150 lines, about 1 hour” (rough size/time, no measured basis or ETA row). T2 log: 340m from 7×40×1.2, p75≈420m [chat-pm.md:245,254; eta-or2.jsonl:8]. | T2 row superseded; replan actual 248m. No disk ETA row; disk use later 43% [eta-or2.jsonl:10,16; chat-pm.md:680]. |
| 11:34–11:53Z | Seam 25m; T2 2h/p75 2¾h, then 80m/p75 2h; 11:53 forecast 13:20/14:00. Basis: seam + parallel tracks + deploy [chat-pm.md:597,615,685,858,1133]. | Ledger held 120m/p75 165m until 14:07 re-quote; total T2 actual 248m [eta-or2.jsonl:9,13,16]. |
| 12:01Z | “About 75 minutes”; finish 13:15 p50 / 14:00 worst; parts: tests/review, coding, deploy [chat-pm.md:1275–1285]. | No matching fresh T2 row shown; pane deploy ended 15:42Z [eta-or2.jsonl:16]. |
| 12:09–12:15Z | UI 13:05 p50, Book 13:25, worst 14:00; after WIRE discovery, UI 13:25/p75 14:15, based on 70m wiring/review/deploy [chat-pm.md:1425–1444,1551–1561,1586; eta-or2.jsonl:12]. | Green-main took 187m vs 75m; WIRE took 208m vs 70m; pane landed 15:42Z [eta-or2.jsonl:11–12,16–18]. |
| 12:19–12:27Z | HMS pause 12:30, revised 12:40 after VPN delay; all done 13:30/p75 14:15; basis: lane/review/deploy parts plus 5–10m VPN delay [chat-pm.md:1603,1639–1660,1720–1723]. | No separate HMS row; whole T2 pane work landed 15:42Z [eta-or2.jsonl:16]. |
| 12:30–12:38Z | Training: four T2 changes live by ~13:00; Book ~13:00, Undo/Redo ~13:25; dry run 10m before meeting. Basis: current train state, no measured runtime [chat-pm.md:1746–1757,1808–1825]. | No live Da Vinci create proven; coordinator advised preview/Labtest. Deploys paused for training [chat-pm.md:2177–2187,2233]. |
| 13:00Z | After resume, queued merges live “within about 15 minutes”; pane controls ~15m after resume if WIRE merged. Conditional only; no measured full-path basis [chat-pm.md:2236–2238]. | Owner resumed 13:28; pane deployed 15:42Z [chat-pm.md:2287–2293; eta-or2.jsonl:16,18]. |
| 13:30–13:47Z | Remaining features “15 minutes”; all done 14:25 p50 / 15:00 worst; basis not restated in repeated replies [chat-pm.md:2348–2364,2410,2461,2507,2542,2599,2619,2631]. | Pane deployed 15:42Z [eta-or2.jsonl:16]. |
| 13:50Z | All done 14:40 p50 / 15:10 worst; lane-by-lane stage estimates [chat-pm.md:2659–2678]. | Pane deployed 15:42Z [eta-or2.jsonl:16]. |
| 14:07Z | Re-quote 180m; pane 15:00 p50 / 15:30 p75 after another J1 P1; duration parts not stated [chat-pm.md:2821–2838; eta-or2.jsonl:13]. | T2 actual 248m; pane deployed 15:42Z [eta-or2.jsonl:16]. |
| 14:36–14:49Z | Migration ~15m after yes (no measured runtime); mail-send fix ~40m (small server change/test); after merge, ship within ~15m (basis unstated) [chat-pm.md:3070–3077,3576]. | Owner approved 14:37; migration applied 14:40/deployed 14:47; mail PR merged 14:49/live 15:04. No ETA row for mail fix [chat-pm.md:3079–3080,3212–3225,3518–3548,3566,3900–3908]. |
| 15:26–15:27Z | Train ~20–30m; pane 15:55, closeout 16:15; explicitly unchecked [chat-pm.md:3920,3940–3963]. | Pane deployed 15:42Z; closeout 15:49:54Z [eta-or2.jsonl:19–20, chat-pm.md:4334]. |
| 15:29–15:35Z | Ledger: pane 15:42/closeout 16:06; review 3.1m, deploy 7.5m, closeout 20×1.2. Extra Apex ~3m p50 moved pane to 15:47; later table said deploy 15:45/check 15:47/closeout 16:10 [chat-pm.md:4015–4029,4107–4116,4170–4174; eta-or2.jsonl:14–15]. | Pane actual 13m/deployed 15:42Z; closeout 21m/15:49:54Z [eta-or2.jsonl:19–20]. |

## Morning fixes: afternoon status only
| Fix | Status |
|---|---|
| Real deps / area lanes | Partial: fake chains removed, true deps stacked; seam dropped [morning-retro.md:133; chat-pm.md:763–781,852–856]. |
| gate.sh / green-main | Partial: manual baseline + per-commit gates used; script/nightly writer not evidenced; scripts still “to do” [morning-retro.md:134; chat-pm.md:855,1107–1133,1262,2208]. |
| Canary lane | Not applied: afternoon Da Vinci checks stayed read-only; priced quote still unproven [morning-retro.md:135,156–162; chat-pm.md:1808–1825]. |
| Deploy preflight | Partial: disk retention and HMS pause shipped; nightly evidence-to-S3 cron still absent [morning-retro.md:136; chat-pm.md:1722,2767–2783]. |
| eta.sh | Not applied: manual ledger used; unchecked estimate still reached owner [morning-retro.md:137; chat-pm.md:3963–4029]. |

## Coordinator did well (distinct episodes)
| UTC | Quote | Why good |
|---|---|---|
| 11:24Z | “copy, verify size, then delete.” [chat-pm.md:301] | S3 permission/lifecycle and served releases checked before deletion [chat-pm.md:287–301,310–337]. |
| 11:39Z | “Your instinct is right, so I've dropped it.” [chat-pm.md:764] | Accepted owner’s parallelism challenge; removed fake chains, stacked real deps [chat-pm.md:763–781,852–856]. |
| 11:53Z | “H1's failures match main's exactly” [chat-pm.md:1108] | Compared against clean main before releasing blocked lane [chat-pm.md:1097–1133]. |
| 12:05Z | “Argon is unavailable…I'll use Grok via Cursor instead” [chat-pm.md:1335] | Tested quota, adapted model route; owner praised fallback [chat-pm.md:1307–1335,1410]. |
| 12:13Z | “would have shipped invisible” [chat-pm.md:1551] | Owned missed mount, re-estimated, added WIRE [chat-pm.md:1496,1551–1561]. |
| 12:27Z | “I won't restart the VPN unless it's actually down.” [chat-pm.md:1723] | Measured route recovery; limited action to evidence [chat-pm.md:1713–1723]. |
| 12:38–12:47Z | “a priced Da Vinci quote isn't proven yet”; “No live Da Vinci create proven today.” [chat-pm.md:1809,2178] | Kept training advice read-only/safe; preview or Labtest, not real guest [chat-pm.md:1811–1825,2167–2187]. |
| 14:21Z | “Do you approve running the migration on prod?” [chat-pm.md:2983] | Paused train for owner authority; failed TLS migration applied nothing, then trusted CA without disabling checks [chat-pm.md:2977–3000,3187–3222]. |
| 14:44Z | “Server typecheck clean, 29/29 tests pass” [chat-pm.md:3442] | Ran targeted gates and Greptile before merge [chat-pm.md:3433–3465,3558–3566]. |
| 15:29Z | “New ETA from the ledger” [chat-pm.md:4015] | Rebuilt from measured parts after correction; logged ETA rows [chat-pm.md:4015–4029; eta-or2.jsonl:14–15]. |
| 15:50Z | “the pane bar is not passed.” [chat-pm.md:4351] | Did not claim live-user proof without staff loading pane [chat-pm.md:4349–4352]. |
