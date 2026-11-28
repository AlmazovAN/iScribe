# PIPE-09 — Whisper ASR Quality

Status: implementation prepared. Exact src/ml/asrQuality.ts Git blob 3554754d23041506fb597418ae6bcd19693628ab verified with git hash-object and compiled with TypeScript 5.8.3 strict/ES2022/DOM; Node 22.16.0 7/7 standalone smoke PASS. Exact scripts/pipe09-compare.mjs blob a931ef8ae3770cc182aed092df9ecb3451a4ca68 verified and run in Node 22.16.0; 4/4 smoke groups PASS including CLI on synthetic UTF-8 files. Full project TypeScript 5.9.2, Vitest/IndexedDB, Playwright, build, real Whisper, real audio and hardware NOT TESTED. npm ping failed EAI_AGAIN in this session. Stacked on PIPE-08 #85. No Actions dispatch, main merge or deployment.

## Scope and invariants

Existing pinned @yourdevice/engine 0.1.1 + Transformers 4.3.1 host calls transcribe(audio,{language,task:'transcribe',diarize},callbacks). No verified support in the project wrapper for beam size, temperature, condition_on_previous_text, no_speech_threshold, compression_ratio_threshold or batch size. The installed engine package could not be inspected with npm unavailable. Do not invent parameters or assume equivalence to WhisperX/faster-whisper. Do not change engine patch hashes, model weights/dtype, active backend policy, PCM, window plan or existing fixed/adaptive RAW keys here. Batch inference is a candidate for later research, not implemented; existing one active inference per job and per-window commit contract preserved.

ASR quality check runs after RAW publication (eligible PIPE-04 checkpoints) and outside the Worker retry loop. Existing hard structural limits are maintained: text string, finite nonnegative start, finite end >= start, end <= window duration + 1 second. Non-array result is rejected; undefined result cannot be published. Invalid RAW produces numeric quality event, no text/nextWindow/quality summary commit and no automatic rerun. Verified RAW may be reused at recovery exhaustion. No tighter hard timestamp tolerance until real engine outputs are characterized. The existing midpoint overlap ownership runs once after valid RAW; analysis of repetition uses owned segments, not duplicated overlap hypotheses.

## Quality evidence

| Signal | Current decision |
| --- | --- |
| Missing/non-string text, invalid/reversed/out-of-bounds timestamps beyond existing +1 s tolerance | Hard rejection, preserve RAW where available |
| Zero-duration, out-of-order start, adjacent overlapping segments, end beyond PCM but within +1 s tolerance | Advisory warning |
| Exact consecutive repetitions | Advisory warning: 1 token repeated >=8 times, 2-token phrase >=4 times, 3–12-token phrase >=3 times; case/punctuation normalized |
| Text when whole PCM window is almost zero | Advisory warning: peak <= 1e-5, RMS <= 1e-6 and owned word tokens present |
| Dense output | Advisory warning: >8 owned word tokens per second of full input window |
| Empty output | Count separately, not by itself a warning |
| Text scan cap reached | Advisory warning, incomplete evidence |

Provisional thresholds chosen for conservative detection, not a measured hallucination classifier. Repeated technical speech or legitimate speaker emphasis, very short speech, overlap, quiet signal, dense output and model timestamp conventions may trigger warnings. Whole-window signal check cannot identify silent portions within a mixed window; no use of unaccepted VAD map to classify hallucinations. Tokenization is NFKC, lowercase Unicode letters/numbers; up to 65536 input chars/4096 tokens per current window, skip tokens >128 chars; local previous up to eight committed segments/2048 chars/256 tokens then last 36 tokens provide bounded cross-window context. Exact repetition scan does not detect all paraphrased or invented words. No deletion, filtering, correction, forced retry or parameter change based on advisory warnings. Hard rejection behavior matches previous gate, now observable.

## Persistence and diagnostics

AsrQualitySummary revision 1 is optional job metadata, no new IndexedDB migration. Counts examined committed windows, warning/repetition/silent-text/timestamp/empty/dense/limited windows. Each accepted window's summary increments in SAME existing transaction as text, nextWindow and ASR reservation completion. On failed commit no durable summary increment; RAW replay recomputes QA from committed prior state and does not double count. JobStore rejects missing/rolled-back or inconsistent summary, including increments not matching checkpoint progress. Older windows are not retroactively called checked. Diagnostic panel shows warning count / examined count, tooltip provides repeat/silent/timestamp counts. Existing bounded trace emits per-window numeric asr-quality report; invalid RAW not counted in accepted summary. Export includes validated closed summary fields and numeric per-window reports, no words/PCM/paths or arbitrary error messages. Full scan adds at most one PCM window pass; benchmark on target device.

## Local quality comparison

scripts/pipe09-compare.mjs compares one human-reviewed UTF-8 plain reference TXT with 1–8 plain (no timestamps or speaker labels) candidate TXTs. Example from repo root:

    node scripts/pipe09-compare.mjs "C:\local\reference.txt" "C:\local\baseline.txt" "C:\local\adaptive.txt"

Reports only candidate index, reference/candidate word counts, Levenshtein edits and WER as ratio (0.25 = 25%). No network or transcript/path in output. Bounds: 2 MiB per file, 15000 words per file, 150 million DP cells per comparison; split longer inputs into aligned reference/candidate portions and sum edits / sum reference words. Normalization NFKC lowercase Unicode letter/number words; punctuation ignored, no special equivalence for numerals, ё/е, abbreviations or domain vocabulary. WER can exceed 100% due to insertions. Empty reference rejected, empty candidate allowed. No WER claim without human reference. This script compares outputs, not engine timings or configurations automatically.

For paired acceptance keep source, selected language, model, observed backend and settings constant; create distinct jobs when switching segmentation or future model parameters. Compare fixed baseline vs accepted adaptive VAD, Whisper Tiny vs Small vs Large v3 separately; note cold/warm init, model repo/actual backend, RTF, memory and quality counters. Review warning windows manually, annotate genuine repeats, quiet/distant speech and hallucinations; measure WER, insertions/deletions via manual review, absolute boundary timing errors, missed short words and number of suspect loops. Test at least short speech, silence/noise, 12:18, 35:38, 63:54, Russian technical vocabulary and English. Record thresholds before changing defaults. Batch research must verify engine API and independent per-window RAW/checkpoint/rollback, bounded memory and order before implementation. No real quality or speed improvement asserted from this stage.

## Verification

7/7 standalone exact helper checks: invalid RAW/timestamp counters, exact repeat, cross-window repeat, near silence, bounded/dense text, atomic summary arithmetic on legacy progress, redacted projection. 4/4 exact WER script checks: normalization/deletion, edit distance, limits, local UTF-8 file and privacy; synthetic CLI WER 1/3 for 3 reference words and one deletion. Added seven Vitest helper cases, three script cases, one JobStore test, one new JobRunner warning-preservation test and extended two RAW failure/replay regressions. Project tests authored, NOT TESTED. Mandatory local CI unchanged. #76/#78 reconciliation and PIPE-07/08 model/quality acceptance remain outstanding. Do not merge stacked PR directly to main.
