# PIPE-06 — Resource Lifecycle

Status: implementation prepared. Exact resourceLifecycle.ts blob 54b8245c340819de68634ee0d6c1bf07fc35631c compiled with tsc 5.8.3 strict/ES2022/DOM using minimal dependency type/error shims. Node 22.16.0 tests 5/5 PASS. Full project TypeScript, Vitest, IndexedDB, Playwright, build and actual hardware NOT TESTED; npm ping returned EAI_AGAIN in this session. No GitHub Actions dispatch, main merge or deployment. Stacked on PIPE-05 #82.

## Design

Existing ResourceManager continues to select requested/effective profiles, WASM threads, pauses and prefetch depth. New resourceLifecycle.ts contains a small ready-model retention policy, cancellable idle lease and guarded Worker retirement, not a second scheduler or allocator.

| Boundary | Ownership and cleanup |
| --- | --- |
| Before next job decode | Release incompatible active Whisper, previously completed-ASR job's unused model, eco model or Large v3. Compatible Tiny/Small may remain ready in medium/max. |
| ASR | Existing one authoritative PCM window and one reusable private dispatch buffer, bounded read-only prefetch of up to two windows. Failed/detached buffers are not reused. Existing finally clears payload pool and drains prefetch. |
| ASR to speaker | Existing ModelManager disposes ASR before creating speaker Worker. Independent speaker pass owns its Worker and terminates it on every exit. |
| Full FFmpeg | Terminate owned Worker before PCM validation; release temporary object URL even if termination throws. |
| Stream FFmpeg | Clear callbacks, abort listener and pending request; terminate Worker and revoke URL even on thrown termination error. Explicit close preserves a failure and rethrows it; asynchronous error/abort handler rejects pending operation. |
| Completed queue | Keep existing immediate release policy (eco, Large v3, unknown/small device memory). Otherwise bound ready-model lease to 120 seconds of scheduled idle time. Explicit preparation also receives an idle lease. New processing or preparation cancels lease. |
| Failure/cancellation | Preserve existing committed text/RAW, drop temporary references through existing cleanup, release idle model. Ordinary job errors may continue FIFO. Unconfirmed Worker retirement blocks further heavy work in this page session. |

120-second lease is a provisional design decision, not a measured optimal value. Browser timer throttling may delay expiry. No active model is released by timer while runner is busy. Cache API model files are never deleted by these changes; model initialization may still be required after release. No model quality downgrade.

## Retirement failure isolation

ModelManager uses a per-manager WeakSet to avoid issuing duplicate termination calls through its owner and a sticky failure latch. Termination throws become WorkerDisposalError; even a later successful terminate does not clear the latch. Explicit cancellation does not throw into UI; state is reset in finally, and error phase reflects blocked retirement. No replacement model Worker is allocated once the latch is set. This guard covers ASR and speaker workers. EngineClient may itself issue termination; API termination requests are idempotent and owner-level dedup does not guarantee a single underlying call.

JobRunner blocks further queue processing/manual preparation/speaker preload if the model latch is set, a typed disposal failure is observed, or stream close fails. Ordinary recoverable failures retain PIPE-05 budgets. Check model latch before reserving another ASR/speaker retry. Pending queued jobs and their durable order remain; new page session is required for subsequent processing, not an automatic restart. Terminal stream cleanup logs failure without erasing a successfully committed result. Late asynchronous stream opening and lower-level cleanup paths that suppress failures remain limitations. The standalone retirement guard cannot prove GPU driver cleanup, immediate OS memory return or process exit.

## Memory and performance scope

Preserve existing bounded prefetch, exact-sized ASR pool, rotation and durable PCM/RAW policy. No changes to IndexedDB v3, retry limits, audio processing or models. Full PCM may remain resident through speaker pass and final export; cached PCM consumes disk quota. Already prepared compatible model can coexist with full decoder; no actual native RAM/VRAM cap or real GPU allocator control is claimed. Browser memory hints and owner termination are not direct VRAM measurements. No forced garbage collection. Deferred idle release does not update a previously persisted job benchmark; immediate releases still increment existing counters. Real cost of cold initialization, hash/PCM writes and model retention requires target-device measurement.

## Verification and release

- Exact helper source hash verified against Git blob; strict standalone tsc and 5/5 Node tests passed: release policy, lease expiration, cancellation/replacement, deduplicated retirement, sticky failure latch. Minimal dependencies substituted; not a full project build.
- Added five corresponding Vitest tests, one ModelManager regression and two JobRunner integration tests (release before decode, queue isolation). Existing resource, stream/prefetch, worker, checkpoint, cancellation, and recovery tests remain required; none of those project tests were executed in this session.
- Required local CI (npm ci, typecheck, lint, Vitest, Playwright, build/package) and real target device: 10 consecutive files; same/different model, eco/max and Large v3; idle timeout and start immediately before expiry; abort/timeout/failure at every allocation boundary; stream rotation and pending prefetch; injected Worker termination failure preserves next queued job; confirm model cache retained; measure peak and post-job RAM/VRAM over repeated runs with comparable backend/settings. Use independent OS/GPU monitoring, not JS heap alone.
- PIPE-04 migration and PIPE-05 recovery risks remain. #76/#78 acceptance outstanding and overlapping decoder/JobRunner changes need reconciliation before final manifest. Do not merge this stacked PR directly to main.
