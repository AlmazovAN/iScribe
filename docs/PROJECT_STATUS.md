# iScribe — project status (2026-11-25)

## Local build

- `npm run build` produces the single application file `dist/iScribe.html` with the browser runtime and licenses embedded. Model weights are retrieved separately on first use.
- The standalone HTML passes the embedded WASM bytes to each engine worker so ONNX can initialize when opened from disk.
- `npm run build:web` produces the GitHub Pages package in `dist-web/`, including the Service Worker.

- Source files up to 500 MiB are accepted. Recordings above 128 MiB use windowed decoding and retain ASR checkpoints. Streamed recordings can exceed one hour and produce TXT with optional timestamps.

- The Google Drive / Colab tab is a browser-only UI prototype with a simulated queue, checkpoints, recovery, TXT downloads and idle shutdown.

- The local Diagnostics section under the ML status bar groups hardware acceptance, offline readiness, PCM checks, the per-record event log and JSON reports.

- The recognition list follows FIFO, with completed recordings at the bottom. Removing a queue slot preserves source audio and checkpoints. Speaker-model preload can be requested during processing and runs between jobs.

- Audio rows show model and queue status together. The progress meter displays the active Whisper window, saved timecodes and speaker progress.

## Integration status

- The deployed `main` contains merged PR-13–18 and PR-20; PR-19 was closed as a duplicate.
- PR-21–31 are **stacked PRs**, not yet merged into `main`. The code of each subsequent PR builds on the previous PR branch. Passing each intermediate CI is **not** a pass on final integrated `main`.
- PR-31: compact UI, secondary action menus, visible release SHA, user-facing file-storage errors, and a distributable-package preflight. See `docs/PR31_UI_RELEASE_PREP.md`.
- The public ChatGPT Site `https://iscribe-alexander.politebook7.chatgpt.site/` **has not been updated as part of PR-21–31**. The GitHub Pages manual workflow is a separate deployment target and is not an automatic ChatGPT Sites publisher.

## Automated CI history — mocked ML, not hardware

| PR | Key change | Recorded CI |
| --- | --- | --- |
| PR-21 | Project baseline and documentation | Baseline browser image issue; corrected in PR-22 |
| PR-22 | Privacy-safe per-window ASR trace | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45428607603) |
| PR-23 | Decoded PCM and window validation | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45553718206) |
| PR-24 | ML lifecycle and stuck-Worker recovery | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45554707262) |
| PR-25 | Append-only IndexedDB ASR checkpoints | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45555953603) |
| PR-26 | Offline application shell and WASM cache | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45556821903) |
| PR-27 | Durable FIFO after reload | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45652681765) |
| PR-28 | Conservative speaker alignment | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45654520756) |
| PR-29 | Persistent performance benchmark reports | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45656263805) |
| PR-30 | Hardware evidence and acceptance protocol | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45660740952) |
| PR-31 | Final UI and release-package gate | **PENDING** until exact branch CI completes |

Tests above use synthetic audio and simulated inference. They confirm program logic and browser behavior, **not** true Whisper/GPU performance.

## Not yet verified on the user's device

- Original 14:31 / 33.3 MB MP3 with **real Whisper Small on WebGPU**, all 35 windows, true text quality, and robust recovery.
- Offline recognition using locally cached weights and ONNX/WASM on target hardware.
- Real GPU-device-loss → WASM fallback.
- Speaker quality on the 97-turn/300-segment/123-unlabeled historical sample (no human-labeled reference yet).
- Browser process RAM/VRAM, 30- and 60-minute stability, actual model cold/warm benchmarks.
- Live-site deployment correctness, service-worker update lifecycle, and migration of old IndexedDB v1 data to v2.

All real-hardware gates HW-1–HW-7 are **NOT TESTED**.

## Release sequence

