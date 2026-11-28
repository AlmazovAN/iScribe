# Known issues and risks

Speaker time during an active pass is an estimate derived from the model stages. The recognition meter still advances on durable window commits.

A pending speaker-model download is a request for the current browser session. It is serviced between recordings.

The Diagnostics log retains the latest 256 events per recording. Hardware acceptance still requires manual trials.

The Colab prototype simulates queue activity locally. Authentication, Drive transfers, Python execution and actual Colab disconnect are pending integration.

The standalone HTML contains the browser runtime and supplies the WASM bytes directly to each engine worker to avoid file-origin Blob loading failures. First-use model downloads still require network access, and offline model availability depends on the browser cache for the address used to open the file.

| ID | Priority | Observation | Evidence / next verification |
| --- | --- | --- | --- |
| IS-001 | P0 | Real 14:31 MP3 processing was interrupted | PR-22 adds structured trace export; PR-23 adds decoded PCM/window validation; reproduce original MP3 with real Whisper Small; root cause unknown |
| IS-002 | P0 | Real hardware acceptance incomplete | Execute `docs/PR18_BROWSER_ACCEPTANCE.md` G1–G10; mocked E2E does not count |
| IS-003 | P1 | Earlier model card appeared to download 337.5 MB again | Distinguish HTTP transfer, cache hit and ONNX initialization in browser Network tab |
| IS-004 | P1 | Historical 123 of 300 segments unlabeled by diarization | PR-28 counts gap/ambiguous/weak/boundary matches separately and prevents overlapping same-speaker turns from double-voting. True accuracy/coverage still requires same recording and annotated ground truth |
| IS-005 | P1 | Offline availability not confirmed | PR-26 adds local shell/runtime precache and model file checks; only real disconnected Whisper Small/speaker inference can confirm full offline execution on production domain |
| IS-006 | P1 | Resume decodes the entire source in normal mode | Files above 128 MiB seek to the next uncommitted window. Normal mode still decodes the source again. Profile RAM on real hardware |
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

No issue above is declared fixed without a reproducible test and observed outcome.


## Streaming reliability — PR-07
- Original 41/154 stall on 63:54 / 146.5 MB recording: cause not confirmed; real-device reproduction and acceptance pending.
- Foreground timers cannot interrupt a completely blocked main thread or independently bound IndexedDB writes. Native rendering/disposal may retain resources. JS heap is not full process or GPU memory.
- Strict fallback coverage may reject valid timestamp discontinuities; 5 s split and 20-window rotation need actual MP3 profiling. Fresh-decoder inspection cannot reproduce cumulative resource pressure.
- Stale metadata that would reset recovery reservations is rejected; reload the stale tab before continuing. Do not clear site data.

PERF-01: browser resource hints and host wall-clock measurements are not CPU/GPU utilization or full process memory; effective WASM threads and transfer time remain unknown. See [PERF-01](performance/PERF-01.md).

PERF-02: browser device memory is a coarse hint, not free memory. Mode pacing, provider calibration, WASM configuration and bounded prefetch are implemented in PERF-02–05; real speed and power effects remain unverified. The maximum mode does not bypass safeguards.

PERF-03: provider-specific dtype remains controlled by the engine; single-fragment exact text agreement is not a quality guarantee. GPU adapter preference and GPU buffer residency have not been implemented. Calibration may need additional model files and should be run on representative speech.

PERF-04: file-origin standalone remains one WASM thread. Isolated local server uses a separate storage origin. Worker acknowledgement is pre-init configuration, not actual ORT thread count. Real model inference and provider-specific compatibility remain to be tested.

PERF-05: prefetch disabled for unknown/low memory hints; reported device memory is not free RAM. Prefetch timing overlaps ASR and native decoder memory is not measured. Existing queued windows may drain after a profile change; failure retires lookahead.

PERF-06: actual engine transport and standalone WASM binary clone remain unchanged. Idle model release may add initialization time on subsequent jobs. Browser/OS memory reclamation is not guaranteed by disposal.

