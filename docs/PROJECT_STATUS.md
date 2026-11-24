# iScribe project status — 2026-11-24

## Verified from GitHub

- PR-13, PR-14, PR-15, PR-16, PR-17, PR-18 and PR-20 were merged into `main`.
- PR-19 was closed without merging as a duplicate.
- Existing source includes committed ASR windows, bounded retries, watchdog, separate speaker pass and independent text export.
- The current default ASR watchdog threshold is five minutes of visible-tab inactivity.

## Not verified

- Production deployment corresponds to the latest `main`.
- Actual Whisper Small/WebGPU inference on the user's 14:31 / 33.3 MB MP3.
- Offline startup after full cache population.
- Speaker accuracy on the original 97-turn / 300-segment recording (123 unlabeled).
- Runtime memory peaks and GPU fallback on real hardware.
- Current CI and real-device test outcomes for this documentation-only PR.

## Next stages

PR-22: implementation on stacked PR-22; structured per-window traces, privacy-safe JSON export, and CI runner fix. Real hardware NOT TESTED. PR-23: window and decode validation. PR-24: ML lifecycle. PR-25: memory/storage. PR-26: offline readiness. PR-27: queue recovery. PR-28: diarization. PR-29: benchmarking. PR-30: hardware acceptance. PR-31: UI refinement.
