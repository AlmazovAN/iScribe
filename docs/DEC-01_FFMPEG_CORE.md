# DEC-01 — FFmpeg core (stage 1/4)

## Audit

- Normal route: src/audio.ts -> Web Audio API, AudioContext/decodeAudioData, mono and OfflineAudioContext resample; 128 MiB source threshold, one-hour PCM limit.
- Streamed route: src/streamedAudio.ts -> MediaBunny AudioSampleSink, timestamp windows, mono and OfflineAudioContext. Existing strict-coverage recovery and prefetch are preserved.
- Existing src/audioValidation.ts already checks finite PCM and 30 s windows with 25 s step. Reuse it rather than introducing competing rules.
- Standalone packager previously accepted exactly one ONNX WASM; FFmpeg assets now have separate explicit names. Both web and standalone use locally packaged assets. No CDN.

## Engine decision

LibAV.js default distribution does not include MP3/AAC; obsolete variant adds MP3 but not AAC. Custom build would require an additional reproducible binary toolchain and licensing review. Use the published single-thread @ffmpeg/core 0.12.10 as the experimental full-file decoder. It is not a permanent streaming-engine choice: DEC-02 must benchmark and decide whether bounded window decoding with FFmpeg.wasm or a custom LibAV.js build is warranted. No promise of true streaming for this stage. Core is GPL-2.0-or-later. Before any binary publication, verify exact corresponding source, dependent libraries and license obligations; do not publish from this stage.

## Opt-in

Default behavior unchanged. For a test build, open iScribe.html?decoder=ffmpeg (or use the same query on the web shell). Files <=128 MiB use FFmpeg; larger files still use the existing MediaBunny route. There is no silent fallback on FFmpeg failure. The worker outputs mono PCM float32 16 kHz, selects first audio stream, rejects nonzero FFmpeg exit and duration over one hour, releases the worker on success/error/cancel. The ten-minute hard deadline is provisional, not an idle watchdog. Full-file memory remains bounded by existing input/duration limits but may still be substantial; DEC-02 addresses this. The output is not normalized or denoised.

## Acceptance

- npm ci, typecheck, lint, Vitest, both builds, release preflights and Playwright: NOT TESTED (no npm registry or local project access in current environment). Lock metadata copied from independently published matching lock entry; npm ci is mandatory.
- Playwright real WASM synthetic stereo WAV and invalid MP3 tests added, not executed.
- Local test build: compare MP3 and M4A/AAC, FLAC, WAV, Ogg/WebM with native FFmpeg; verify sample count, sample-rate, finite values, duration, cancellation, offline and file:// startup. Reproduce the user's two recordings without uploading private audio. No claim that Whisper stalls are caused by decoding or fixed.
- No model IDs, ASR segmentation, checkpoints, WebGPU selection or workflow definitions changed.
- Stage PR targets the DEC release candidate; final manifest and main PR belong to DEC-04.