1. Complete PR-31 CI including `npm run release:check`.
2. Integrate PR-21 → PR-22 → ... → PR-31 in order, checking branches and conflicts, without skipping dependencies.
3. Run full CI on `main`: TypeScript, ESLint, Vitest, Vite production build, release-package preflight, normal and offline Chromium acceptance.
4. Verify v1→v2 IndexedDB migration and rollback safety; an old v1-only build cannot access an already upgraded v2 database.
5. Perform real HW-1/HW-2 and remaining hardware scenarios according to `docs/PR30_HARDWARE_ACCEPTANCE.md`.
6. Only with an explicit release decision, publish using the **actual** ChatGPT Sites workflow; verify visible build SHA, HTTPS, cache, TXT and checkpoint behavior on the published URL. This work has not been performed by PR-31.


## Streaming reliability PR-01–07 (2026-11-26)
Stacked PRs #36–41 plus PR-07 cover the 41/154 stall, stage watchdogs, two durable recovery reservations per window (five per job), split fallback, proactive rotation, and isolated inspection. See [streaming acceptance protocol](STREAM_RECOVERY_ACCEPTANCE.md). PR-06 verify: 161/161 tests, [CI](https://github.com/AlmazovAN/iScribe/actions/runs/45803738028). PR-07 CI and real 63:54 MP3 acceptance must be recorded independently. No deployment claimed.

## PERF-01 (candidate)
Optional performance profiler in Benchmark JSON and Diagnostics, preserving v1 jobs and checkpoint semantics. See [PERF-01](performance/PERF-01.md). No hardware acceptance or speedup claimed.

## PERF-02 (candidate; depends on PERF-01)
Three existing buttons now persist preference and control checkpoint-boundary pacing; WASM/prefetch targets are subsequently wired in PERF-04/05. See [PERF-02](performance/PERF-02.md). No hardware speedup or energy savings claimed.

## PERF-03 (candidate)
Opt-in local backend comparison and cached selection for medium/max, retaining bounded WASM recovery. See [PERF-03](performance/PERF-03.md). Real hardware results pending.

## PERF-04 (candidate; depends on PERF-03)
WASM thread configuration wired into ASR Worker; optional isolated loopback preview (`npm run serve:isolated`), standalone remains single-threaded. See [PERF-04](performance/PERF-04.md). Actual parallel inference and speedup not yet verified.

## PERF-05 (candidate; depends on PERF-04)
Bounded streamed-audio lookahead integrated with Resource Manager, no parallel decoder reads or speculative storage writes. See [PERF-05](performance/PERF-05.md). Real hardware speedup pending.

## PERF-06 (candidate; depends on PERF-05)
Direct resampling-buffer mixing, bounded reusable ASR dispatch storage, explicit ASR Worker cleanup and conservative idle release. See [PERF-06](performance/PERF-06.md). Actual RAM savings pending hardware validation.

## PERF-07 (candidate; depends on PERF-06)
Coalesced intermediate trace writes, immediate atomic checkpoints, stable memoized queue rows, throttled noncritical engine progress and lazy closed log rendering. See [PERF-07](performance/PERF-07.md). Real-device savings pending.

## PERF-08 (candidate; depends on corrected PERF-07)
Speaker WASM thread policy, indexed alignment and progress-milestone diagnostics. WASM/q8 retained. See [PERF-08](performance/PERF-08.md). GPU/batching and real-device performance not confirmed.

## PERF-09 (candidate; depends on PERF-08)
Local comparative benchmark imports, run provenance, combined evidence export and T01–T10 protocol. See [PERF-09](performance/PERF-09.md). Actual hardware results NOT TESTED.

## PERF-10 — integrated candidate
PERF-01–08 exact-head CI PASS; PERF-09 original CI failed due to ambiguous file/scenario test selectors, corrected in 2ac6983. Final integration CI and actual hardware gate are independent. See [PERF-10](performance/PERF-10.md) for verified run IDs, remaining limits and local commands. Older integration notes above are historical; the final candidate is based on main dfdd1ebcabdae45e3a3ba3c4e003929e3c832785. Do not equate source integration with publication.

