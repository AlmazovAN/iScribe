# Architecture baseline (PR-21)

Browser-only React 19 + TypeScript + Vite frontend. `src/App.tsx` presents model cards, file queue and transcript controls. `src/jobRunner.ts` orchestrates jobs, audio decoding, 30-second overlapping ASR windows, committed IndexedDB checkpoints, retries, separate speaker processing and TXT exports. `src/ml/activityWatchdog.ts` monitors active-window ASR progress with a five-minute foreground-idle threshold. `src/ml/manager.ts` owns model sessions and backend selection. `src/jobs.ts`, `src/jobStore.ts`, `src/recognitionProgress.ts` and `src/formatTranscript.ts` implement window/checkpoint, storage, progress and export contracts.

Runtime dependencies are pinned in `package.json`, notably `@yourdevice/engine@0.1.1`, `@huggingface/transformers@4.3.1` and a prerelease `onnxruntime-web`. `scripts/patch-engine.mjs` guards engine patching with hashes. Changing engine versions requires separate compatibility testing.

Audio and transcripts are stored locally; model assets use browser caching. Cached assets do not by themselves establish offline readiness. Closing the tab stops computation; reopening resumes from confirmed checkpoints, not from in-memory inference state.

Known trade-offs to profile rather than blindly rewrite: full audio decode on resume and speaker retry, whole-job checkpoint serialization, in-memory queue state, full-audio speaker pass and browser storage quota/eviction.


## DEC-04 candidate decoder architecture

AudioDecoderProvider selects full/windowed FFmpeg.wasm for new jobs, with Blob-backed WORKERFS, strict PCM gates, existing bounded prefetch and durable recovery. Legacy provider remains for historical checkpoints and explicit comparison. Decoder identity is persisted before decode; no silent switching. The native CLI experiment is separate from pending WASM and hardware acceptance.
