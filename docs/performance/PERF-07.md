# PERF-07 — Storage & UI Optimization

Preserve v2 append-only ASR chunks, atomic text+nextWindow writes, existing migration, queue durability and recovery reservations. No database version/schema changes.

For normal sequential streamed reads, persist read start, resample start, PCM check start and periodic sample observations (at least 15 seconds since last trace write). Completion events and intervening sample observations remain in the bounded existing trace and flush at the next mandatory persistence. Explicit standalone inspection keeps its old write behavior. The separate checkpoint-start write is folded into the atomic checkpoint transaction; on unexpected tab loss before commit, the prior durable in-flight attempt remains available, but completion markers not yet flushed may be absent. Error handling continues to persist failure details and waits for pending writes. No change to retry budget or trace size limit. No coalescing of commits or recovery reservations.

UI: React.memo for queue rows with stable id-based handlers using current runner snapshot, memoized window plans and transcript-derived values, skip identical runner snapshots, limit non-ASR engine progress within a stage to one publication per 250 ms, preserve watchdog heartbeats and immediate lifecycle/checkpoint/terminal/error updates. Progress drops are counted without triggering rendering. Closed diagnostic log no longer constructs its potentially 4096 event rows; opens with full current trace. Existing JSON exports remain available. No visual redesign.

Benchmark adds deferred metadata write and suppressed progress callback counts; no fabricated React render counts or measured savings. Full-transcript immutable array append and the existing IndexedDB incremental layout are retained; changing to an in-memory chunked transcript would be a broader refactor and is deferred. External CPU/RAM and storage latency tests in PERF-09.

Tests added for coalescing decisions, progress gate and real fake-indexeddb runner checkpoints/trace. Existing queue, storage failure, migration and recovery regression tests must pass. Full CI and hardware status NOT TESTED until actual results.
