# PIPE-01 — Decoder Stabilization

Status: comparison tooling prepared; native synthetic smoke PASS; browser/WASM, real reference audio and ASR quality NOT TESTED. Base audit main c60d3f028246cfef9de115becd2ff1380d527356; PIPE-00 #77 is predecessor. No application behavior changes, dependency upgrades, workflow changes or production deployment in this stage candidate.

## Why
Open #76 DEC-FRAME-001 at b5b9fe228e039ad676ef7bb8df9c2c9aaa1e99ae contains an existing bounded full-route recovery. The supplied incident evidence is strict FFmpeg exit 1 twice, damaged-frame/other diagnostics, no PCM reaching Whisper (739.261975 s). Root cause in source or decoder remains unconfirmed. #76 omits -xerror only on eligible retry, uses timestamp compensation, rejects unrelated categories/too many errors or drift >4000 samples. It leaves windowed decode unchanged. Static review is not acceptance; do not merge #76 without local tests. Do not copy its implementation into this stage or mix PCM identities across checkpoints.

## Local diagnostic matrix
Run from the candidate checkout with npm ci already successful and the pinned Chromium installed. Node 22 + pinned @ffmpeg/core 0.12.10 and @playwright/test 1.56.1; no new dependencies. The comparison uses a fresh browser Worker per case, immutable local Blob/WORKERFS, embedded core JS and WASM, network requests blocked, no model invocation, no writes to IndexedDB or source audio. It returns only numeric PCM summaries, timings, status and closed error categories, never source names, bytes, raw logs or transcripts. Use local files only. This is diagnostic tooling, not a second production decoder.

| Variant | strict | PCM | timestamp compensation |
| --- | --- | --- | --- |
| A | -xerror | f32le | no |
| B | normal FFmpeg error behavior | f32le | no |
| C | normal FFmpeg error behavior | s16le / 32768 | no |
| D | normal FFmpeg error behavior | f32le | aresample async, same command filter as #76 |

A/B/C share all other relevant options: first audio track, 16k mono, one thread, same input and trim. D isolates the timestamp-compensated command, not the eligibility, validation and retry state machine of #76. C approximates Colab load_audio numerical output; native and WASM may differ by version and build flags. Do not assume B/C/D is a quality improvement or use its result as automatically valid ASR input.

```powershell
node scripts/pipe01-compare.mjs --self-test
node scripts/pipe01-compare.mjs "C:\local\recording.mp3" --expected-seconds=739.261975 > pipe01-full.json
node scripts/pipe01-compare.mjs "C:\local\long-recording.mp3" --window=25:30 --window=1000:30 > pipe01-windows.json
```

The self-test creates synthetic 1 s PCM16 WAV, checks all full variants and A/B/C for a 1 s window; it needs the actual local WASM package and Chromium. Full diagnostic limit: source <=128 MiB and decoded <=1 hour. Window mode: files <=500 MiB; bounded explicit windows <=30 s, up to 20 windows, same 1 s warm seek/trim pattern as production stream. Exact length required for window sample, select in-range intervals. D only full. Window mode samples chosen intervals, not a full stream, not production ffprobe/EOF or rotation verification. Fresh Worker per case prevents cumulative state contaminating a case but cannot reproduce long-lived Worker memory failure. Duration from --expected-seconds is an external reference, not proof of correct sample timeline; real drift may be caused by container padding/metadata. Compare actual content locally; aggregate statistics cannot detect every discontinuity. A status decoded means exit zero + finite bounded PCM, not acceptance of damage. B/C/D may return decoded with error categories; treat as diagnostic only. Nonzero decode, coverage failure, unknown errors and timeout must be investigated, never hidden.

## Observed native smoke (not WASM)
In development container, native FFmpeg 7.1.5, synthetic 1 second 16k mono PCM16 sine, full command variants A/B/C/D each exit 0, 16000 samples, RMS 0.215790840 (rounded), zero stderr bytes. This establishes only the native command/format smoke on healthy synthetic input. No actual user audio available to this environment. npm registry DNS EAI_AGAIN blocks dependency installation; browser comparison, Vitest, local CI and real-device gates NOT TESTED.

## Acceptance and rollout
1. Run stable BAT for the separate #76 candidate with unchanged manifest/head; collect all local gates and then reproduce the real 12:18 incident in the built app. No silent legacy fallback, bounded attempts, truthful log and no reuse of incompatible PCM. If gate fails, retain current main and report.
2. Run diagnostic self-test and comparison against same actual reference file(s) A/B/C/D. For long 63:54 audio inspect windows 2 (start 25 s) and 41 (start 1000 s), plus clean controls. Record actual full streamed-job behavior and speaker limitations separately.
3. For each mode compare code/status, error categories, length/drift, RMS/min/max, zero and out-of-range counts, decode and init durations; listen locally for gaps and dropped speech. Do not equate exact length with preserved speech. For a fair ASR comparison, a follow-up guarded test path must feed each accepted PCM into identical Whisper Small model/version/backend/settings; compare WER (if local reference text), repeated hallucinations, timing, overall runtime, RAM. Current diagnostic does not run ASR.
4. Decide production policy only after results: retain current strict baseline, adopt a bounded recovery as #76, or implement another tested policy. No global removal of -xerror, automatic fallback or unconditional s16 conversion from this PR. Define separate windowed recovery only with absolute timeline and coverage tests.
5. After independently resolving #76, reconcile candidate with resulting main (preserve stage heads and history, rerun gates), update release manifest with exact SHA when final release is prepared. No stale-base integration or unrelated historical PERF merges. Keep all existing tests mandatory; no GitHub Actions dispatch. PIPE-02 may be designed against this contract but do not claim PIPE-01 acceptance or release before evidence.
