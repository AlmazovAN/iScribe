# PR-25 — Memory and IndexedDB checkpoint optimization

## What changed

The browser continues to own all original audio and transcripts locally. This stage reduces memory pressure and repeated IndexedDB writes while preserving atomic, resumable ASR.

### Append-only ASR chunks, IndexedDB schema version 2

- The database name remains `iscribe-jobs-v1`, but its version is raised **from 1 to 2**.
- The existing `jobs` and `audio` object stores remain intact.
- Two additional stores are created: `asr-chunks-v2` with composite key `[id, offset]`, and `speaker-results-v2` with key `id`.
- `jobs` holds job metadata, committed `nextWindow` and the total `segmentCount`; the full ASR transcript is **no longer written with every metadata update**.
- For a successful ASR window, only the new segment suffix is stored. A window with no text advances the metadata checkpoint without inventing a text chunk.
- **Every** new chunk and its `nextWindow` value is persisted in one IndexedDB read-write transaction. If any write fails, the entire transaction aborts, leaving the previous checkpoint and text intact.
- Previously saved v1 job records remain readable unchanged until their first subsequent save; then their existing transcript and speakers move to the new stores **within the same transaction** (lazy migration). The original audio file is never rewritten as part of transcript migration.
- Loading one active job uses `JobStore.get(id)` instead of reading every saved job and transcript.
- Removing a job deletes its audio, metadata, ASR chunks and speaker results in a single transaction.
- Reconstruction checks for missing/misordered ASR chunks and mismatched segment totals. Corrupt data is never reported as a successfully completed transcript.
- In-memory-only `volatileSegments` are still never committed to IndexedDB as durable text.

### Memory in the audio pipeline

- If browser decoding yields 16 kHz mono PCM, reuse its existing `Float32Array` channel view instead of making a complete `.slice()` copy.
- For the separate speaker inference Worker, transfer the full PCM `ArrayBuffer` after ASR instead of structured-cloning it. If a browser rejects transfer before detaching the buffer, fall back to the previous cloning path.
- The full PCM is **not needed by the calling thread after** launching speaker diarization. If the speaker pass fails, the preserved source file can be decoded again on retry.
- **ASR still uses `audio.slice(window.start, window.end)`** to transfer/copy only a 30-second window to the inference Worker; do not pass a `subarray` backed by the entire recording into the engine.
- The browser still decodes the original recording in full on initial processing or resume. This PR does **not** introduce streaming MP3 decode; peak memory can remain high for hour-long recordings.

### Trade-offs and migration risk

The schema upgrade is **one-way for old deployed versions of the site**: a previously deployed build using `indexedDB.open('iscribe-jobs-v1',1)` may fail to open the upgraded local database with `VersionError`. Do not deploy and then roll back to that old build without a compatible storage upgrade/downgrade strategy.

The full transcript still exists in memory as an array for display and export, but incremental IndexedDB writes stop rewriting all earlier segments every 30 seconds. Speaker results are written as a whole when present, since diarization is normally one later phase.

A future feature to **edit earlier ASR segments** must supply an explicit, atomic transcript-revision operation. PR-25's current storage path is append-only and intentionally rejects checkpoint regression and transcript truncation.

### Test matrix

Automated tests cover:

- Two new ASR chunks with intermediate metadata writes and a silent window: existing chunks are unchanged.
- v1 legacy database opening, lazy migration, speaker results, and retained original audio.
- IndexedDB transaction failure during chunk writing: preserved earlier checkpoint and text.
- Rejection of regressive checkpoints or shorter transcripts.
- Independent retrieval and deletion for multiple jobs.
- Corrupt/missing chunks: a hard diagnostic failure, never a fake completed job.
- Speaker PCM buffer transfer and safe fallback to cloning.
- No redundant full PCM copy for already-decoded 16 kHz mono.
- Existing ASR, refresh/resume, cancellation, partial TXT, WebGPU→WASM and Playwright browser acceptance.

**Important:** Actual browser storage pressure, large-source memory peaks, Whisper Small inference and the original 14:31 / 33.3 MB MP3 remain **NOT TESTED** on real hardware. Synthetic tests and mocked ML are not substitutes.

## Verification commands

`npm ci`; `npm run typecheck`; `npm run lint`; `npm test`; `npm run build`; `npx playwright test` through existing CI.

Merge only after preceding PR-21–24 and current PR pass CI. No production deployment in this PR.