PERF-07: abrupt tab loss can omit deferred noncritical trace events since the last durable transaction; text/checkpoints and retry reservations remain atomic. Whole-transcript immutable append and full visible log rendering on opening remain.

PERF-08: streamed diarization remains unavailable. Engine exposes coarse speaker progress, not separate kernel timings; GPU/NN speaker providers and batched embeddings are not enabled. Actual WASM parallelism and diarization accuracy require hardware testing.

PERF-09: legacy baseline exports lack first-run build context; require manual verification. Comparator uses same size/duration and operator confirmation, not audio hash/device attestation. Real hardware and quality tests remain NOT TESTED. Comparison state is tab-local.

PERF-10: real hardware gates T01–T10/HW-1–7 remain NOT TESTED; no production deployment authorized by automatic CI. Independent isolated origin, mandatory old model cache verification, no automatic migration/transfer between origins. Browser/protocol observations are not proof of actual model execution. Integrated source merge is not a hardware-accepted release.

GPU-08: early lookahead can overlap metadata persistence but still competes for host resources. Scheduling lead is not actual GPU/CPU overlap or saved time. Existing two-window cap, one producer, rotation boundary and conservative retirement after decoder failure remain. No production GPU tensor transfer changes or full-audio pipeline changes. Full regression and hardware performance NOT TESTED.

GPU-09: adaptive depth uses host readiness and observed wait, not GPU utilization, energy, free RAM or proven speedup. Two-window eligibility may be unavailable because browsers expose coarse/capped device memory hints. Existing queued windows may drain during a trial. The thresholds are heuristics requiring real-recording acceptance. No automatic provider/model/dtype changes. Full suite and hardware NOT TESTED.

- Local pipeline: legacy release candidates without manifests need explicit selection; stale candidates must be refreshed against main. Automatic cleanup, remote success report and retry queue are deferred. Real Windows acceptance pending.


## DIAG-01 — компактная диагностика
Одна постоянно видимая строка: выбор записи, текущий номер окна, единый JSON с событиями и вложенным бенчмарком. Отдельные ручные проверки, аппаратная панель, ручная калибровка и панель кэша удалены. Автоматическая проверка PCM, восстановление, кэш моделей и регистрация service worker сохранены. Схема старых заданий совместима; исторические поля не мигрируют. Аппаратная приёмка и локальный CI: NOT TESTED до выполнения локального конвейера. Сбой второго окна Whisper в standalone/WebGPU не исправлен; нужен повтор с единым журналом и данными текущей попытки. `elapsedSinceAttemptEventMs` — время с события перед dispatch, не чистое время GPU. Сравнение с предыдущей версией и изоляция повторного использования PCM требуются для подтверждения причины.


DEC-01: full-file FFmpeg can use substantial memory; streamed route unchanged; GPL/source distribution review and real MP3/AAC and file:// tests required before release. Whisper stall root cause remains unconfirmed.


DEC-02: FFmpeg random-seek overlap, VBR duration/tail probe, repeated CLI memory behavior, WORKERFS availability and decoder-switch checkpoint compatibility require local validation. No silent source copy, padding or fallback is allowed.


DEC-03: untagged historical checkpoints are assumed legacy; experimental runs from DEC-01/02 must be recreated as new jobs. Real seek fidelity and full/stream recovery remain unverified.


DEC-04: FFmpeg full route still limited to one hour, streamed mode still excludes speakers; legacy removal deferred until migration/hardware acceptance. Native CLI reference PASS is not browser/WASM acceptance. Public distribution requires corresponding-source/license review.


DEC-04 local iteration 1: dependencies/typecheck/lint/Vitest 234/234 PASS; Playwright 14/16, two valid WAV stream opens FAIL at FFprobe. Candidate patch addresses known core 0.12.10 false -1 and reads validated JSON from a fresh file; new probe diagnostics. Revised candidate NOT TESTED; no main merge.


