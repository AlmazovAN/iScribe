# iScribe — project status (2026-11-25)

## Local build

- `npm run build` produces the single application file `dist/iScribe.html` with the browser runtime and licenses embedded. Model weights are retrieved separately on first use.
- The standalone HTML passes the embedded WASM bytes to each engine worker so ONNX can initialize when opened from disk.
- `npm run build:web` produces the GitHub Pages package in `dist-web/`, including the Service Worker.

- Source files up to 500 MiB are accepted. Recordings above 128 MiB use windowed decoding and retain ASR checkpoints. Streamed recordings can exceed one hour and produce TXT with optional timestamps.

- The Google Drive / Colab tab is a browser-only UI prototype with a simulated queue, checkpoints, recovery, TXT downloads and idle shutdown.

- The local Diagnostics section under the ML status bar groups hardware acceptance, offline readiness, PCM checks, the per-record event log and JSON reports.

- The recognition list follows FIFO, with completed recordings at the bottom. Removing a queue slot preserves source audio and checkpoints. Speaker-model preload can be requested during processing and runs between jobs.

- Audio rows show model and queue status together. The progress meter displays the active Whisper window, saved timecodes and speaker progress.

## Integration status

- The deployed `main` contains merged PR-13–18 and PR-20; PR-19 was closed as a duplicate.
- PR-21–31 are **stacked PRs**, not yet merged into `main`. The code of each subsequent PR builds on the previous PR branch. Passing each intermediate CI is **not** a pass on final integrated `main`.
- PR-31: compact UI, secondary action menus, visible release SHA, user-facing file-storage errors, and a distributable-package preflight. See `docs/PR31_UI_RELEASE_PREP.md`.
- The public ChatGPT Site `https://iscribe-alexander.politebook7.chatgpt.site/` **has not been updated as part of PR-21–31**. The GitHub Pages manual workflow is a separate deployment target and is not an automatic ChatGPT Sites publisher.

## Automated CI history — mocked ML, not hardware

| PR | Key change | Recorded CI |
| --- | --- | --- |
| PR-21 | Project baseline and documentation | Baseline browser image issue; corrected in PR-22 |
| PR-22 | Privacy-safe per-window ASR trace | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45428607603) |
| PR-23 | Decoded PCM and window validation | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45553718206) |
| PR-24 | ML lifecycle and stuck-Worker recovery | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45554707262) |
| PR-25 | Append-only IndexedDB ASR checkpoints | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45555953603) |
| PR-26 | Offline application shell and WASM cache | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45556821903) |
| PR-27 | Durable FIFO after reload | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45652681765) |
| PR-28 | Conservative speaker alignment | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45654520756) |
| PR-29 | Persistent performance benchmark reports | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45656263805) |
| PR-30 | Hardware evidence and acceptance protocol | [PASS](https://github.com/AlmazovAN/iScribe/actions/runs/45660740952) |
| PR-31 | Final UI and release-package gate | **PENDING** until exact branch CI completes |

Tests above use synthetic audio and simulated inference. They confirm program logic and browser behavior, **not** true Whisper/GPU performance.

## Not yet verified on the user's device

- Original 14:31 / 33.3 MB MP3 with **real Whisper Small on WebGPU**, all 35 windows, true text quality, and robust recovery.
- Offline recognition using locally cached weights and ONNX/WASM on target hardware.
- Real GPU-device-loss → WASM fallback.
- Speaker quality on the 97-turn/300-segment/123-unlabeled historical sample (no human-labeled reference yet).
- Browser process RAM/VRAM, 30- and 60-minute stability, actual model cold/warm benchmarks.
- Live-site deployment correctness, service-worker update lifecycle, and migration of old IndexedDB v1 data to v2.

All real-hardware gates HW-1–HW-7 are **NOT TESTED**.

## Release sequence

1. Complete PR-31 CI including `npm run release:check`.
2. Integrate PR-21 → PR-22 → ... → PR-31 in order, checking branches and conflicts, without skipping dependencies.
3. Run full CI on `main`: TypeScript, ESLint, Vitest, Vite production build, release-package preflight, normal and offline Chromium acceptance.
4. Verify v1→v2 IndexedDB migration and rollback safety; an old v1-only build cannot access an already upgraded v2 database.
5. Perform real HW-1/HW-2 and remaining hardware scenarios according to `docs/PR30_HARDWARE_ACCEPTANCE.md`.
6. Only with an explicit release decision, publish using the **actual** ChatGPT Sites workflow; verify visible build SHA, HTTPS, cache, TXT and checkpoint behavior on the published URL. This work has not been performed by PR-31.
