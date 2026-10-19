# 2026-10-19 party lookup: why prod binds so little (evidence)

Party = the HMS company or travel-agency profile on a quote. Its contract rate decides the price. "Bind" = Nava picks the profile itself, so staff don't have to.

All prod numbers come from read-only SQL on `ai_workflow_run` / `work_event`, run 2026-10-19 13:00–14:30Z through `ssm-run-command.sh` → `systemd-run` → `postgres` `begin('read only')`. Counts only; no mail bodies or guest data. Window: since PARTY_MATCH_V2 went live on 2026-10-14 unless stated otherwise. Prior artifacts reused, not redone: R7 (`/home/orca/nava-research/reports/r7-party-v2-live.md`), R2 (`r2-party-truth.md`), lane B ([party eval 72h](2026-10-19-party-eval-72h.md)).

## 1. Headline numbers, and what they mean

| Number | What was counted | Why it misleads | Source |
|---|---|---|---|
| 58% (55/95) | Offline replay, 95 old mails from 27 agency domains with a known party. HMS simulated as the 79 answer-key names | Fake HMS had no junk or duplicate profiles. Mix: 51 vouchers, 3 quotes | R7 Method + Findings |
| 11.6% (14/121) | Every prod party lookup in 72 h | Includes notices, private guests, no-party mail. No denominator for "mail that names a party" | lane B Step 1 |
| 15.7% (24/153) | Every V2 party lookup since 2026-10-14 | Same caveat; best prod number we have | SQL, this doc |
| 20% (2/10) | Staff hours today | n=10: ignore | lane B |

The number we need — of mails that name a company or agency, how often Nava picks the right HMS profile — has never been measured. The v3 backtest measures it.

## 2. Why 129 of 153 V2 lookups did not bind

Bucketed by the stored `read_result.reason` (SQL `case` on reason prefix), plus term and row checks.

| Cause | n | Detail |
|---|---:|---|
| SynXis / channel booking notices | 53 | `searchesTried` contains "synxis"; terms "SynXis", "South Africa" (from the address) return 25 random "… South Africa" profiles. The real agency sits in a "TA Email" line. 0 of 53 bound |
| Duplicate HMS profiles (same name, different id) | 33 | results hold ≥2 rows with the same normalised name; all 33 missed. Bind rule refuses equal claims (`party-match-v2.ts` "equally strong claim") |
| HMS returned no rows | 24 | real name not tried, or HMS spelling differs |
| Model unavailable → fallback | 10 | `pickSource=fallback`, "The model was unavailable and more than one exact HMS row matched". The fallback already binds a single exact match (`party-match-v2.ts` ~653); these 10 are duplicate ties, so they belong with the duplicate cause (Sol review 2026-10-19) |
| Truncated list | 10 | 25-row cap hit |
| Low confidence / claim rule | 8 | |
| LLM: no matching row | 71 | overlaps the causes above (sample of 25 read by hand: mostly SynXis, duplicates, junk terms) |

Junk search terms that filled the 25-row cap: "South Africa" (53 times), "South" (40), "travel" (5), "are", "Local", "For", "Department". Disclaimer sentences and person names were also searched. Each lookup spends its 6 live searches before reaching the real name. p50 run time 65 s, p90 86 s (7 days).

Per-search kind: 451 company searches, 279 returned 0 rows; 308 agency searches, 150 returned 0.

## 3. Duplicate profiles in HMS

Prod party results since 2026-10-14 held 346 distinct profiles over 321 distinct names.

| Name | Copies | Kind |
|---|---:|---|
| Tourvest Travel Services | 13 | agency |
| Travel With Flair | 3 | agency |
| Rennies Travel, Flight Centre, WebBeds, Cullinan Holdings, Gemini Moon Trading, BCD Travel (India, Canada, Germany) | 2 each | agency |
| Department of Defence, Optimum Shared Services, Moroka municipality | 2 each | company |

Owner 2026-10-19: assume the hotel never cleans these up; work around them like a reservationist (history first, then distinguishing columns).

## 4. Data we throw away (owner: "note it down")

| Reader | Field shown in HMS / loaded | Kept today? | Effect |
|---|---|---|---|
| `party-lookup.mjs` grid | City, Address, Country, IATA/reference number, External ID (`GRID_HEADER_RE`, line ~542) | No: results keep `kind,nativeId,name` only (SQL: row keys) | Duplicates cannot be told apart |
| `find` reservation read | `commercial.agency` | Name only, no `nativeId` (company keeps `nativeId`) | Agency truth needs a name join |
| Party V2 result | per-search rows before the 25 cap | Only the capped union | Can't tell which term found what |

## 5. Party on real reservations (agency vs company)

167 HMS reservations with outcome `found` in `/home/orca/nava-research/testsets/party-truth.jsonl` (read-only HMS, 2026-10-14).

