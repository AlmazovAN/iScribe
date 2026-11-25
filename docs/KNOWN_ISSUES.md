# Known issues and risks

| ID | Priority | Observation | Evidence / next verification |
| --- | --- | --- | --- |
| IS-001 | P0 | Real 14:31 MP3 processing was interrupted | PR-22 adds structured trace export; PR-23 adds decoded PCM/window validation; reproduce original MP3 with real Whisper Small; root cause unknown |
| IS-002 | P0 | Real hardware acceptance incomplete | Execute `docs/PR18_BROWSER_ACCEPTANCE.md` G1–G10; mocked E2E does not count |
| IS-003 | P1 | Earlier model card appeared to download 337.5 MB again | Distinguish HTTP transfer, cache hit and ONNX initialization in browser Network tab |
| IS-004 | P1 | Historical 123 of 300 segments unlabeled by diarization | PR-28 counts gap/ambiguous/weak/boundary matches separately and prevents overlapping same-speaker turns from double-voting. True accuracy/coverage still requires same recording and annotated ground truth |
| IS-005 | P1 | Offline availability not confirmed | PR-26 adds local shell/runtime precache and model file checks; only real disconnected Whisper Small/speaker inference can confirm full offline execution on production domain |
| IS-006 | P1 | Resume decodes full source audio again | PR-25 avoids redundant decoded mono copy, enables transfer for speaker PCM, and uses append-only checkpoints; full resumption still decodes entire source file. Profile RAM on real hardware |
| IS-007 | P1 | ASR watchdog can mistake silent slow inference for a stall | Test real slow WASM and visibility transitions |
| IS-008 | P1 | Browser storage can be evicted or quota-exhausted | Test storage failures and explicit export recovery |

PR-21 CI baseline: verify passed; browser-acceptance failed because Playwright 1.56.1 Chromium does not support the Ubuntu 26.04 image behind ubuntu-latest. PR-22 pins that job to ubuntu-24.04, awaiting CI verification.

PR-23 validation cannot detect all damaged compressed MP3 frames: a browser decoder may conceal corruption. Actual hardware and MP3 reproduction remain mandatory.

PR-24 adds defensive timeouts during model init and speaker processing; a slow but legitimately silent model can still be stopped, and browser device-loss handling needs real hardware testing. Existing ASR/diarization transcript guarantees must remain in place.

PR-25 upgrades the same IndexedDB database to version 2 using lazy per-job migration. **Rollback warning:** older deployed builds opening version 1 will encounter `VersionError` after upgrade. See `docs/PR25_STORAGE_OPTIMIZATION.md`.

PR-26 pre-caches only same-origin, versioned application assets; model weights remain under Transformers CacheStorage. Browser quota/eviction, production deployment and real inference still need testing.

PR-27 restores enqueued file order from IndexedDB. Heavy ML is resumed by a user click, not run automatically on page load. A failed IndexedDB write may leave only an in-memory queue; do not claim persistence in that case.

PR-28 improves deterministic timeline joining but does not tune the underlying speaker models; unknown labels may remain or increase conservatively. It must not be called an accuracy improvement on the reference MP3 before actual comparison.

PR-29 reports browser-observed ASR timing and main-thread JS heap samples, but does not measure GPU VRAM or total process RAM. Synthetic CI fixtures are not actual Whisper performance measurements; see `docs/PR29_BENCHMARKS.md`.

PR-30 adds unverified hardware evidence and a runbook; it does not establish actual Whisper Small, GPU fallback, VRAM or diarization performance on the user's device. CI artifacts explicitly use mocked ML and must never be treated as real hardware acceptance.

PR-31 reduces UI density and introduces an automated distribution integrity gate, but a static package PASS cannot guarantee real Whisper inference, ChatGPT Sites publishing, or safe rollback after IndexedDB v2 migration. The footer exposes only the built commit SHA; verify it against the deployed commit. See `docs/PR31_UI_RELEASE_PREP.md`.

PR-32 adds experimental MP3 streaming ASR for files >128 MB and <=512 MB while retaining the one-hour duration ceiling. Hardware reliability, upload/storage quota for a very large Blob, MP3 metadata edge cases, accurate timestamps, long-running WebCodecs and RAM peaks remain UNVERIFIED. The current diarization engine still requires complete PCM; speaker separation is explicitly disabled in large-MP3 streaming mode. See `docs/PR32_LARGE_MP3_STREAMING.md`.

No issue above is declared fixed without a reproducible test and observed outcome.
