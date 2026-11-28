# Test matrix

PASS means an observed execution, not merely code presence. NOT TESTED is the initial status for hardware tests below.

| Gate | Test | Expected result | Status |
| --- | --- | --- | --- |
| CI-1 | npm ci, typecheck, lint, Vitest, build | All commands succeed on current SHA | NOT TESTED on PR-22 |
| AUDIO-2B | Import a >128 MiB WAV, commit one window, reload and continue | Bounded decode with the original checkpoint and absolute timestamps | Automated in Playwright |
| PROGRESS-UI | Pause with an active window after two checkpoints | Active window, saved timecodes, model label and animated meter appear in the audio row | Automated in Playwright |
| QUEUE-UI | Queue recordings in a different order, remove a waiting slot and request speaker preload | Rows follow FIFO, cancel preserves checkpoints, finished records move down, and preload starts after the active job | Automated in Playwright |
| DIAG-UI | Open Diagnostics below the ML status bar | Hardware acceptance, record log, PCM controls and JSON exports are available there | Automated in Playwright |
| COLAB-UI | Drive link, demo job failure, reload, retry and TXT | Simulated FIFO, durable browser state and idle shutdown | Automated in Playwright |
| DIST-1 | Open the single HTML via `file://` in Chromium | UI renders and the embedded Worker reaches ONNX parsing using a deliberately invalid model | Automated in Playwright |
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
| HW-EVIDENCE-1 | Browser and IndexedDB hardware evidence | Safely cross-check stored audio/text/checkpoints and export redacted JSON | NOT TESTED on PR-30 |
| HW-EVIDENCE-2 | Synthetic CI anti-false-pass | All seven gates always stay NOT TESTED, even with synthetic complete 35-window output | NOT TESTED on PR-30 |
| UI-1 | Compact file controls | Three TXT formats visible; secondary tools accessible via details on desktop and narrow screen | NOT TESTED on PR-31 |
| RELEASE-1 | Static package preflight | Compiled JS/CSS/ONNX-WASM, SW, licenses, relative entrypoint; no synthetic harness | NOT TESTED on PR-31 |
| HW-1 | Real Whisper Small, ru, 14:31 MP3 | 35 windows complete; TXT export | NOT TESTED |
| HW-2 | Reload after two committed windows | Resume without duplicate text | NOT TESTED |
| HW-3 | Real GPU error and WASM fallback | Bounded retry, truthful backend | NOT TESTED |
| HW-4 | Offline reload with cached weights/runtime | ASR succeeds without network | NOT TESTED |
| HW-5 | Diarization on reference audio | Measured coverage and speaker quality | NOT TESTED |
| HW-6 | Memory and long-audio 30/60 minutes | No uncontrolled growth or lost checkpoints | NOT TESTED |

For earlier *automated* gates, the historical `NOT TESTED on PR-n` text above was the matrix's initial state, not the latest observed result. Source-of-truth CI links for passed PR-22–30 are in [PROJECT_STATUS.md](PROJECT_STATUS.md). Each result validates mocked or synthetic ML behavior and must not be promoted to a hardware PASS.

For each real-device run record commit SHA, OS/browser, GPU/RAM, model/backend, audio length, checkpoint, duration, logs (redacted), outcome and reproducibility. Keep personal audio out of GitHub.


## Streaming recovery — PR-07
| Gate | Expected | Status at PR creation |
| --- | --- | --- |
| STR-1 | PR-06 integrated typecheck/lint/Vitest | PASS, 161/161, run 45803738028 |
| STR-2 | PR-07 exact SHA typecheck/lint/Vitest | Pending CI |
| STR-3 | Real Chromium WAV window 41 whole/split, durable JSON, no ML | Pending CI |
| STR-4 | Real 48→16 kHz resampling and split PCM comparison | Pending CI |
| STR-5 | Standalone/web builds, release preflight, offline browser tests | Pending CI |
| HW-S1–6 | Real original MP3/Whisper Small and resource measurements | NOT TESTED |
See [acceptance protocol](STREAM_RECOVERY_ACCEPTANCE.md) for procedures and criteria.

## PERF-01

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-01-U | Bounded aggregate timings, backend counters, privacy and null unavailable fields | NOT TESTED |
| PERF-01-R | Runner persists observations across existing checkpoints | NOT TESTED |
| PERF-01-H | Real recording and external CPU/GPU/RAM profiling | NOT TESTED |