| Party set | n | Rate plan usually |
|---|---:|---|
| Company and agency | 74 (44%) | NGOV/NCOR negotiated (71/74) |
| Company only | 41 (25%) | NCOR/NGOV |
| Agency only | 33 (20%) | mixed: wholesale (WSF), GDS, some NCOR |
| Neither | 19 (11%) | BAR |

The company usually carries the contract rate, so v3 resolves both kinds.

## 6. The local index was never tried

- 2026-10-09: index file format, typeahead and sweep script built (#84, #82). The sweep writes the index only when every prefix is done.
- `/home/ubuntu/party-sweep.log` on EC2: two starts (08:09Z, 08:53Z), each ended by a stop file. Zero "running chunk" lines, so zero searches ran. The idle gate needed 20 min of staff silence.
- 2026-10-19: no `party-index.json` on EC2; `PARTY_INDEX_PATH` unset. The matcher never read an index.
- Size: HMS shows at most 50 rows per search (`HMS_LOOKUP_PAGE_ROWS`). Company ids seen go up to 1401, agency ids to 581. So most letters overflow into two-letter prefixes: about 300–800 searches. At ~15–20 s per spawn (login every spawn, per coordinator 2026-10-19) that is 1.5–4 h; with one login per batch (lane F2, ~3 s per search) 15–40 min. Not yet checked: whether the HMS lookup grid can page instead of re-searching.

## 7. Existing truth we can use without new HMS reads

| Source | Rows | Ids? |
|---|---:|---|
| Answer key (HMS reservations, 2026-10-14) | 167 found | names only |
| Prod `find` reads since 2026-10-14 naming a party | 52 of 180 | company id yes, agency no |
| Staff party picks on staff quotes (`read_request.input.parties`) | 25 | yes (e.g. Nexus ×8, No Limits ×6, Thompsons ×3) |
| Learned sender map (`party_sender_map`) | 66 domains (41 agency, 29 with support ≥3) | names only |

Roughly 240 rows before dedupe.

## 8. Usage (value gate)

- Staff party actions, 14 days: 8 `field.accept`, 1 `field.edit` (`work_event`, `actor_kind='user'`).
- Staff-started party searches, 14 days: 23 searches across 15 threads (`priority=10`).
- Party lookups run on 275 of the last 30 days' read jobs; 85 sit on threads that later had a staff quote run.
- Rates with a party: 69% of found reservations carry a negotiated (NCOR/NGOV) plan (§5).

## 9. Which duplicate do staff pick? (2026-10-19 15:45Z)

Question (owner): learn a general rule from past mail for which copy of a duplicated profile staff use, and why.

| Source | Rows with a party id | Rows on a duplicated name |
|---|---:|---:|
| Staff party picks on quotes (`staff_quote.read_request.input.parties`) | 27 picks, 19 threads | **0** |
| Prod reservation reads (`find`, company id only) | 69 found | **0** |
| Nava binds | 30 (5 days) | **0** (bind rule refuses ties) |
| Corpus 2026-10-13 `hms_reads` + `staff_quotes` | 2 ids | **0** |

**No evidence exists yet of which copy staff choose.** The rule cannot be learned from the corpus today. Two places throw the evidence away:

- `commercial-fields.mjs` `party()` takes the agency id from field `bookingagency`/`ta1` only when its value differs from the name. In prod, the value is the name, so every reservation read loses the agency id (prod `find` result keys: `commercial.agency.name` only; company keeps `nativeId`).
- `party-lookup.mjs` drops the City / Address / IATA columns (§4) that HMS shows beside each copy, which are what a person reads to tell copies apart. The synthetic fixtures confirm the agency dialog has `Booking Agency Name, IATA/Reference Number, Address, City`.

The quote's rate search types the agency **name** into HMS (`fetch-quote.mjs` `pickerFilter`: `agency` has no `idFilter`), then `matchReference` selects the row by `nativeId` when one is passed and by name only when it is not. So the bound copy's id does reach the price: a wrong copy can give a wrong contract rate, and a name-only reference on a duplicated name throws `AMBIGUOUS_REFERENCE`. (Corrected 15:20Z after Greptile review on #392.)

## 10. Lane B's "3 wrong binds" are not wrong

Lane B flagged 3 binds that disagree with the sender domain's dominant agency (`19cccb9a7973`, `091cc81fd284`, `2e63cb1e3e9c`). All 3 bound **Nexus Travel #27** for `nexustravel.co.za`. Staff picked agency #27 on their own quotes 9 times; Nava's 8 Nexus binds are all #27. The domain label came from HMS reservations, where the same agency's bookings carry a different agency name ("XL Nexus") and company ("XL Nexus Travel"). **The party on the quote can differ from the party on the final reservation.** Truth for the quote workflow = what staff pick on the quote; reservation party is a second, weaker label.

## 11. Step 0: which duplicate copy staff link (2026-10-19 15:15–16:00Z, read-only HMS)

Method: opened each answer-key reservation on HRCEN by confirmation (Guest Stay, read-only guard, property lock) and read the ExtJS form record; then one batched agency search (Tourvest, Rennies, Flight Centre) reading the lookup grid's store records. No writes. Script kept outside the repo; counts and profile ids only.

**Where the id lives.** The Guest Stay record has `companyid` for the company. For the agency it has **no id**: only `ta1` (name) and `bookingagency1iatanumber` (IATA). So a reservation tells us an agency copy only by name + IATA.

**Which IATA staff used** (23 answer-key reservations on duplicated agency names, all read):

| Agency name on booking | Bookings | IATA on booking | Copies with that name + IATA |
|---|---:|---|---|
| TOURVEST TRAVEL SERVICES | 10 | 77206673 | **2: #6 (Bryanston, ref type IATA) and #543 (no address, ref type TIDS)** |
| TOURVEST TRAVEL SERVICES | 1 | 77269990 | 1: #326 |
| Tourvest Travel Services | 3 | TOU001 | 1: #8 (Roggebaai; the only title-case copy) |
| RENNIES TRAVEL (PTY) LTD | 7 | 77200292 | 1: #16 (Johannesburg); #562 has 77299294 |
| FLIGHT CENTRE TRAVEL GROUP | 2 | 77200351 | 1: #15 (Northcliff); #217 has 77200561 |

**Grid store keys (confirmed live):** `travelagencyid`, `travelagencyname`, `iatanumber`, `referencenumbertype` (IATA / TIDS), `internalreferencenumber`, `address`, `city`, `country`, contact names. Tourvest: 13 copies named TOURVEST TRAVEL SERVICES / Tourvest Travel Services, 11 distinct IATA numbers.

**Rule (general, not per entity).**
1. Staff use **one copy per sending agency branch**, consistently (10/11 Tourvest all-caps bookings, 7/7 Rennies, 2/2 Flight Centre on one IATA).
2. IATA + name picks the copy in 4 of 5 groups. In the 5th, two copies share the IATA; the one with an address and ref type IATA (#6) is the likely real profile, but no booking proves #6 over #543 (the booking stores IATA only). That stays a staff pick until a staff quote picks one.
3. Spelling is a signal: the single title-case Tourvest copy (#8, TOU001) is a different branch from the all-caps ones.

So v3's duplicate rule (bind only if one copy's city/IATA appears in the email, or sender history names one id; else list all copies) matches what staff do. History (P8) is the main lever: once a sender's staff pick is stored by id, every later mail from that branch binds.

## 12. P6: live replay of v3 vs v2 (2026-10-19 16:00–16:20Z, read-only)

Method: main `03dbbae46` on the EC2 scratch checkout, prod env, `PARTY_MATCH_V3` set in that process only, the real `findPartyJob` under the HRCEN property lock, one job at a time. Inputs = the stored extraction + mail of past V2 party jobs. Truth = staff party picks on later staff quotes (id-level). Script outside the repo; ids and outcomes only.

| Set | n | v2 | v3 | v3 wrong binds |
|---|---:|---|---|---:|
| A: staff-confirmed (mostly v2 binds staff accepted, so v2-favoured) | 22 | 21 right | 15 right | **0** |
| B: recent v2 misses on direct mail (one per sender domain, not staff/SynXis) | 20 | 0 bound | 2 bound; 10 show HMS rows to pick | 0 known (1 unconfirmed) |

Time per mail: p50 25 s, p90 40 s (v2 prod p50 65 s, p90 86 s, §2).

**Why v3 missed 7 in set A:** all 7 are one agency, No Limits Travel & Tours (#119). v3 typed the full name → 0 rows; in round 2 the model saw only the (empty) rows and asked for the same name again. v2 bound it through its short-word fallback ("Limits" → 1 row). Fix = P5b: tell the model what it already typed and the row counts, never repeat a term, and fall back to v2's short-word variants when a full name finds nothing.

**Set B binds:** BE Travel mail → agency #402 BAITHAUPI EXECUTIVE TRAVEL (T/A BE TRAVEL) (right by name). LetsCruize mail → company #301 Department of Health, which is the end client in the extracted booking (`endClient`); the right company-profile pattern, not yet confirmed by staff. Tourvest and Rennies mails went to needs_pick with their duplicate copies listed first (the intended duplicate rule).

**Verdict:** 0 wrong binds (bar met on these 42). Auto-bind is below v2 on staff-confirmed agencies until P5b lands. Flag stays off until a re-run after P5b shows v3 ≥ v2 on set A.
