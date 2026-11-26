# PERF-01 — Performance Profiler

Observation-only change. Existing buttons are intentionally not wired until PERF-02. No changes to model IDs, generation settings, backend selection, WASM threading, retry policy, window sizes, IndexedDB layout, or standalone build.

## Measurements
The existing benchmark v1 envelope remains compatible; optional performanceProfiler v1 holds bounded counters and device hints. Legacy jobs without observations export null. Counts and durations accumulate across resumed runs; first profiled run captures browser hints. CPU/GPU load, actual RAM/VRAM, effective WASM threads, and Worker transfer duration are not exposed by this instrumentation and remain null. GPU/NN API presence does not establish model support. No adapter identifiers, source names, audio, transcript or arbitrary errors are exported.

Stream open/full audio preparation, decoder/resampler completion callbacks, selected metadata writes, PCM copy, gaps between ASR attempts, recovery and speaker pass durations are recorded separately. These intervals may overlap existing decode/ASR/run totals; never sum them as a breakdown of CPU utilization. Existing ASR and checkpoint metrics are unchanged. Some measurements are wall-clock including logging waits. Gaps are host-observed, not GPU idle. RTF for measured runs is cumulative recorded wall time / measured unique committed audio seconds; retries and speakers count, historical unmeasured work does not. Storage of the diagnostic snapshot is best effort at the next existing transaction; checkpoint atomicity remains unchanged.

## Acceptance
- Unit tests for aggregation, null/unavailable fields, privacy and backend observations.
- Runner test checks persistence, PCM copies, inter-attempt gaps and measured backend.
- Verify same recording/model before and after; use OS Task Manager/DevTools for CPU/GPU and memory measurements. Export Benchmark JSON from Diagnostics even on a failed run.
- Automated and hardware validation: NOT TESTED until actual execution. No measured speedup claimed.
