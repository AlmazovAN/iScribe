# PR-24 — ML Worker and ONNX session lifecycle

## Scope

This stage stabilizes asynchronous model preparation and speaker processing without changing Whisper model IDs, ONNX versions, the source audio, existing IndexedDB schema or ASR window checkpoint behavior.

### Lifecycle status

`ModelManager.lifecycle` reports `phase`, selected `model`, active `backend` and session `generation`. Phases include idle, initializing, ready, transcribing, recovering, preloading-speakers, diarizing, cancelled and error.

The bottom status bar now reflects the **current** lifecycle phase and backend. After the Worker is disposed, the active backend is displayed as uninitialized instead of showing a stale WebGPU/ONNX session.

### Bounded inactivity guard

- Existing **ASR 30-second window** guard remains five minutes of active foreground-tab inactivity.
- New **model initialization** and **speaker preload/diarization** guards use 15 minutes of active foreground-tab inactivity by default.
- Model download progress, model HTTP-request events and speaker progress reset their corresponding idle counters. Hidden-tab time does not count, matching the ASR guard.
- Expired initialization disposes the Worker and releases the initialization lock. Expired speaker processing terminates its Worker and rejects the pending promise. No automatic endless restart is attempted.
- A slow operation that emits no progress for the threshold may still be considered stalled, so these checks are defensive limits, **not proof** of an underlying deadlock.
- The watchdog cannot survive browser tab termination or OS sleep, and does not measure GPU memory.

### Recovery after WebGPU loss

The ASR runner now stores the backend **before** starting the current attempt. If its watchdog disposes the Worker, the runner still knows whether that failed attempt used WebGPU/WebNN and can require a *real WASM* session. The previous behavior could clear the displayed backend to `Не инициализировано` before recovery was decided.

- A GPU device-loss error may be classified by the existing bounded retry policy (at most three attempts per window).
- Known OOM, network, storage, cancellation and unavailable-backend failures remain non-retryable.
- `ModelManager.prepare({wasmOnly:true})` rejects unexpected GPU backend reports; no hidden fallback back to GPU is accepted.
- ASR progress and checkpoints remain tied to successful IndexedDB commits.
- Speaker errors, including watchdog timeouts, do not invalidate previously saved TXT; speaker processing can be retried separately.

### Tests

New Vitest checks cover:
- truthful initialization, transcription and cancellation lifecycle status;
- unresponsive model initialization followed by a clean retry;
- unresponsive speaker preload followed by another attempt;
- unresponsive speaker diarization and Worker cleanup;
- ignored late completion after cancellation;
- WebGPU device-loss policy and OOM exclusion;
- preserved original WebGPU backend when the ASR watchdog resets current engine state.

Existing WebGPU → WASM tests and browser acceptance remain active.

**Real-device status:** NOT TESTED on user GPU, real Whisper Small weights or original 14:31 / 33.3 MB MP3. Mocked Worker/ONNX tests do not prove that actual browser device-loss is reliably delivered to the app.

## Merge and deployment

This is stacked PR-24 on PR-23, which depends on PR-22 and PR-21. Merge in numerical order after each stage passes CI, then rerun combined CI on `main`. Do not deploy as a hardware-accepted release without real-browser inference tests.