## GPU-08 — Hybrid Execution Pipeline (candidate)
Existing PERF-05 bounded streamed-audio lookahead is scheduled before in-flight attempt metadata persistence, allowing earlier preparation without starting ASR before the durable write. Optional timing fields record scheduling lead; no GPU utilization or actual acceleration claim. See [GPU-08](performance/GPU-08.md). Full CI and real-device acceptance pending.

## GPU-09 — Adaptive Performance Manager (candidate)
A bounded per-run prefetch-depth trial is wired into ResourceManager and successful streamed-audio consumption. It changes neither selected/effective mode nor WASM thread target; it never exceeds profile, memory or recovery ceilings. See [GPU-09](performance/GPU-09.md). Full CI and hardware acceptance pending.

- Local pipeline v7 candidate: manifest-based selection and stage ancestry checks, one candidate per invocation. Windows regression and end-to-end acceptance pending; not a claim of release readiness.


## DIAG-01 — компактная диагностика
Одна постоянно видимая строка: выбор записи, текущий номер окна, единый JSON с событиями и вложенным бенчмарком. Отдельные ручные проверки, аппаратная панель, ручная калибровка и панель кэша удалены. Автоматическая проверка PCM, восстановление, кэш моделей и регистрация service worker сохранены. Схема старых заданий совместима; исторические поля не мигрируют. Аппаратная приёмка и локальный CI: NOT TESTED до выполнения локального конвейера. Сбой второго окна Whisper в standalone/WebGPU не исправлен; нужен повтор с единым журналом и данными текущей попытки. `elapsedSinceAttemptEventMs` — время с события перед dispatch, не чистое время GPU. Сравнение с предыдущей версией и изоляция повторного использования PCM требуются для подтверждения причины.


## DEC-01 experimental candidate

Alternate FFmpeg.wasm full-file decoding is opt-in; legacy remains default, large files still use MediaBunny. See docs/DEC-01_FFMPEG_CORE.md. Local CI and actual browser/hardware acceptance NOT TESTED; no release or deployment.


## DEC-02 experimental candidate

FFmpeg opt-in now covers the windowed route through WORKERFS and exact-length PCM gates. Legacy remains default. See docs/DEC-02_STREAMING_QUALITY.md. Local and hardware acceptance NOT TESTED.


## DEC-03 experimental candidate

Persisted decoder identity, typed FFmpeg diagnostics and bounded automatic recovery. See docs/DEC-03_RECOVERY_DIAGNOSTICS.md. Local tests NOT TESTED.


## DEC-04 release candidate

New jobs default to FFmpeg in the candidate; legacy retained for pinned checkpoints and explicit comparison. Native CLI synthetic reference experiment observed PASS; local CI, real browser FFmpeg and hardware acceptance NOT TESTED. See docs/DEC-04_ACCEPTANCE_RELEASE.md. Public binary distribution pending GPL review.


DEC-04 local iteration 1: dependencies/typecheck/lint/Vitest 234/234 PASS; Playwright 14/16, two valid WAV stream opens FAIL at FFprobe. Candidate patch addresses known core 0.12.10 false -1 and reads validated JSON from a fresh file; new probe diagnostics. Revised candidate NOT TESTED; no main merge.


DEC-04 iteration 2: Vitest 238/238, primary Playwright 16/16, standalone/web builds and web preflight PASS; offline 5/6 (file:// FFmpeg only). Standalone worker transport changed to inline core and cloned compressed Blob; revised candidate pending local CI.


DEC runtime follow-up: main 918d0f1 local CI PASS (239 unit, 22 browser); real full FFmpeg decode exit 1 twice, root cause unknown. New bounded diagnostic categories and real synthetic MP3 browser test; revised candidate NOT TESTED. Strict decode/PCM policies unchanged.


DEC frame recovery candidate: actual full-route failure classified damaged-frame/other twice. One durable timestamp-compensated recovery before any checkpoint, strict default and validation/diagnostic gate; streaming unchanged. Native synthetic damaged MP3 experiment PASS; new browser regression and real recording NOT TESTED. See DEC-06_FRAME_RECOVERY.md.
