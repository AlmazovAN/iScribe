# iScribe project status — 2026-11-25

## Verified from GitHub

- PR-13, PR-14, PR-15, PR-16, PR-17, PR-18 and PR-20 were merged into `main`.
- PR-19 was closed without merging as a duplicate.
- Existing source includes committed ASR windows, bounded retries, watchdog, separate speaker pass and independent text export.
- The current default ASR watchdog threshold is five minutes of visible-tab inactivity.

## Not verified

- Production deployment corresponds to the latest `main`.
- Actual Whisper Small/WebGPU inference on the user's 14:31 / 33.3 MB MP3.
- Offline startup after full cache population.
- Speaker accuracy on the original 97-turn / 300-segment recording (123 unlabeled). PR-28 adds diagnostics, but reference-audio validation is still pending.
- Runtime memory peaks and GPU fallback on real hardware.
- New PR-25 CI and hardware-memory acceptance (CI still pending). PR-22, PR-23 and PR-24 passed their respective mock/CI suites; hardware tests remain outstanding.

## Next stages

PR-22: implementation on stacked PR-22; structured per-window traces, privacy-safe JSON export, and CI runner fix. Real hardware NOT TESTED. PR-23: code implemented on stacked PR-23; standalone decoded-PCM preflight, 35-window integrity, malformed timestamp guards and acceptance tests. CI/hardware validation to follow. PR-24: ML lifecycle (stacked PR-24) — explicit session status, bounded model/speaker idle guards, safe attempt-backend capture for WASM recovery. Real hardware NOT TESTED. PR-25: chunked IndexedDB v2 persistence and speaker-PCM transferable buffer (stacked PR-25). New tests and CI in progress. Full-audio decode on resume and hardware memory profiling remain unresolved. PR-26: Service Worker shell precache, separate WASM/q8 model readiness, safe cached model responses, actual production-offline browser tests (stacked PR-26). Real-device Whisper inference offline NOT TESTED. PR-27: durable FIFO queueOrder in IndexedDB v2, paused restoration after reload, one-click resume, lock-safe retry and Playwright tests (stacked PR-27). Real hardware pending. PR-28: conservative per-speaker overlap union, guarded timestamp-edge matching, explainable counts for unlabeled segments, and speaker-only retry tests (stacked PR-28). Reference audio accuracy NOT TESTED. PR-29: cumulative benchmark metrics, ASR/commit p50-p95/RTF, JS heap sampling, private export and explicitly synthetic 14:31 CI artifact (stacked PR-29). Real Whisper/GPU/RAM profiling NOT TESTED. PR-30: hardware acceptance checklist in the browser and privacy-safe JSON evidence generated from actual IndexedDB state; all real-device HW-1–HW-7 remain NOT TESTED. See docs/PR30_HARDWARE_ACCEPTANCE.md. PR-31: UI refinement.
