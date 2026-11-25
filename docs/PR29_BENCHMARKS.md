# PR-29 — Reproducible performance and reliability benchmarks

## Scope

PR-29 instruments the existing **browser** recognition path. It does not change Whisper weights, Pyannote/WeSpeaker, window boundaries, IndexedDB transaction semantics, WebGPU/WASM selection or the CPU/GPU implementation.

Each `Job` stores optional, cumulative `benchmark` metadata in the existing IndexedDB v2 record. No schema migration is required. Values survive refresh and continue to accumulate for the remaining windows. Older jobs simply start with empty metrics. Only the most recent 150 **successful** window samples are retained; the maximum source length is one hour (~145 windows). Totals do not depend on the bounded PR-22 trace ring.

### Measurements

| Metric | Unit | What it actually measures |
| --- | --- | --- |
| `decodeMs` | ms | Awaited browser audio decode before ASR, for each run |
| `pcmCheckMs` | ms | Full PCM validation; includes standalone checks |
| `modelInitMs` | ms | Awaited model prepare, when a new ONNX session is needed |
| `asrAttemptMs` | ms | Elapsed `transcribe()` attempts, including failed attempts; not total wall-time |
| `checkpointMs` | ms | Completed **atomic** IndexedDB commit operations for successful ASR windows |
| `speakerMs` | ms | Awaited model diarization, excluding transcript alignment/UI |
| `runMs` | ms | Entire completed or failed job run, including repeated preparation and storage steps |
| `attempts`, `failedAttempts`, `workerRecoveries` | count | Actual attempted windows, failures and completed Worker recoveries |
| `resumedRuns` | count | Runs beginning after a committed ASR checkpoint or complete ASR |
| `asrWindowMs.p50/p95/max` | ms | Distribution of **successful** per-window inference durations |
| `checkpointWindowMs.p50/p95/max` | ms | Distribution of successful window commit durations |
| `asrRtf` | ratio | Total ASR attempt time / sum of **new, nonoverlapping committed seconds** × 1000 |
| `mainThreadHeap.observedPeakBytes` | bytes/null | Best-effort Chromium `performance.memory.usedJSHeapSize` samples on main thread |

An RTF of `0.5` means the measured ASR attempt time was half the *newly committed* audio duration. Unlike naive 30-second-window sums, the denominator does **not double-count 5-second overlaps**. Retries increase the numerator, while a resumed run counts only the newly processed audio seconds. This RTF excludes decoding, model download, checkpoints and speakers; it is **not** total job RTF.

A sample is recorded **after** its checkpoint transaction finishes. If the tab closes in the narrow interval between the atomic checkpoint and the following benchmark-metadata write, the transcript remains durable but that final timing sample may be missing. Benchmark data is diagnostic and must not become a second correctness-critical checkpoint.

### Memory measurement limits

The browser's non-standard JS heap figure is **not** total RAM. It may be missing, and it does not include worker heaps, GPU VRAM, all WASM allocations, full audio decoder allocations or browser process overhead. PR-29 makes no measured peak-RAM claim. Proper memory profiling requires Chrome Task Manager/DevTools or OS-level measurements on the target machine, including Worker and GPU processes. Storage size/eviction also requires a separate inspection.

### Outputs and privacy

A small per-file status line shows committed window count, ASR RTF, p95, checkpoint time, resume count and optionally sampled JS heap. **Бенчмарк JSON** downloads a numerical report with:

- model/language settings and stage, duration in seconds, counts and cumulative timing totals;
- p50/p95/max and per-window elapsed measurements;
- clearly stated source, scope and measurement limitations.

No source filename, speaker ID, transcript text, PCM samples, raw exception, OS username, GPU/device fingerprint or audio is exported. Reports are generated locally. Synthetic CI measurements must **never** be combined with real hardware results as if they were comparable.

### Automated CI fixtures — synthetic, NOT real Whisper measurements

The existing 14m31s Playwright acceptance fixture simulates 35 ASR windows, interrupts processing after a checkpoint, refreshes, resumes and downloads its benchmark. The CI validates that:

1. Exactly 35 checkpoints/wall-clock samples are recorded and remain durably associated with the job.
2. The **unique** committed audio duration is 871 seconds, not the sum of overlapping 30-second windows.
3. The completed windows are not re-inferred after refresh.
4. A benchmark JSON report can be downloaded without the source filename or synthetic transcript content.
5. The output artifact is explicitly named `synthetic-benchmark.json` and includes `ciFixture: mocked-Whisper-871s; NOT a real inference benchmark`. This is useful to detect report-schema regressions, **not** to rank GPUs or estimate Whisper Small performance.

Unit tests cover percentile math, RTF, bounded retention, privacy, persisted stages, resume and speaker-only retries. No absolute timing threshold is used in CI because runner performance and mocked inference are not representative.

### Real benchmark protocol — PR-30 acceptance

| Gate | Procedure | Measurements/criterion |
| --- | --- | --- |
| HW-P1 | Run the same real 14:31 / 33.3 MB MP3 with Whisper Small, ru, on the target browser | 35 committed windows, downloadable TXT, exact source and model/backend documented |
| HW-P2 | Restart app after 2 committed windows, then resume | No duplicated ASR text, 35 total commits, `resumedRuns` increments |
| HW-P3 | 3 cold and 3 warm runs, same audio/device and browser build | Record model-init, decode, ASR p50/p95, stage totals, RTF, full job wall time; report median and run-to-run spread |
| HW-P4 | Repeat on WASM after an induced recoverable GPU failure | Real backend change verified; bounded retries, valid TXT, no silent fallback to GPU |
| HW-P5 | 30-minute and 60-minute audio; monitor browser/process memory externally | No uncontrolled growth, browser crashes or lost durable checkpoints; independent RAM/GPU measurements |
| HW-P6 | Test real speaker diarization | Partial results explain unknown speaker labels; TXT remains downloadable |
| HW-P7 | Repeat at least one warm run fully disconnected after successful model caching | No new network dependency; identical checkpoint semantics |

For every test record timestamp, exact Git SHA, browser/OS, GPU/RAM, model+backend, audio duration, warm/cold state, measured values and any error categories. Do **not** upload private source MP3, transcripts or speaker identifiers to CI.

**Status on PR-29:** automatic tests run with mocks; the real 14:31 MP3, real Whisper inference time, genuine GPU memory, crash recovery under heavy load and actual diarization accuracy are **NOT TESTED**.

## Deployment

Stacked on PR-28, followed by PR-27 → PR-26 → PR-25 → PR-24 → PR-23 → PR-22 → PR-21. Merge in order only after passing CI, rerun the combined `main` CI and verify IndexedDB v2 compatibility before updating the public site.
