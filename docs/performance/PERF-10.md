# PERF-10 — Performance Release (integrated candidate)

## Scope and gate

Base of the performance series: main `dfdd1ebcabdae45e3a3ba3c4e003929e3c832785`. All stages are retained in a linear ancestor chain. Use one integration PR targeting main, with merge commit (not squash) to retain all changes and history. Reconfirm main has not advanced unexpectedly. Do not merge until the exact integrated head CI succeeds; verify resulting main tree and subsequent push CI. Do not publish production site without explicit hardware acceptance and deployed-version verification.

| Stage | PR | Verified automated CI at preparation |
| --- | --- | --- |
| PERF-01 Profiler | 48 | PASS 45880324810 |
| PERF-02 Resource Manager | 49 | PASS 45880673159 |
| PERF-03 Backend Optimization | 50 | PASS 45882237199 |
| PERF-04 WASM Multithreading | 51 | PASS 45882799401 |
| PERF-05 Audio Pipeline | 52 | PASS 45883143667 |
| PERF-06 Memory Optimization | 53 | PASS 45884063298 |
| PERF-07 Storage & UI | 54 | PASS after collapsed-log fix 45885604950 |
| PERF-08 Speaker | 55 | PASS 45885746103 |
| PERF-09 Benchmark | 56 | Original verify PASS, browser FAILED 45886339011 (ambiguous selectors); fix 2ac6983 awaiting rerun |
| PERF-10 Integration | final | Pending exact-head CI |

CI includes typecheck, lint, Vitest, Chromium browser tests, standalone/web builds, both package integrity checks and offline/isolation tests. Mocked Whisper and synthetic decoder tests cannot establish actual model accuracy or GPU performance. Final new browser regression covers six synthetic comparisons and JSON export, not hardware. No production publishing in this stage.

## Audit decisions

- One active ASR model/Worker; independent speaker Worker after durable ASR. Speaker backend remains WASM/q8; GPU/NN and batch embeddings not enabled. Existing source/weights/cache IDs preserved.
- IndexedDB v2 layout and atomic text/checkpoint semantics unchanged; retries remain bounded; no model/quality downgrade. Intermediate diagnostic events may be lost on abrupt tab exit. Preserve existing decoder rotation and recovery budget.
- Standalone preserves single-thread WASM; isolated loopback mode uses COOP/COEP and browser capability checks. Actual ONNX threads and GPU buffer residency are unverified. Prefetch conservative when memory hint unknown; queued windows bounded. No direct engine transport patch or unverified new dependencies.
- Candidate comparison resets consumed file selections, separates audio/JSON selectors and avoids horizontal overflow. Existing report formats are additive. No automatic hardware PASS, no private audio or transcript in reports. Baseline identity depends on manual verification.
- Known deferred work: true accelerator tuning (adapter/residency), separate speaker GPU/NN and batching, streaming speakers, internal engine copies, chunked in-memory transcript. No proven speedup.

## Local build and verification

Run in existing project checkout with a clean worktree. Save TXT first; do not delete browser databases or cache. Inspect `git status --short` before updating. Once the final main integration has been confirmed:

```powershell
git switch main
git pull --ff-only origin main
git rev-parse HEAD
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run release:check
```

Check each exit code and stop on failure. Open `dist/iScribe.html` directly; verify visible SHA against the checkout and preserve older working file separately before replacing it. For local full browser acceptance, install pinned Playwright as documented in README, run `npx playwright test`, build web separately with `npm run build:web`, run `npm run release:check:web` and `npx playwright test --config playwright.offline.config.mjs`. Build/dependency install requires suitable environment; no script execution assumption on managed corporate computer. Node is not required on the machine opening the standalone HTML. Actual local device execution not performed by GitHub connector.

## Hardware gate, status: NOT TESTED

Use real production bundle and same representative audio. Prioritize T02 (14:31 reference, 35 windows), T04 (63:54, 154 windows, original window-41 issue) and T08 recovery, then T03/T06/T09/T10 and other cases according to [PERF-09](PERF-09.md). Compare baseline and candidate from separate builds; record actual external RAM/VRAM, RTF, WER/DER, errors and checkpoints. Preserve original audio and reference locally. For production release require genuine HW-1/HW-2, privacy/cache compatibility and relevant supported-function gates. No measured improvement yet. If rollback is needed, preserve IndexedDB v2 compatibility and restore a known tested build; never clear browser data as a routine rollback.

## Status

Candidate prepared, final CI and source merge not yet recorded in this document; use exact GitHub checks and PR state. Final hardware acceptance NOT TESTED. Public ChatGPT Sites/Pages not deployed.

## Urgent source integration
Owner requested urgent main integration before final CI confirmation. Previous run 45886909294 passed verify (typecheck/lint/Vitest), but four browser tests failed on ambiguous or exact labels after new controls were introduced. Scoped selectors corrected in this commit; rerun required. Source merge is explicitly not a tested release; do not deploy production or claim hardware acceptance. If GitHub required checks block merge, preserve protections.
