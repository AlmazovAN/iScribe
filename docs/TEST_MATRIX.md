# Test matrix

PASS means an observed execution, not merely code presence. NOT TESTED is the initial status for hardware tests below.

| Gate | Test | Expected result | Status |
| --- | --- | --- | --- |
| CI-1 | npm ci, typecheck, lint, Vitest, build | All commands succeed on current SHA | NOT TESTED on PR-22 |
| CI-2 | Playwright browser acceptance with deterministic ML stub | Reload, checkpoint, TXT exports pass | NOT TESTED on PR-22 |
| DIAG-1 | Structured event journal and JSON export | Sanitized event log survives checkpoints; no filename/audio/transcript | NOT TESTED on PR-22 |
| AUDIO-1 | Decoded PCM integrity and standalone inspection | Reject NaN/Infinity, preserve checkpoints, no Whisper started | NOT TESTED on PR-23 |
| AUDIO-2 | 871s window boundaries | Exactly 35 windows, stable midpoint ownership | NOT TESTED on PR-23 |
| AUDIO-3 | Browser MP3 decoder errors | Decoder failure stops processing before ASR | NOT TESTED on PR-23 |
| ENGINE-1 | Model initialization inactivity timeout | Worker discarded and model can be retried | NOT TESTED on PR-24 |
| ENGINE-2 | Speaker preload and diarization inactivity | Worker cleaned up; saved TXT kept | NOT TESTED on PR-24 |
| ENGINE-3 | WebGPU attempt lost before retry | Actual prior backend retained; recovery requires WASM | NOT TESTED on PR-24 |
| STORAGE-1 | Append-only ASR chunks + metadata | No duplicate stored segments or whole-transcript rewrite per window | NOT TESTED on PR-25 |
| STORAGE-2 | Lazy upgrade from v1 to v2 | Old text/audio survive, one transaction per migration and checkpoint | NOT TESTED on PR-25 |
| STORAGE-3 | Failure rollback | Earlier durable checkpoint and text unchanged after failed write | NOT TESTED on PR-25 |
| MEMORY-1 | PCM memory reuse and speaker transfer | 16 kHz mono does not duplicate PCM; speaker buffer transferred or safely cloned | NOT TESTED on PR-25 |
| HW-1 | Real Whisper Small, ru, 14:31 MP3 | 35 windows complete; TXT export | NOT TESTED |
| HW-2 | Reload after two committed windows | Resume without duplicate text | NOT TESTED |
| HW-3 | Real GPU error and WASM fallback | Bounded retry, truthful backend | NOT TESTED |
| HW-4 | Offline reload with cached weights/runtime | ASR succeeds without network | NOT TESTED |
| HW-5 | Diarization on reference audio | Measured coverage and speaker quality | NOT TESTED |
| HW-6 | Memory and long-audio 30/60 minutes | No uncontrolled growth or lost checkpoints | NOT TESTED |

For each run record commit SHA, OS/browser, GPU/RAM, model/backend, audio length, checkpoint, duration, logs (redacted), outcome and reproducibility. Keep personal audio out of GitHub.