## PERF-02

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-02-U | Persistent profile, conservative targets, cancellable pacing and recovery cap | NOT TESTED |
| PERF-02-R | Mode switch only at next window; previous checkpoints remain intact | NOT TESTED |
| PERF-02-H | Real-device mode comparison | NOT TESTED |

## PERF-03

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-03-U | Strict provider requests, no disguised fallback, cached choice expiry and invalidation | NOT TESTED |
| PERF-03-H | Same real speech fragment on supported providers; compare time and quality externally | NOT TESTED |

## PERF-04

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-04-U | Thread target clamp, acknowledgement, session reuse/refresh and cache scoping | NOT TESTED |
| PERF-04-B | Loopback COOP/COEP and shared memory in page and Worker | NOT TESTED |
| PERF-04-H | Real ASR performance, memory and quality at 1/2/4/6/8 threads on compatible hardware | NOT TESTED |

## PERF-05

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-05-U | Bounded sequential producer, FIFO, cancellation and backpressure | NOT TESTED |
| PERF-05-R | Overlap, exactly-once commits, deferred decoder recovery | NOT TESTED |
| PERF-05-H | Same long recording, compare RTF, memory, failures and text | NOT TESTED |

## PERF-06

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-06-U | Direct mixing/resampling, detached buffer rejection, transfer scope, idle release | NOT TESTED |
| PERF-06-R | Reuse during ASR and intact checkpoints; existing recovery regression | NOT TESTED |
| PERF-06-H | Actual peak RAM/VRAM and sample accuracy during long recordings/queue | NOT TESTED |

## PERF-07

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-07-U | Trace flush decision and stage-aware UI progress limiter | NOT TESTED |
| PERF-07-R | Sequential streaming commits and trace persist after coalescing | NOT TESTED |
| PERF-07-H | Actual transaction latency, React render cost, RTF on real device | NOT TESTED |

## PERF-08

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-08-U | Index candidates, preserved labels/thresholds, milestone reporting and configuration ordering | NOT TESTED |
| PERF-08-H | Real Pyannote/WeSpeaker output, thread comparison, memory and speaker accuracy | NOT TESTED |

## PERF-09

| Gate | Expected | Status |
| --- | --- | --- |
| PERF-09-U | Validate input, reject incomparable/resumed runs, median and privacy | NOT TESTED |
| PERF-09-R | Combined hardware/benchmark export with first run context | NOT TESTED |
| PERF-09-H | T01–T10 real device and external quality/resource observations | NOT TESTED |

## PERF-10 release candidate
The initial PERF-01–09 NOT TESTED entries above describe status at creation; see exact-head automated run IDs in [PERF-10](performance/PERF-10.md). PERF-01–08 have passed; PERF-09 selectors corrected, rerun required. Final candidate full CI must pass before source integration. Hardware entries remain NOT TESTED. New comparison browser test imports synthetic independent reports, tests median, duplicate protection and redaction. No genuine ML performance claim.

## GPU-08

| Gate | Expected | Status |
| --- | --- | --- |
| GPU-08-U | Legacy reports omit unavailable early lead; new reports round observations | NOT TESTED (Vitest added) |
| GPU-08-R | Next PCM read begins while metadata write is pending, no ASR before write, exactly-once FIFO commits | NOT TESTED (Vitest added) |
| GPU-08-H | Same long recording and mode before/after, RTF, waitMs, resource pressure, unchanged transcript and recovery | NOT TESTED |

## GPU-09

| Gate | Expected | Status |
| --- | --- | --- |
| GPU-09-U | Three ready observations trigger one-window trial; two meaningful misses restore two; invalid observations rejected; ceiling unchanged | 12 isolated helper assertions PASS; Vitest NOT TESTED |
| GPU-09-R | Manager preserves selected mode, threads, pacing, recovery cap, and report compatibility | NOT TESTED (Vitest added) |
| GPU-09-H | Compare real long recordings, wait time, RTF, memory pressure and quality across profiles; verify no material regression | NOT TESTED |

- Local CI v7: Windows Vitest invokes the offline PowerShell suite for manifest binding, stale/duplicate manifests, excluded draft/experimental PRs, stage ancestry and changed manifest rejection. Linux skips this Windows-specific test. Actual Windows run pending.


