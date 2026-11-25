# Known issues and risks

| ID | Priority | Observation | Evidence / next verification |
| --- | --- | --- | --- |
| IS-001 | P0 | Real 14:31 MP3 processing was interrupted | PR-22 adds structured trace export; PR-23 adds decoded PCM/window validation; reproduce original MP3 with real Whisper Small; root cause unknown |
| IS-002 | P0 | Real hardware acceptance incomplete | Execute `docs/PR18_BROWSER_ACCEPTANCE.md` G1–G10; mocked E2E does not count |
| IS-003 | P1 | Earlier model card appeared to download 337.5 MB again | Distinguish HTTP transfer, cache hit and ONNX initialization in browser Network tab |
| IS-004 | P1 | Historical 123 of 300 segments unlabeled by diarization | Reproduce against same audio and ground truth; do not fabricate speaker labels |
| IS-005 | P1 | Offline availability not confirmed | Test full model/backend asset inventory and offline reload |
| IS-006 | P1 | Resume decodes full source audio again | PR-25 avoids redundant decoded mono copy, enables transfer for speaker PCM, and uses append-only checkpoints; full resumption still decodes entire source file. Profile RAM on real hardware |
| IS-007 | P1 | ASR watchdog can mistake silent slow inference for a stall | Test real slow WASM and visibility transitions |
| IS-008 | P1 | Browser storage can be evicted or quota-exhausted | Test storage failures and explicit export recovery |

PR-21 CI baseline: verify passed; browser-acceptance failed because Playwright 1.56.1 Chromium does not support the Ubuntu 26.04 image behind ubuntu-latest. PR-22 pins that job to ubuntu-24.04, awaiting CI verification.

PR-23 validation cannot detect all damaged compressed MP3 frames: a browser decoder may conceal corruption. Actual hardware and MP3 reproduction remain mandatory.

PR-24 adds defensive timeouts during model init and speaker processing; a slow but legitimately silent model can still be stopped, and browser device-loss handling needs real hardware testing. Existing ASR/diarization transcript guarantees must remain in place.

PR-25 upgrades the same IndexedDB database to version 2 using lazy per-job migration. **Rollback warning:** older deployed builds opening version 1 will encounter `VersionError` after upgrade. See `docs/PR25_STORAGE_OPTIMIZATION.md`.

No issue above is declared fixed without a reproducible test and observed outcome.
