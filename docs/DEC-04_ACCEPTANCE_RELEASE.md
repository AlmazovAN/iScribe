# DEC-04 — Acceptance & Release (4/4)

## Candidate policy

- FFmpeg.wasm Core 0.12.10 is the default for new jobs in the candidate. `?decoder=legacy` selects legacy explicitly for new A/B jobs; the old provider is retained only for migration/compatibility and comparison. Existing tagged jobs and untagged historical checkpoints retain their original route. Never silently switch on error. Keep legacy until real recordings and old checkpoints are accepted; physical deletion is intentionally deferred.
- Both FFmpeg routes mount source Blob through WORKERFS; file protocol only. Full decoding still creates the complete mono PCM (max one hour) for speaker alignment; >128 MiB uses windowed mode, with the original 500 MiB source cap. Small compressed files longer than one hour remain outside the full-route limit. Windowed mode still has no speaker diarization. No change to Whisper segmentation, models, backend selection or speaker algorithm.
- UI job row displays actual recorded decoder kind, not inferred ASR backend. Packaging preflight requires FFmpeg loader and compressed WASM in standalone and web builds; web service worker must cache both. Added production Playwright tests for real decoding from file:// and offline web, plus distant seek and durable retry integration tests.

## Observed native reference experiment (NOT browser acceptance)

Executed on 2026-11-27 with native FFmpeg 7.1.5. Generated 41.37 s 48 kHz mono sine at 427 Hz, encoded PCM WAV, libmp3lame MP3, AAC/M4A, FLAC and libopus OGG. For each, decoded whole source to mono f32le at 16 kHz, decoded 10 s from 25 s using DEC-02 warm-up/trim strategy, and computed bounded tail length using FFprobe duration. Measured values:

| Container | Full samples | Tail-derived total | Window samples | Window RMS difference vs full | Max abs difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| WAV | 661920 | 661920 | 160000 | 0.0000000 | 0.0000000 |
| MP3 | 661920 | 661920 | 160000 | 0.0000000 | 0.0000000 |
| M4A | 662187 | 662187 | 160000 | 0.0000000 | 0.0000000 |
| FLAC | 661920 | 661920 | 160000 | 0.0000000 | 0.0000000 |
| OGG | 661920 | 661920 | 160000 | 0.0000000 | 0.0000000 |

This tests the CLI strategy on five generated samples with a different native FFmpeg version. Does not verify WASM package, VBR pathological seek, long recordings, memory, or Whisper. No private audio used.

## Required local CI (NOT TESTED)

Run the existing BAT launcher in Local mode against the final manifest-ready candidate. npm registry DNS failed with EAI_AGAIN in the authoring environment; npm ci, typecheck, lint, Vitest, actual Playwright FFmpeg tests, both builds, both preflights and offline Playwright remain NOT TESTED. Do not bypass these gates. GitHub Actions remain manual and were not dispatched.

## Hardware acceptance after local CI

| ID | Test | Criterion | Status |
| --- | --- | --- | --- |
| DEC-A1 | 12:18 / 28.2 MB problematic MP3, Whisper Small, RU WebGPU | completes or identifies failing audio/ASR phase with usable JSON and checkpoint | NOT TESTED |
| DEC-A2 | 63:54 / 146.5 MB problematic MP3 | window 41 and final window correct; complete or bounded diagnosed failure | NOT TESTED |
| DEC-A3 | Same inputs, new job, ?decoder=legacy vs default | compare duration, committed windows, text/timestamps, same ASR settings; no cross-provider resume | NOT TESTED |
| DEC-A4 | 120 min >128 MiB seekable recording, cancellation/reload | bounded lookahead, no sustained memory growth across rotations; no repeated committed text | NOT TESTED |
| DEC-A5 | real MP3 VBR, AAC/M4A, WAV, FLAC, OGG/WebM | full vs native reference sample count, overlap RMS, tail, no silent data fabrication | NOT TESTED |
| DEC-A6 | WebGPU and WASM, actual model | complete real inference, TXT, timecodes; speakers unchanged for full route | NOT TESTED |
| DEC-A7 | failed worker, reopen/split, persistent retry limits | no infinite automatic retry, no loss of prior text | NOT TESTED |

Record peak process memory, decoder and ASR times, exact build SHA and diagnostic JSON; do not upload recordings or transcripts. Numeric comparison tolerance to be established on actual diverse inputs; native sine results do not set a universal zero-error threshold. No claim that changing decoder fixes GPU/Whisper hangs.

## Redistribution

This candidate is for local source build and validation, not public binary distribution. @ffmpeg/core 0.12.10 is GPL-2.0-or-later; exact corresponding source/build configuration, third-party notices and redistribution terms still require review before distributing combined HTML or deploying Pages. Keep Pages manual; no public binary deployment until this review and hardware acceptance. Do not conflate package integrity or local CI PASS with public release acceptance.