## DIAG-01 — компактная диагностика
Одна постоянно видимая строка: выбор записи, текущий номер окна, единый JSON с событиями и вложенным бенчмарком. Отдельные ручные проверки, аппаратная панель, ручная калибровка и панель кэша удалены. Автоматическая проверка PCM, восстановление, кэш моделей и регистрация service worker сохранены. Схема старых заданий совместима; исторические поля не мигрируют. Аппаратная приёмка и локальный CI: NOT TESTED до выполнения локального конвейера. Сбой второго окна Whisper в standalone/WebGPU не исправлен; нужен повтор с единым журналом и данными текущей попытки. `elapsedSinceAttemptEventMs` — время с события перед dispatch, не чистое время GPU. Сравнение с предыдущей версией и изоляция повторного использования PCM требуются для подтверждения причины.


## DEC-01

| Gate | Expected | Status |
| --- | --- | --- |
| DEC-CORE-1 | Real WASM synthetic WAV -> mono 16 kHz; invalid compressed input rejected | Tests added; NOT TESTED |
| DEC-CORE-2 | MP3/AAC/FLAC/Ogg/WebM; PCM compared with native FFmpeg | NOT TESTED |
| DEC-CORE-3 | Standalone file:// and web offline, cancellation, no network audio | NOT TESTED |
| DEC-CORE-4 | npm ci, typecheck, lint, Vitest, builds and preflights | NOT TESTED |


## DEC-02

| Gate | Expected | Status |
| --- | --- | --- |
| DEC-STREAM-1 | Real FFmpeg WORKERFS, synthetic WAV overlap, repeat seek, tail and close | Tests added; NOT TESTED |
| DEC-STREAM-2 | >128 MiB real MP3/VBR/AAC; bounded memory, correct tail/overlap | NOT TESTED |
| DEC-STREAM-3 | Reject short/non-finite PCM and invalid source; cancellation | Tests added; NOT TESTED |
| DEC-STREAM-4 | Offline/file://, full CI, checkpoint recovery and real Whisper | NOT TESTED |


## DEC-03

| Gate | Expected | Status |
| --- | --- | --- |
| DEC-REC-1 | Typed transient errors consume durable recovery budget; deterministic failures stop | Tests added; NOT TESTED |
| DEC-REC-2 | Resume pins provider/route/revision and retains saved text | Tests added; NOT TESTED |
| DEC-REC-3 | JSON omits raw errors/audio/transcripts and labels decoder/phase | Tests added; NOT TESTED |
| DEC-REC-4 | Real worker timeout, reopen/split, cancel and retry, checkpoint reload | NOT TESTED |


## DEC-04

| Gate | Expected | Status |
| --- | --- | --- |
| DEC-REF | Native FFmpeg 7.1.5 synthetic five-format full/seek/tail comparison | PASS for generated samples only |
| DEC-DIST | Actual production FFmpeg decode via file:// and cached offline web | Tests added; NOT TESTED |
| DEC-41 | Actual browser FFmpeg distant seek and six subwindows | Test added; NOT TESTED |
| DEC-RETRY | Runner typed failure recovery and durable reservation | Tests added; NOT TESTED |
| DEC-CI | npm ci, typecheck, lint, Vitest, both builds and browser suites | NOT TESTED |
| DEC-HW | Real recordings, WebGPU/WASM and memory | NOT TESTED |


DEC-04 local iteration 1: dependencies/typecheck/lint/Vitest 234/234 PASS; Playwright 14/16, two valid WAV stream opens FAIL at FFprobe. Candidate patch addresses known core 0.12.10 false -1 and reads validated JSON from a fresh file; new probe diagnostics. Revised candidate NOT TESTED; no main merge.


DEC-04 iteration 2: Vitest 238/238, primary Playwright 16/16, standalone/web builds and web preflight PASS; offline 5/6 (file:// FFmpeg only). Standalone worker transport changed to inline core and cloned compressed Blob; revised candidate pending local CI.


DEC runtime follow-up: main 918d0f1 local CI PASS (239 unit, 22 browser); real full FFmpeg decode exit 1 twice, root cause unknown. New bounded diagnostic categories and real synthetic MP3 browser test; revised candidate NOT TESTED. Strict decode/PCM policies unchanged.
