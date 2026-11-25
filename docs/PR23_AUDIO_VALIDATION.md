# PR-23 — Audio decoding and ASR-window integrity

## Scope

PR-23 introduces a dedicated audio preflight which **does not initialize Whisper, call ONNX or run diarization**. It validates the decoded 16 kHz mono Float32 PCM samples and confirms the existing 30-second windows with a 25-second step. Ordinary transcription runs this PCM preflight **before** model preparation and before writing the next ASR checkpoint.

### User interface

Each idle file row includes **Проверить аудио**. The result stays with the job in the existing IndexedDB store and is also present in its privacy-safe **Диагностика JSON** download.

A successful report displays: PCM sample count, audio duration, expected window count, quiet window count, windows with peaks near full scale, and maximum absolute PCM amplitude. Quiet or loud windows are **warnings only**; they are never silently skipped or declared errors.

A failed check displays the precise window and original PCM sample index when non-finite values are found. The job's ASR state, committed text, and `nextWindow` remain unchanged by a standalone check.

### Integrity rules

- A valid decoded audio result must have positive finite duration, at least one audio channel, positive integer sample count and positive sample rate.
- PCM must consist of finite values. NaN/Infinity are rejected **before ASR**.
- Window boundaries must be integer sample positions, use 480,000-sample maximum window length at 16 kHz, advance 400,000 samples per window, and end exactly at the last PCM sample.
- Empty and over-one-hour decoded PCM is rejected.
- Model timestamps must be finite, nonnegative and ordered. Segments exceeding a window duration by more than one second are treated as invalid, not recorded as a successful checkpoint.
- The traditional midpoint ownership rule for the five-second overlap remains unchanged: do not duplicate confirmed segments across windows.
- No automatic skip of malformed or quiet windows; failures retain earlier committed segments.

### Limits and caveats

This preflight checks **decoded PCM**, not compressed MP3 frame CRC or binary file integrity. Some browsers may decode a partially damaged MP3 successfully while concealing corrupted frames, so a PASS does **not** prove that the original compressed audio contains no frame damage or that recognition will succeed. Real MP3 and actual Whisper/ONNX tests are still required.

Current implementation still decodes an entire recording in the browser; this PR does not add streaming MP3 decoding or reduce full-recording RAM consumption. PCM scanning yields between batches of windows to avoid a single unbroken CPU loop. The existing one-hour / 128 MB limits remain.

The standalone check serializes with normal processing through the existing Web Lock; canceling its check aborts the scan. Older IndexedDB job data remains readable without schema migration. Sanitized report metadata contains no audio or transcript text.

## Acceptance

Automated tests cover:
- 871 s = **35** windows with exact start/end sample boundaries.
- A single short window and the 30-second + 1-sample boundary.
- Corrupted or impossible window sequences, invalid sample count.
- NaN and Infinity with exact offending window and sample index.
- Quiet and clipped windows as informational conditions.
- Aborted audio check.
- Malformed ASR timestamps.
- Browser decode failure and invalid AudioBuffer shape.
- Standalone check without model initialization; no loss of saved ASR checkpoints.
- Failed preflight blocking ASR and preserving existing committed text.
- UI report and duration guard.

CI: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, Playwright browser acceptance.

**Real-world gates NOT TESTED:** user recording 14:31 / 33.3 MB, real Whisper Small/WebGPU, actual audio codec damage and long-file memory behavior. Never mark these PASS based on mocked tests alone.
