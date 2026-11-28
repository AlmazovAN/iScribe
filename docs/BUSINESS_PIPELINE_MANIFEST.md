# Business Pipeline — PIPE-00 Architecture Audit & Manifest

Дата: 2026-11-28. База: main c60d3f028246cfef9de115becd2ff1380d527356.
Статус: статический аудит исходников и документации; исполнение тестов и аппаратная приёмка NOT TESTED. Этот PR изменяет только документацию. Источник принципов: предоставленный владельцем WhisperX Colab V3.1 (без копирования частных файлов в репозиторий).

## Обязательные архитектурные решения
- Локальная обработка, React/TypeScript/Vite, монолит dist/iScribe.html; модели кэшируются отдельно. Никакой CUDA, Python или облачного ASR в пользовательском runtime.
- FFmpeg.wasm — самостоятельный декодер. Whisper принимает только проверенные PCM Float32 16 kHz mono. Не передавать MP3 в модель; не скрывать смену декодера. Legacy оставить только для совместимости исторических checkpoints и контролируемого A/B.
- JobRunner остаётся единственным диспетчером. Не создавать параллельный конкурирующий оркестратор, очередь, IndexedDB или ResourceManager.
- Одна тяжёлая модель за раз; использовать существующие Worker lifecycle, bounded prefetch, PERF и recovery; не менять dtype/model/provider без проверки.
- Все stages имеют идентификаторы входа, версию алгоритма/модели/конфигурации, RAW (если применимо), проверенный результат и durable commit. RAW сохраняется до валидации; ошибка валидации не запускает повторный inference. Зависимые результаты инвалидируются по fingerprint, без уничтожения старых результатов. Целевая схема версий требует отдельного проекта миграции.
- Глобальная временная шкала — исходные отсчёты 16 kHz; сегменты с абсолютными границами; VAD не сжимает время. Не скрывать неизвестные спикеры или пропуски.
- Политика целевого Retry: максимум две попытки на вычислительную операцию (initial + retry), плюс общий долговечный бюджет задания; не сбрасывать резервирования на reload. До PIPE-05 действующие лимиты не изменять. Storage/validation/permanent errors не повод повторять inference. Watchdog — защитный таймаут, не доказательство deadlock.
- TXT plain/time остаются доступными при отказе диаризации; частичный результат маркировать; экспорт не подтверждает скачивание. Очередь продолжает обработку независимых заданий. Не обещать фоновых вычислений после закрытия вкладки.
- Никаких аудио, транскриптов, имён записей, токенов или raw stderr в GitHub/CI diagnostics. Браузерное хранилище ограничено origin/quota/eviction; не обещать абсолютную сохранность; контролируемое восстановление и экспорт обязательны.

## Инвентаризация AS-IS
| Область | Проверенные источники main | Состояние / действие |
| --- | --- | --- |
| UI / оркестратор | src/App.tsx, src/jobRunner.ts, src/jobs.ts | JobRunner уже координирует очередь, decode, ASR, speaker, экспорт. Выделять этапы внутри, не переписывать всё. |
| Decoder | src/audioDecoderProvider.ts, src/ffmpegWorker.js, src/ffmpegStreamWorker.js | FFmpeg default, legacy explicit; full/windowed routes, WORKERFS, strict -xerror, pcm_f32le, 16k mono. Windowed CLI — не continuous libav. |
| PCM | src/audioValidation.ts, src/jobRunner.ts | Проверяются finite samples, длина, fixed window plan; расширить identity, duration drift, integrity и обработку discontinuity без автоматического отбрасывания тихой речи. |
| Windows | src/jobs.ts audioWindows, absoluteSegments | 30 s, шаг 25 s. Stable absolute offsets, overlap ownership. Preserve old checkpoint semantics; VAD план — отдельная версия. |
| ASR | src/ml/manager.ts, src/jobRunner.ts | Float32Array, language ru/en, engine transcribe. Tiny/Small/Large v3; backend from init, bounded fallback. |
| Persistence | src/jobStore.ts, src/jobs.ts, docs/RELIABILITY_RELEASE.md | IndexedDB v2: jobs/audio + ASR append-only chunks + speaker result; durable nextWindow and text in one transaction. Full PCM decode again on resume; independent raw/checkpoints for VAD/alignment not identified. No full-source hash field in inspected Job type. |
| Recovery | src/ml/recoveryPolicy.ts, src/ml/activityWatchdog.ts, src/jobRunner.ts | ASR 3 total attempts, stream 2 recovery reservations/window and 5/job, 5 s split, rotation 20 windows, full decoder one retry. Preserve these until PIPE-05. |
| Resource management | src/performance/resourceManager.ts (import), audioPipeline, memoryPolicy, src/ml/manager.ts | Existing resource/prefetch/worker mechanisms wired in JobRunner. Single-thread standalone WASM; isolated preview optional. No claim of measured speedup. |
| VAD | src/colabDemo.ts, src/jobs.ts, src/jobRunner.ts | Demo stage label is not production VAD. Independent speech detection stage not identified in audited path. |
| Alignment | src/ml/speakers.ts (import), src/jobs.ts | Speaker assignment and absolute ASR timestamps are not acoustic forced alignment. Dedicated word alignment stage not identified. |
| Speakers | src/ml/manager.ts, src/ml/speakers.ts, README.md | Separate Pyannote+WeSpeaker WASM/q8 pass; long-stream speaker support absent per README; keep plain ASR when speaker fails. |
| Queue/diagnostic/export | src/jobRunner.ts, src/jobTrace.ts (import), src/formatTranscript.ts (import), docs/RELIABILITY_RELEASE.md | FIFO, Web Locks where supported, cancellation, redacted trace, three TXT variants. Build on current mechanisms. |
| Dependencies | package.json, AGENTS.md | @ffmpeg/core 0.12.10, engine 0.1.1, Transformers 4.3.1, ORT Web 1.31.0-dev.20260914-8d85527a0; guarded engine patch and lockfile. |
| Local CI | AGENTS.md, docs/LOCAL_PIPELINE.md, .github/workflows/ci.yml, pages.yml | v7 release manifest; both workflows manual-only. No dispatch. |

