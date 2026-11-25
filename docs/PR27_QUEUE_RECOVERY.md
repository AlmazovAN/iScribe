# PR-27 — Persistent FIFO queue and restart recovery

## Problem

Before PR-27, the queued file IDs lived only in the in-memory `JobRunner.queue`. A page refresh kept completed ASR checkpoint data in IndexedDB but lost the queue, and `recoverJob` changed every queued job into `interrupted`. Repeated starts could no longer reproduce the original FIFO.

## New durability contract

Each explicitly enqueued job receives an integer `queueOrder` in the existing IndexedDB v2 `jobs` record. There is **no database schema upgrade** beyond PR-25. The original audio, model, language, speaker flag and committed text remain stored exactly as before.

- `enqueue` assigns FIFO order and serializes pending queue writes before expensive model inference may start.
- Queue order uses the stored `queueOrder`, never file name, creation date or `updated` time. A checkpoint update must not move a job to the tail.
- At startup, queued items remain `queued`. An in-flight `recognizing`, `preparing` or `speakers` job is converted to `interrupted` **but keeps its place** in the same FIFO.
- The list and its order are restored automatically, but **inference is not automatically restarted** on page load. The **Продолжить очередь** control resumes all remaining files in order. This avoids a surprise large model download or GPU session after reopening a browser.
- Clicking the restored interrupted job's own **Продолжить** action also resumes the FIFO without duplicating that job.
- Every successful job clears `queueOrder` in the same terminal metadata write; after reload it is never scheduled again. A failed or cancelled job also leaves the queue, preserving its committed TXT for explicit retry.
- The unfinished window is replayed, but the last saved `nextWindow` and ASR text are never rewound. A transcript-only recovery or speaker retry does not repeat completed ASR.
- A denied cross-tab Web Lock or an enqueue-persistence failure does **not** erase the in-memory queue. A later user-triggered resume can retry; the status explicitly warns that local data might not have been saved if IndexedDB failed.
- Legacy `queued` jobs with no durable `queueOrder` remain manually resumable as interrupted rather than being assigned a fabricated original order.

## Privacy and limits

Queue metadata contains only a numeric order; it adds no uploads, network activity or server-side queue. Browsers may evict IndexedDB under storage pressure. If storage fails while enqueuing, the UI warns that the queue may not survive a refresh.

Web Locks protect the ML engine from simultaneous processing in cooperating tabs, but other open tabs may display stale UI until reloaded. PR-27 does not claim distributed queue synchronization between active tabs.

A browser refresh **still stops** the actual WebGPU/ONNX Worker. This PR restores intent and checkpoints; it does not keep GPU computation running in the background after closing the tab.

## Automated verification

- Restore an out-of-order set of persisted jobs by `queueOrder`; in-flight first job resumes from a committed window.
- No model initialization at startup until the user activates **Продолжить очередь**.
- Rapid enqueue serializes persistent positions; repeated clicks cannot insert the same job twice.
- Cross-tab lock denial leaves a durable queued job and allows later retry.
- Existing checkpoint, download and diarization regression suites.
- Playwright Chromium: queue three files; stall the first after one checkpoint, reload, verify two pending files remain queued in FIFO, resume all with one click, confirm no duplicated ASR and no queue left after another reload.

**Hardware acceptance still NOT TESTED:** the user's real 14:31 / 33.3 MB MP3 and Whisper Small/WebGPU, high-volume queue with real multi-GB models, actual tab crashes/OS termination and storage quota eviction.

## Branch and rollout

Stacked on PR-26, which depends on PR-25 → PR-24 → PR-23 → PR-22 → PR-21. Merge sequentially after CI and verify the resulting `main` before deploying. PR-25's one-way IndexedDB v2 compatibility warning still applies.
