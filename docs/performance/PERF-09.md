# PERF-09 — Hardware Benchmark (protocol and local comparison tool)

**Real-device results: NOT TESTED.** The GitHub CI only exercises synthetic/structural paths. No hardware evidence is fabricated, and even successful comparison never changes the hardware acceptance verdict. The baseline for this series is main at dfdd1ebcabdae45e3a3ba3c4e003929e3c832785. Compare a separately built candidate with a known SHA; do not overwrite production or clear IndexedDB. Export existing work before changing origin. Use real local production bundles, not the e2e harness.

## Preparation

- Same device, browser/version, power setting, launch origin type, audio bytes, model/language, diarization and cache condition. Keep local source/ground-truth TXT only on device. Document physical CPU/GPU, RAM and power externally; do not publish private paths/audio/transcripts.
- Cold = new model session, weights already cached. Warm = already initialized same model/backend (use manual model preparation; confirm zero model initialization in the actual job). Model release at queue end may make another explicit preparation necessary. Do not mix download time, calibration time or resumed runs into normal speed measurements.
- For each T01–06 execute at least 3 independent cold and 3 warm runs per baseline and each eco/medium/max group. Use a new job for each run, don't simply resume/re-export an existing job. Alternate run order, allow temperatures to return to comparable levels; don't run other heavy workloads. Record failures separately even if no complete JSON can be exported. Large v3 is optional: skip if insufficient memory; do not deliberately exhaust memory.
- Use the same representative speech across all groups for a case; T02 may use 14:31 reference. Duration matching windows in the comparison tool are tolerances, not proof of identical files. On each pass export hardware JSON and Benchmark JSON (baseline requires both with original matching filenames; candidate hardware JSON embeds Benchmark). Export in the build that executed the fresh job; older baseline does not attest run SHA.
- For backend comparison, use existing opt-in PERF-03 calibration on a separate trial, inspect timings/status, then run fresh normal jobs with observed backend. Explicit WASM prep and available automatic/cached provider are existing controls; no forced GPU support or quality claim. Record all provider attempts/fallbacks. Compare standalone vs isolated web separately, never combine. For isolated WASM tests use modes and available thread targets, record Worker-confirmed value, actual thread pool unknown. For 1/2/4/6/8 compare only available configurations, not forced unsupported hardware.

## Matrix

| ID | Recording / configuration | Acceptance / evidence |
| --- | --- | --- |
| T01 | Tiny, ~15 min, no speakers | Fresh jobs, full checkpoints and local TXT; timing comparison |
| T02 | Small, ~15 min (14:31 permitted), no speakers | Same source, full checkpoint, text accuracy |
| T03 | Small, ~30 min, no speakers | RAM/VRAM peak, full checkpoint, no uncontrolled growth |
| T04 | Small, ~60 min (63:54 permitted), no speakers; include streamed >128 MiB source | Checkpoint count, recovery, prefetch, external memory |
| T05 | Large v3, ~15 min, optional | Only if resources sufficient, otherwise BLOCKED |
| T06 | Small, ~15 min, speakers | ASR remains exportable, speaker result complete, compare DER/unknown coverage |
| T07 | Small, change eco→medium→max after committed windows | Requested/effective counts and no missing/duplicate text; mode changes at safe boundaries |
| T08 | Small, reload after 2 committed windows and resume | Confirm persisted prefix, resume at 3, identical ordered output; no synthetic GPU-loss claim |
| T09 | Five independent files in queue, maximum | Measure peak and idle RAM, all checkpoints complete, no accumulation beyond expected caches |
| T10 | Cached models, offline restart, new job | Local full TXT, no network dependency; observe real network not navigator.onLine alone |

T07–T10 are reliability/manual scenarios, not normal-speed comparison groups. Use existing hardware and diagnostic reports; fill manual CSV. For actual natural GPU/decoder failure, record stage and bounded recovery; do not deliberately crash hardware, and leave NOT TESTED if failure was not observed.

## Measurements and decision

For each run record overall wall time, ASR RTF, end-to-end RTF (wall/audio), per-window P50/P95, model initialization, gaps between attempts, retry counts, decoder recoveries, peak RAM/VRAM (external task manager or equivalent; state scope and sample interval), CPU/GPU average sampled, and temperature/power condition. RTF <1 is faster than real time. JS heap, browser memory hint and configured threads are not process RAM or actual GPU use. Recent P95 is from up to 150 windows, not full distribution on longer jobs. Record per-stage times but don't sum overlapping timings.

WER = (substitutions + deletions + insertions) / reference words × 100; use identical local reference and normalization across builds. DER = missed speech + false alarm + speaker confusion / reference speaker time × 100, with same scoring convention (speaker label mapping, collar/overlap policy). No automated WER/DER without verified reference; unknown leave blank. Check timecodes, silence, duplication, output completeness independently. No speed gain is sufficient if accuracy or durability regresses. Track success/failure of all trials; medians of eligible completed runs do not describe failed runs. Compare median reduction (baseline minus candidate)/baseline; no invented targets before baseline. Report cold and warm separately, medians and range/P95 of window durations; external metrics must specify how many observations are present.

## Tool

Diagnostics → Hardware Acceptance → PERF-09. Select T01–06, group, cold/warm, launch type. Add original hardware JSON, and matching benchmark JSON if baseline legacy. Enter external numeric measurements optionally. Original eight-character job suffix prevents repeated import in current session; it is not included in comparison export. Candidate must have matching first-run build, stable requested profile, zero starting checkpoint, no calibration and correct resident model condition. Baseline legacy relies on operator verification; same SHA/launch/source metadata is required within a group. Mixed build/workload and fewer than 3 valid runs per group suppress speedup. Operator confirms same environment/source. Invalid runs are retained with reasons, not silently deleted. UI stores comparison in tab memory; export comparison JSON before closing; original run reports can be imported again. Max 120 reports, 4 MB JSON each. No database migration or network access. No automatic hardware PASS, no fabricated results.

CI covers parsing, privacy, comparison gates and actual application-path mock evidence; real trials and signed operator review remain NOT TESTED. PERF-10 release must distinguish automated and hardware readiness.
