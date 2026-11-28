# PIPE-03 — Pipeline Orchestrator

Status: implementation prepared. Exact standalone orchestrator source (Git blob 08956a1ed86474ec54d3a5820465ee23e809dd02) compiled with TypeScript 5.8.3 strict/ES2022/DOM; seven equivalent Node 22.16.0 assertions PASS. Full project TypeScript 5.9.2, Vitest, Playwright, build and real-device gates NOT TESTED. git ls-remote and npm ping failed due DNS (github.com unresolved; npm EAI_AGAIN). No GitHub Actions dispatch. No source merge or deployment. Stacked on PIPE-02 #79.

## Architecture and scope

JobRunner remains the single owner of persistent FIFO, Web Locks, cancellation, ModelManager, ResourceManager, Worker disposal, retries, prefetch and JobStore transactions. Introduce a typed, run-local PipelineOrchestrator that controls the order of the already implemented operations; no second queue, model session, storage or retry mechanism. ASR loop, durable commits and speaker processing are extracted into separate typed methods; no ASR algorithm or decoder change.

| Stage | Actual input | Actual output / completion meaning |
| --- | --- | --- |
| preflight | restored Job / source ID | File from JobStore, frozen decoder identity persisted |
| decode | File, existing decoder selection | Float32Array or opened StreamedAudio handle; stream opening is NOT full-file decode |
| pcm-gate | decoded PCM or stream handle | full PCM validated, or deferred per-window validation; current sample count and timeline guard |
| segmentation | sample count, route, saved nextWindow | fixed 30 s windows / 25 s step and CheckpointProgress; this is not VAD |
| asr | decoded audio, immutable run params, SpeechPlan | all new ASR windows committed and asrComplete persisted; previous windows are not recomputed |
| diarization | full PCM, committed ASR state | speaker turns from existing independent speaker pass |
| speaker-assignment | existing committed segments and speaker turns | speaker labels/statistics in current job, not acoustic forced alignment |
| finalize | current job outputs | terminal JobStore transaction, FIFO slot cleared |
| export | durable job result | browser download requested, or manual fallback; not proof of disk download |

Future VAD (PIPE-07), speech-aware segmentation (PIPE-08), forced alignment (PIPE-10), expanded final quality validation (PIPE-13) are not implemented or falsely reported as completed. Stage order will be extended in their own PRs. PCM checks for streaming still occur inside the ASR loop before each inference; speculative prefetch remains read-only. Independent explicit manual model preloads/export/diagnostics stay outside the job pipeline.

## State and dependency semantics

PipelineOrchestrator.run enforces expected stage, prevents duplicate/concurrent work, stops subsequent stages after a failure, and emits running/completed/failed/cancelled events. It does not retry, cancel a Worker on its own, or hold artifact copies. The existing AbortSignal and caller cleanup own cancellation; an operation that returns a stream handle transfers ownership to JobRunner. A streaming gate emits deferred (per-window-validation) rather than completed. Existing full PCM gate remains mandatory even when ASR is reused.

A job with persisted asrComplete skips segmentation and marks ASR reused; no new model inference occurs in that path. Diarization and assignment are skipped explicitly if disabled or unavailable for streamed audio. Dependent skip reasons must match; running ASR without a segmentation input or assignment without turns is rejected. Skips are only invoked by existing trusted JobRunner conditions; the run-local controller is not a storage validator.

The export stage records requested or manual (caught export failure), never claims file saved. An ASR or speaker failure does not alter the previous durable checkpoint; existing drain error handling preserves plain TXT and proceeds to next job. ASR nextWindow+text commit remains atomic, asrComplete is committed before speaker pass. Finalization persists terminal job before requesting export. Existing queue, Web Locks, resume, cancellation, benchmark, model settings, DB v2 layout and retry budgets are preserved; no new dependency.

## Observability and persistence

Append pipeline-stage to existing bounded trace with pipelineStage, pipelineState, pipelineReason, elapsedMs and sanitized failure classification. Existing event codes are retained; job-complete is still emitted before the final persist, not necessarily last because export evidence follows it. No extra storage transaction per stage. Stage transitions are observed in memory and enter the trace only through existing transaction boundaries. An abrupt exit can lose uncommitted stage events; on reload existing JobStore checkpoint and asrComplete remain the authoritative source. Do not recover computation from trace or treat completed stage observation as independent durable artifact. Durable per-stage artifacts, version/fingerprint, RAW/validated results and migration are PIPE-04; unified recovery remains PIPE-05. No raw audio, file names or transcript in new events.

## Verification

- Exact controller Git blob compiled independently with tsc 5.8.3; standalone Node 22.16.0 smoke: 7/7 PASS (full sequence and requested export, streaming deferred/manual export, committed ASR reuse, failure/no implicit retry, cancellation, concurrency/order/duplicate rejection, inconsistent skip and missing input).
- Added seven Vitest controller cases. Extended existing JobRunner tests for full sequence, failure before ASR, speaker failure, speaker retry without repeated ASR, stream gate deferred. Existing per-window, persistence, prefetch, cancellation, queue and privacy checks remain mandatory. Vitest integration is authored, NOT TESTED here.
- Local full CI and actual hardware remain mandatory; use same known short and long inputs and validate preserved checkpoint/recovery behavior. No claim of performance or accuracy improvement.

## Release dependency

Do not merge the stacked stage PR directly to main. #76 decoder recovery and #78 acceptance remain outstanding. Reconcile overlapping JobRunner/trace edits with the resulting accepted main, retain stage heads and history, rerun exact candidate tests, and generate the final manifest only when ready under docs/LOCAL_PIPELINE.md. This PR is not standalone final-release eligible. Next PIPE-04 will use these stage IDs/contracts as a basis for durable artifacts, but this controller is not itself a checkpoint manager.
