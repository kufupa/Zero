# Quote Audit Bundle Implementation Plan

> **For agentic workers:** Use executing-plans inline. One operator owns the live browser; do not delegate live PMS interaction.

**Goal:** Run the native quote tool on real PMS data and deliver a private, locally viewable video with matching structured evidence.

**Architecture:** A small adjacent audit helper captures events, named checkpoints, sanitized traces and optional video. Each quote invocation creates and closes its own isolated context in the borrowed browser. Recording begins only after authenticated-shell verification, using Playwright 1.63's public page screencast API.

**Tech Stack:** Node 22.23, pinned Playwright 1.63.0, existing HMS trace sanitizer and fflate 0.8.2, FFmpeg/ffprobe for playback verification.

## Global Constraints

- Quote observations only: no booking, holds, guest changes or messages.
- Artifacts remain under this worktree's ignored `.private/playwright-quote`, directory mode 0700 and file mode 0600.
- Never capture login; never publish unsanitized traces. Remove exact owned raw trace files after processing, including failed sanitization.
- Do not modify another browser owner's pages, stop unrelated processes, or stage unrelated changes.
- Trace/events by default; video with `--video`. Pre-authentication failures explicitly report capture as not started.
- Keep applied criteria, visible calendar, selected native response fields, nightly detail readback and result together.

### Task 1: Private capture and trace compatibility

**Files:** `apps/server-pilot/tooling/playwright-quote/audit.mjs`, `audit.test.mjs`; `apps/server-pilot/src/hms/trace-privacy.ts`; `apps/server-pilot/tests/hms-trace-privacy.test.ts`.

**Interfaces:** `createAudit(directory, {video, secrets})` returns `event(phase)`, `start(page)`, `checkpoint(name)`, `finish()`. `finish()` returns capture status, artifact paths, byte sizes and SHA-256 values, never raw credential errors.

- [x] Add regression coverage for the observed Playwright trace entry `screencast/page@<id>-<timestamp>.jpeg`; reject nested/traversal/non-JPEG paths. Observe rejection before adjusting the allowlist.
- [x] Add filesystem-backed tests for JSONL events, opt-in video, sanitized trace output, raw-file removal on success/failure, named checkpoints, and incomplete-capture reporting.
- [x] Run `node --test apps/server-pilot/tooling/playwright-quote/audit.test.mjs` and the existing trace privacy suite; observe missing audit behavior before implementing it.
- [x] Add only the narrowly permitted screencast image entry pattern. Reuse the existing bounded sanitizer for all trace entries.
- [x] Implement capture finalization before closing the owned context; no swallowed capture errors. Run both test suites again.

### Task 2: Quote integration and real evidence

**Files:** `apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs`, `fetch-quote.test.mjs`, `README.md`.

**Interfaces:** `fetchQuote({requestPath, outputDir, env, video=false})`; `runInPage` gains an optional checkpoint callback. Business outcome remains distinct from `result.audit.status`; requested capture failure makes the CLI nonzero.

- [x] Add an input-gap integration test that requires events and explicit `not_started` capture without credentials or a browser.
- [x] Create an isolated browser context; authenticate before `audit.start(page)`. Capture `login-complete`, `hotel-availability`, each group's criteria/result/details, and safe failure checkpoints. Persist selected native network fields beside applied inputs and result.
- [x] Add `--video` and document the local FFmpeg prerequisite, privacy boundary, directory layout and incomplete-capture exit behavior.
- [x] Run `node --test apps/server-pilot/tooling/playwright-quote/*.test.mjs`, targeted privacy tests, syntax/lint and `git diff --check`.
- [x] Run the real adult input with `--video --output .private/playwright-quote/audit-runs`; read fresh result and verify applied dates/occupancy against the selected native source and visible details.
- [x] Use `ffprobe` for duration/codec/dimensions and `ffmpeg -v error -i <video> -f null -` for full decode. Inspect frames and a named checkpoint. Validate trace JSONL/resources and artifact checksums without printing secrets.
- [x] Stop only this run's verified owner and SSM tunnel. Report absolute private video and bundle paths. Leave changes uncommitted unless asked.

## Evidence-driven corrections

- Playwright shares one screencast across consumers. Start video before trace so the first subscriber requests 1280×720, rather than trace's default 800px frames being padded into a larger video. Verified against actual decoded frames and pinned source, with an ordering regression.
- A rejected checkpoint after session expiry must mark capture incomplete; verified with a failing regression from independent review.
- Native resource hash references must not be mistaken for opaque credentials and renamed into colliding ZIP entries. Only native hash fields referring to actual archive resources are exempt from heuristic collection; explicit credentials still redact.
- HMS `iscallerlogin=yes/no` is a mode flag, not a secret. Treating `no` as a credential rejects real schema keys `nonroombundleslist` and `noguestpreferences`. The exact name/enum exception is applied consistently to cookie headers, cookie objects and storage-state collection; unknown values and actual credential cookies remain protected. Both formerly rejected real responses pass in isolation. No raw trace is published on a failed run.

## Completion verification

- 24 native quote/audit tests and 63 existing browser-artifact/privacy tests pass; targeted oxlint and diff checks pass.
- Final fresh CLI run exited 0 with `outcome: quote`, `audit.status: complete`, and `video.status: complete`.
- Full video decode passes: VP8 WebM, 1280×720, 74.28 seconds. A frame derived from the video was visually inspected against the named detail checkpoint.
- Ten artifact hashes, three nightly source/DOM matches, 158 trace entries and all 148 native trace resource links verified. Playwright 1.63 uses `file`/`_file` links; legacy versions use `sha1`/`_sha1`.
- Captured text contains no known account credentials; credential headers/request bodies and raw trace archives are absent. Files are private and ignored by Git.
- The borrowed owner's original context/two blank tabs survived tool completion. Only this run's verified owner and tunnel were then stopped. Private run path, code hashes and machine-readable checks are in the handoff and run verification file.
