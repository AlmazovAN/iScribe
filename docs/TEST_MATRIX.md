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
| OFFLINE-1 | Production shell with ONNX runtime | Load online, disconnect, reload and recover saved job in Chromium | NOT TESTED on PR-26 |
| OFFLINE-2 | Model q8 WASM profile | GPU-only cache must NOT satisfy WASM fallback readiness | NOT TESTED on PR-26 |
| OFFLINE-3 | Model fetch offline | Exact cached response, missing file failure, Range safety | NOT TESTED on PR-26 |
| QUEUE-1 | Durable FIFO across reload | Pending jobs retain stored position, first interrupted job keeps checkpoint | NOT TESTED on PR-27 |
| QUEUE-2 | Resume restored queue | One click processes pending jobs in order, no duplicate ASR | NOT TESTED on PR-27 |
| QUEUE-3 | Cross-tab lock denial | No inference; queued entries remain available to retry | NOT TESTED on PR-27 |
| SPEAKER-1 | Mixed valid/malformed/overlapping speaker intervals | Count rejected intervals, union duplicates and avoid over-weighting one speaker | NOT TESTED on PR-28 |
| SPEAKER-2 | Edge gaps and near speaker ties | Only bounded 80 ms / 250 ms edge recovery; unknown remains unknown | NOT TESTED on PR-28 |
| SPEAKER-3 | Partial speakers and retry | Redacted reason counts saved; TXT survives; no repeat ASR on retry | NOT TESTED on PR-28 |
| BENCH-1 | Synthetic 871s + 35 ASR windows | Window times, unique committed 871s, correct RTF and p95 | NOT TESTED on PR-29 |
| BENCH-2 | Checkpoint timing and resume | Durable cumulative measurements, no duplicated windows after refresh | NOT TESTED on PR-29 |
| BENCH-3 | Local benchmark JSON export | Numeric measurements with no filename, speech text or exception strings | NOT TESTED on PR-29 |
| HW-1 | Real Whisper Small, ru, 14:31 MP3 | 35 windows complete; TXT export | NOT TESTED |
| HW-2 | Reload after two committed windows | Resume without duplicate text | NOT TESTED |
| HW-3 | Real GPU error and WASM fallback | Bounded retry, truthful backend | NOT TESTED |
| HW-4 | Offline reload with cached weights/runtime | ASR succeeds without network | NOT TESTED |
| HW-5 | Diarization on reference audio | Measured coverage and speaker quality | NOT TESTED |
| HW-6 | Memory and long-audio 30/60 minutes | No uncontrolled growth or lost checkpoints | NOT TESTED |

For each run record commit SHA, OS/browser, GPU/RAM, model/backend, audio length, checkpoint, duration, logs (redacted), outcome and reproducibility. Keep personal audio out of GitHub.
