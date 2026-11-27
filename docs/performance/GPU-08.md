# GPU-08 — Hybrid Execution Pipeline

## Static audit and change
PERF-05 already provides bounded streamed audio lookahead: one producer, at most two queued PCM windows, one ASR inference, no speculative job writes, and no reads beyond the mandatory decoder rotation. Previously scheduling began inside the ASR watchdog, after the in-flight metadata transaction. Now the same bounded read-only lookahead is scheduled before that transaction; ASR is still dispatched only after successful durable persistence and cancellation check. The previous window must already be committed. No change to PCM, model/dtype/backend, worker transfer, recovery budgets or checkpoint commits. Preparation failure is handled at consumption by existing recovery; lookahead is retired after a decoder failure as before. No speculative metadata writes. Existing queue may drain after a profile change as before.

## Observations
Audio Pipeline report and Diagnostics now include earlyDispatches (count of early scheduling batches followed by successful metadata persistence) and preDispatchLeadMs (cumulative wall interval from scheduling until successful metadata persistence). Older jobs without these observations report null. Mixed resumed jobs report observations accumulated on this build, not historical attempts. These values do not quantify actual simultaneous CPU/GPU compute or speed saved. Existing ready hits and waitMs are complementary. Maximum queue unchanged. No GPU tensor transfer/allocator changes; GPU-03/04/05 experiments are separate, not integrated. Non-streamed jobs are unchanged apart from cancellation check after metadata persistence.

## Acceptance
Run npm ci, typecheck, lint, test, build and browser regression; compare the exact same long audio/model/backend/mode on base and candidate with three repetitions, including 63:54 reproduction and cancellation/storage failure. Compare RTF, waitMs, resource pressure, durable window count, transcripts and recovery; verify early dispatch count and unchanged queue limit. Do not equate elapsed scheduling lead with acceleration. No new concurrency in ASR or speaker stages.

## Verification
Added runner test with blocked metadata write and independent lookahead, and report test for legacy optional fields. Existing tests for FIFO, cancellation, recovery and trace retention remain. Local git ls-remote failed DNS resolution, so npm dependencies and full suite could not be fetched/run in this session. Typecheck, lint, Vitest, build, browser, hardware NOT TESTED. Draft source change only, no merge/deployment.
