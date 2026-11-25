# PR-32 — Large MP3 streaming ASR (experimental)

## Why

Before PR-32, iScribe rejected any file larger than 128 MiB and decoded all compressed bytes to full-record PCM in memory. Merely increasing the byte limit can crash a tab.

## Scope of this iteration

- **Large MP3 only**: from 128 MiB to 512 MiB; other formats remain limited to 128 MiB.
- **Duration still limited to 60 minutes.** This is an intentional compatibility constraint for the current speaker engine and ASR window-planning validation.
- A bounded 256 KiB Blob-slice frame reader scans MPEG-1/2 Layer III frames, rejects corrupted/unsupported headers and mixed sample rates, and skips an initial ID3v2 tag.
- A WebCodecs `AudioDecoder` reads MP3 frames incrementally and converts PCM to mono 16 kHz, retaining at most approximately 32 s of PCM in a circular buffer. The current 30 s window is copied for Whisper; the next window shares the same 5 s overlap.
- Existing retry and append-only IndexedDB v2 commits remain unchanged: the active window is only committed after successful ASR. On resume the decoder scans/decodes the source again to reach the next uncommitted window, but **earlier windows are not sent to Whisper again**.
- The codec may trim encoder priming/end padding (e.g. Xing/LAME); final duration differences under one second are tolerated without filling artificial speech. Greater inconsistencies fail clearly rather than silently changing checkpoints.
- **Speaker diarization remains unavailable for MP3 files over 128 MiB.** Its current API needs the full source PCM. In this mode plain TXT and TXT+time are preserved, and the UI explicitly marks the job partial when speakers were requested.
- Standalone full-PCM inspection is unavailable for large MP3. Instead, each decoded window is validated for finite samples before ASR. The scan itself validates MPEG frame structure but cannot guarantee real audio quality.
- No library, external server, upload, FFmpeg runtime or new model dependency introduced.

## Hardware / compatibility limitations

1. MP3 WebCodecs support is implementation-dependent. Chrome/Edge/Opera are recommended; the capability is tested using `AudioDecoder.isConfigSupported({codec:'mp3',...})`. The app fails explicitly on unsupported browsers and does not fall back to full-record decoding.
2. A 512 MiB file must be stored as a Blob in IndexedDB; storage quota and browser eviction still apply. The user must save TXT externally before clearing site data.
3. Only standalone MP3 with consistent MPEG Layer III frame format is supported in streaming mode. Files with nonstandard metadata, APE tags, mixed rates or damaged frames may require external conversion. Malformed input must stop without marking another checkpoint complete.
4. **Hardware validation remains NOT TESTED.** Passing unit tests and synthetic Chromium tests does not demonstrate successful recognition of a genuine >128 MiB MP3, GPU memory use, real WebCodecs behavior on the user's device, or transcript accuracy.
5. Full diarization of large files, >60 minute recordings, AAC/M4A streaming, true random-access MP3 seeking, and file-storage quota stress are future iterations. This PR is not a universal large-audio solution.
6. Progress and preliminary duration are estimated from frame headers. Gapless playback metadata and MP3 decoder trimming may produce a small difference in the final samples, so timing should be checked on a real sample.
7. **Do not publish to the live ChatGPT Sites URL until hardware tests have passed** and the user has requested release.

## Acceptance

- Test MPEG 1/2 header parser, frame boundaries/ID3 handling, errors, duration cap, stable 5 s overlap of two synthetic decoded windows, safe no-codec error, and full-decode denial for large MP3.
- Run all legacy tests, TypeScript, ESLint, production build, release-package integrity, synthetic normal and offline Chromium suites.
- On the actual browser with a >128 MiB MP3: confirm successful WebCodecs init; record file size and duration; use Whisper Small and initially disable speaker separation; verify two distinct windows and save TXT.
- Reload and resume, verify no repeated **ASR** for committed windows; compare checkpoint count, transcript and timestamps.
- Complete all audio windows and export TXT+time. Explicitly check RAM growth and playback time on a real >128 MiB original.
- Keep real-hardware results separate from synthetic CI.
