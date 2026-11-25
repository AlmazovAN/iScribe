# PR-22 — Structured ASR diagnostic trace

## Purpose

Capture the stage, precise ASR window, attempts, backend and checkpoint evidence behind an interrupted transcription. Do not infer an actual crash from a missing callback, and do not equate `pagehide` with a user-initiated reload.

## UI

After a job has diagnostic events or an earlier failure, its row includes **Диагностика JSON**. The action downloads `iscribe_diagnostics_<short-random-job-id>.json`. It does not require successful ASR, and never uploads diagnostic data.

## JSON schema

`iscribe.diagnostics.v1` contains a metadata summary and the most recent 256 structured events with timestamp (epoch ms), phase, action code, elapsed duration, sanitized backend, window index, window start/end in 16 kHz samples, attempt, segment counts and committed checkpoints.

Instrumented stages: job start/end, audio decoding, model initialization, each ASR window and retry, checkpoint writes, speaker pass and failure. An ASR window start and each attempt is saved before calling the Worker; completed windows are still advanced **only** by the existing atomic checkpoint transaction.

## Privacy and capacity

The exported report **does not include** the original filename, audio, raw PCM, transcript, raw error message, stack traces, storage paths, URLs or browser/device fingerprint. Exception classifications use a small allowlist; unidentified errors are marked `other`. Preserve that privacy contract in later PRs.

Events are stored as an optional bounded array in the existing IndexedDB `Job` record, without bumping the database schema. Older saved jobs without events remain readable. The oldest events are discarded after 256 entries. Trace storage adds IndexedDB writes before each ASR attempt; monitor overhead for long recordings in PR-25.

A browser crash can leave the last persisted `window-attempt` record, but cannot confirm that the Worker started or completed inference. The saved `nextWindow` remains the sole authority for completed work.

## Verification

- Vitest: bounded events, error sanitization, report redaction, persisted in-flight window, checkpoint sequence, download UI.
- GitHub Actions: TypeScript, ESLint, Vitest, production build and Playwright acceptance.
- Real Whisper Small/WebGPU with 14:31 MP3: **NOT TESTED** in this PR; user hardware verification still required.

The Playwright job is pinned to Ubuntu 24.04 because the previously selected `ubuntu-latest` resolved to Ubuntu 26.04, which is not supported by the pinned Playwright 1.56.1 Chromium browser installation.

## Manual reproduction

1. Open iScribe in Chrome or Edge with developer tools available.
2. Download and select Whisper Small. Disable diarization for the first pass.
3. Add the original 14:31 / 33.3 MB MP3 and start ASR.
4. If interrupted, press **Диагностика JSON** in that job row.
5. Inspect the last events: window number, sample boundaries, attempt, last checkpoint and sanitized error kind.
6. Reopen the page and export a second report after recovery.
7. Compare the checkpoint and trace without publishing the user's audio or transcript.

Capture browser version, RAM and GPU manually for the private test record; these identifiers are intentionally excluded from automatic diagnostics.