Scope is selected source paths and project docs, not exhaustive dependency/engine source or real-device execution. Historical status prose may lag main; prefer pinned source and actual PR state.

## Open PR review and dependencies
- #76 DEC-FRAME-001 is open against audited main. Full-route damaged-frame recovery without -xerror, bounded conditions; streamed route unchanged. Native synthetic experiment reported by PR; real browser and reference recording NOT TESTED. PIPE-01 first requires independent local acceptance/rejection of #76, then rebase/rebuild candidate onto resulting main; no duplicate implementation or automatic integration of #76 into this plan. Do not mix strict/lenient PCM identities in existing checkpoints.
- Open historical PERF #49–56 are separate stacked candidates. Existing PERF components are wired into main; do not auto-merge/close these PRs or assert all historical commits are ancestors without a separate ancestry review.
- Existing docs/PROJECT_STATUS.md and docs/performance/PERF-10.md include historical pending statuses; this audit pins actual source. No changes to those documents for this docs-only PR.

## TO-BE contracts (design, not implementation)
Input/preflight -> Decode -> PCM gate -> VAD -> Speech plan -> ASR -> Forced Alignment -> Diarization -> Speaker Assignment -> Final Gate -> Export. Diarization consumes PCM and produces independent speaker intervals; assignment consumes alignment + intervals. Optional stages explicitly skipped/partial; plain ASR not blocked. Orchestrator controls persisted state and cancellation. Chunk PCM on storage budget; do not require whole recording in RAM. Consider IndexedDB first (compatibility), OPFS only after file:// and quota feasibility; atomic publication via durable metadata referencing completed verified chunks. Stage result keys include job ID, source identity, stage/version, config and input fingerprint; retries and commit idempotent. Explicit migration and rollback tests before DB upgrade. No hidden recomputation of valid stages.

## Roadmap / stage gates
| Stage | Change | Gate |
| --- | --- | --- |
| PIPE-00 | Static audit, architecture manifest | Review pinned evidence and roadmap |
| PIPE-01 | Stabilize direct FFmpeg; #76 dependency; A strict f32, B default ffmpeg f32, C s16->f32 comparison, full and windowed | Same reference files/settings; report sample count, duration, discontinuity, errors, PCM, text and runtime. No silent fallback or truncation. |
| PIPE-02 | Expand existing PCM quality gate | Invalid PCM blocked; legitimate silence allowed; absolute timing intact |
| PIPE-03 | Extract stage contracts from JobRunner incrementally | Existing queue/cancel/export tests pass; no second orchestrator |
| PIPE-04 | Durable RAW + stage checkpoints, chunked PCM, SHA-256, migration | Interrupted commits/reload/quota/old jobs; no lost or duplicate committed windows |
| PIPE-05 | Unified recovery policy | Fault injection, bounded persisted retry, no invalid RAW recompute |
| PIPE-06 | Resource lifecycle | Bounded buffers, cancel/cleanup, reuse current PERF; actual memory measured externally |
| PIPE-07 | VAD feasibility (Silero ONNX candidate), speech intervals | RU/EN quiet speech and silence comparison; safe baseline fallback explicitly recorded |
| PIPE-08 | Speech segmentation | Absolute offsets, max length, boundary ownership, no missing/duplicate speech |
| PIPE-09 | ASR quality | Paired WER and hallucination analysis; supported options only; batching feasibility separate |
| PIPE-10 | Forced Alignment feasibility (Wav2Vec2 ONNX candidate) | Real model initialization, RU/EN timestamp error, unmatched words explicit, plain ASR retained |
| PIPE-11 | Long-audio speaker diarization and assignment | Global speaker identity, overlap/unknown labels, DER vs baseline |
| PIPE-12 | Queue reliability | Multiple jobs, pause/resume, failure isolation, cross-tab ownership |
| PIPE-13 | Final gate/export | Validated complete/partial artifacts, repeat export without inference |
| PIPE-14 | Observability | Redacted per-stage/segment metrics, truthful backend and failure attribution |
| PIPE-15 | Integrated release | Local gates and real-device acceptance, docs, exact tested SHA |

## Test and release protocol
Follow AGENTS.md and docs/LOCAL_PIPELINE.md. One plan, one codex/business-pipeline-release-candidate branch; one focused stage PR, stage history retained. Final non-draft same-repo PR to main includes exact single-line manifest with actual base/head/stage SHAs; regenerate on change. Reconcile #76 before PIPE-01; do not accept stale main. Local BAT runs npm ci, typecheck, lint, Vitest, Playwright, build and package gates per stable script. No Actions dispatch, no publishing, no weakening tests. Documentation-only PIPE-00 is not hardware acceptance. Real-device gates NOT TESTED; use 12:18, 35:38, 63:54/146.5 MB references including stalls at 2/41, damaged frame case, silence, multiple speakers, reload, failure, queue and memory trials. Record exact SHA, config, RTF, WER/DER where annotated, time errors, actual RAM/VRAM externally, recovery counters. No claim of guaranteed success beyond tested conditions. Never upload real audio or transcript.
