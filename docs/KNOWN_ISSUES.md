# Known issues and risks

| ID | Priority | Observation | Evidence / next verification |
| --- | --- | --- | --- |
| IS-001 | P0 | Real 14:31 MP3 processing was interrupted | Reproduce with Whisper Small, log precise window, stage, backend, worker error and committed checkpoint; root cause unknown |
| IS-002 | P0 | Real hardware acceptance incomplete | Execute `docs/PR18_BROWSER_ACCEPTANCE.md` G1–G10; mocked E2E does not count |
| IS-003 | P1 | Earlier model card appeared to download 337.5 MB again | Distinguish HTTP transfer, cache hit and ONNX initialization in browser Network tab |
| IS-004 | P1 | Historical 123 of 300 segments unlabeled by diarization | Reproduce against same audio and ground truth; do not fabricate speaker labels |
| IS-005 | P1 | Offline availability not confirmed | Test full model/backend asset inventory and offline reload |
| IS-006 | P1 | Resume decodes full source audio again | Profile memory/CPU; optimize only with regression tests |
| IS-007 | P1 | ASR watchdog can mistake silent slow inference for a stall | Test real slow WASM and visibility transitions |
| IS-008 | P1 | Browser storage can be evicted or quota-exhausted | Test storage failures and explicit export recovery |

No issue above is declared fixed without a reproducible test and observed outcome.
