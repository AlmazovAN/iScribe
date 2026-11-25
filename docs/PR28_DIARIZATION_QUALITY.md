# PR-28 — Diarization alignment quality and explainable missing labels

## Observed problem versus assumptions

One historical real recording produced **97 detected speaker turns, 300 ASR segments, 123 unlabeled segments (41%)**. That observation alone does **not** establish whether the cause is imperfect Pyannote/WeSpeaker intervals, ASR timestamp drift, actual silence, incorrect overlap selection or UI/export behavior. PR-28 does not claim to fix all 123 cases without reproducing that source recording.

## Implementation

The speech recognition and diarization models, weights and backend have not changed. After the separate speaker Worker returns its timeline, the transcript-to-speaker join now:

1. Validates individual speaker intervals and counts malformed intervals. A single malformed turn no longer invalidates the whole speaker pass; unusable intervals cannot be evidence for a label. A non-array or enormous invalid Worker payload still fails.
2. Normalizes and **unions overlapping/duplicate intervals of the same speaker** so duplicated model turns cannot artificially double the overlap score. Different speakers' simultaneous turns stay separate.
3. Sums actual temporal intersections for each speaker. Zero-duration ASR segments use precise point containment and the same uncertainty handling.
4. Leaves a segment **unassigned** if the two strongest candidates are close (within 12% of the leader), or if the leading overlap covers less than 20% of a nonzero ASR segment's duration.
5. Uses a small tolerance **only if there is no overlap**: up to 80 ms between ASR segment and turn edge, and only for ASR segments no longer than 250 ms. Equidistant conflicting speakers remain unknown. Long silent gaps are never filled by simply copying a nearby label.
6. Drops stale speaker labels before remapping. It does not alter ASR segment text/timestamps, reorder transcript segments or change previously committed ASR checkpoints.

These are conservative heuristics to reduce invented speakers, not an evidence-based guarantee of better accuracy on every recording. They can leave more segments unlabeled than the old maximum-overlap approach. A human-labeled reference is needed to measure **accuracy and coverage jointly** before loosening the thresholds.

### Saved numerical diagnostics

The file row and redacted JSON report distinguish:
- total, valid, malformed and normalized speaker intervals;
- number of distinct speaker IDs (count only; IDs not exported);
- duration covered by the union of speaker intervals;
- ASR segment count and assigned/unassigned totals;
- assignments based on true overlap vs tiny boundary gaps;
- unassigned for ambiguous competing speakers, outside all model intervals, insufficient overlap or invalid ASR timestamps;
- zero-duration ASR segments.

The exported JSON includes **only counts and duration**, no audio, filenames, transcript contents, actual speaker identifiers or exception strings. This explains why speaker labels are missing without disclosing a meeting transcript.

### Recovery and user workflow

- ASR completion is committed to IndexedDB *before* the separate diarization pass begins.
- Missing labels yield a **partial** speaker result, but TXT and TXT + time are still downloadable.
- A subsequent **Повторить спикеров** retries the speaker stage only; completed Whisper windows are not processed again.
- A fresh complete speaker timeline can replace a previous partial speaker result without changing text or committed window numbers.

## Verification

Unit tests cover duplicate/overlapping turns, fragmented turns, near ties, point segments, 80 ms boundary compensation, long silent gaps, insufficient evidence, corrupted model intervals, immutable inputs and redacted diagnostics. Runner tests cover persisted partial results, existing TXT and speakers-only retry. Chromium uses a deterministic speaker-gap fixture and checks the same workflow.

**Real acceptance still NOT TESTED:** the user's actual 14:31 MP3, 97-turn/300-segment dataset, reference speaker identities and error categories on real model outputs.

## Real-data acceptance procedure (PR-30 hardware gate)

1. Run the *same* audio with the same Whisper Small and diarization model/backend, first on the previous build and then on PR-28.
2. Record the raw turn count and speaker-coverage seconds, ASR segment count, unmatched gap/ambiguous/weak/invalid counts, speaker counts, and 3-way TXT export.
3. Label a representative random set of segments manually, especially transitions and unknown segments. Calculate correct assignments, wrong assignments, unknown segments and coverage separately.
4. Accept a change only if no material accuracy regression is observed; a reduction in unknown labels alone is **not** a sufficient success criterion.
5. If most unknown segments are outside *any* real speaker timeline, fix or tune the underlying speaker model/VAD in a separate measured change. Do not compensate with fabricated nearest-speaker labels.

Do not publish private audio or the complete transcript to GitHub. Stacked on PR-27; merge in dependency order and run combined CI before production deployment.