DEC-04 iteration 2: Vitest 238/238, primary Playwright 16/16, standalone/web builds and web preflight PASS; offline 5/6 (file:// FFmpeg only). Standalone worker transport changed to inline core and cloned compressed Blob; revised candidate pending local CI.


DEC runtime follow-up: main 918d0f1 local CI PASS (239 unit, 22 browser); real full FFmpeg decode exit 1 twice, root cause unknown. New bounded diagnostic categories and real synthetic MP3 browser test; revised candidate NOT TESTED. Strict decode/PCM policies unchanged.

PIPE-02: finite PCM and advisory signal statistics cannot establish absence of compressed frame damage, speech loss or discontinuity between independent windows. Actual validation cost and real audio acceptance remain pending. PIPE-01/#76 remain unaccepted.

PIPE-03: stage trace observations are not independent durable checkpoints; abrupt closure can lose latest stage events. Streaming decode-open/PCM deferred does not prove all windows valid. VAD, forced alignment and streaming speaker support remain unimplemented; stage persistence is PIPE-04. Full project gates pending.

PIPE-04: database v3 upgrade is forward-only for older v2 readers; require separate-profile migration rehearsal before deployment. Full PCM cache consumes local quota; orphan stream PCM can remain after abrupt exit until job removal; no immutable model weight hashes, no independent VAD/alignment or full reusable streamed PCM yet. Source uses SHA-256-of-chunk-hashes, not standard whole-file hash. Browser Web Crypto and actual storage/performance gates pending.

PIPE-05: speculative prefetch accounted on consumption, model initialization/rotation/manual preload outside durable ledger. Legacy retry history incomplete; prior decoder reservations conservatively retained. Global cap 10 is a design default, hardware and additional metadata I/O acceptance pending. #76 integration must reconcile full decoder recovery with ledger. No claim of confirmed Worker disposal when a lower layer suppresses failure.

PIPE-06: successful terminate request is not proof of RAM/VRAM returned to OS. Browser idle timers can be throttled; 120s lease is provisional. Full PCM can remain resident through speaker/export; lower-level suppressed or late opening cleanup failures are not fully observable. Actual memory and 10-job regression acceptance pending. #76 reconciliation remains mandatory.

PIPE-07: VAD is opt-in and advisory, no audio suppression; actual Silero weights, CORS/cache, ORT standalone/web initialization and RU/EN speech recall NOT TESTED. Model fetch and npm blocked by DNS in development. Thresholds provisional, no streaming VAD or per-frame durable recurrent state. Do not use empty speech map to drop audio.

PIPE-08: adaptive mode opt-in, no speech exclusion, variable window count and added PCM hashing/plan transaction. No real Silero, WER, boundary quality or hardware acceptance yet. Identical midpoint ownership does not prove equivalent ASR predictions. Streamed input stays fixed. Pinned plan requires compatible source/PCM; no automatic geometry reset.

PIPE-09: quality thresholds provisional, advisory not proof of hallucinations, whole-window near-zero signal only; repetition heuristics may flag correct speech. Engine generation options/batching not verified, real WER and overhead pending. No automatic deletion or inference retry on quality warning. Older committed windows not retrospectively checked.

PIPE-10: experimental alignment requires real model/provider and word timing/coverage validation. Unknown characters, digits, mixed language and weak scores can leave segments unaligned. No streaming or durable per-segment progress; no automatic retry. Original TXT/speaker timing unchanged; private word JSON contains text and must not enter diagnostics upload. Actual cost of q8 model loading and memory unknown.

PIPE-11: word speaker thresholds provisional, CTC coverage/real assignment quality and overhead not verified. Output rows may increase, compare counts with correct denominator. Full-pass labels are not identities across independent recordings/passes. Streaming requires verified embedding access/global clustering and remains unsupported; no DER improvement claimed. Pinned word mode fails closed on missing RAW; new acoustic pass requires new job.
