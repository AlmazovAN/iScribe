# PR-31 — Compact UI and release candidate preparation

## Goal

Bring the current iScribe browser UI to a quieter, denser, production-like layout **without changing its browser-only recognition engine**, model IDs, inference settings, time windows, transcript checkpoints, IndexedDB storage schema, offline Service Worker, or three independent TXT export formats.

PR-31 makes the software *easier to review and package*. It does **not** certify Whisper Small or hardware reliability.

## Interface changes

- The desktop heading, model cards, download/status blocks, upload area and file rows use more compact spacing. The three Whisper model cards and speaker card retain their existing left-to-right arrangement on desktop. Small screens keep a responsive 2-column model selector.
- File rows prioritize **Start / Resume**, **Скачать TXT**, **TXT + time**, **TXT + time + speaker**, active-job **Отменить** and remove action. All three export buttons stay accessible during recognition and diarization whenever corresponding saved text exists.
- Secondary buttons **Проверить аудио**, **Диагностика JSON** and **Бенчмарк JSON** move into the keyboard-accessible native `<details>` menu **Дополнительно**. It is collapsed by default to reduce button clutter, not removed.
- Long per-file measurement and diagnostic text moves into another native `<details>` **Подробности обработки**. Important errors and unsaved-volatile-text warnings remain visible without expanding anything.
- Queue order is computed once per UI render and retains the same `queueOrder` values after refreshing a page.
- The footer displays the Git SHA (seven characters) embedded during Vite build and **Тестовая сборка**, making it easier to verify what version is actually opened. A missing build hash is labeled `недоступен`, never guessed.
- Errors from adding or removing audio are surfaced rather than becoming silent unhandled Promise rejections.
- Focus states, readable text, touch-safe actions and mobile screen widths are part of browser acceptance.

**Out of scope:** New recording, system-audio capture, Google Drive upload, engine refactor, streaming compressed MP3 decode, new models, claims that speakers are correct without ground truth.

## Packaged-release preflight

`npm run build:web && npm run release:check:web` runs `scripts/release-preflight.mjs` against the deployable `dist-web/` package. The standalone `dist/iScribe.html` has a separate `npm run release:check`.

**Release package requires:**

1. Built `index.html` and a real bundled JS entrypoint;
2. Bundled CSS and built JavaScript/Workers;
3. `sw.js` with a versioned offline cache and its offline probe;
4. A local compressed ONNX/WASM runtime referenced by the Service Worker;
5. Nonempty `THIRD_PARTY_NOTICES.txt` attribution file;
6. All relative asset links in `index.html` resolving to real packaged files;
7. Zero-length assets and accidental `tests/`, `src/`, or mock e2e harness files excluded from the distribution.

This gate runs in CI and in the existing manually triggered GitHub Pages workflow. It verifies static package completeness, **not the ability of a particular browser to run WebGPU or decode a specific MP3**, and it does not test the ChatGPT Sites hosting integration.

The preflight returns `hardwareAcceptance: "NOT TESTED"` even on success. Production publication is deliberately not automatic.

## Acceptance matrix

| Level | Required verification | Interpretation |
| --- | --- | --- |
| Unit | Existing Vitest suites + new failing/success preflight fixtures | Business and package logic correct under synthetic conditions |
| CI build | TypeScript, ESLint, `npm run build`, `npm run release:check` | Sources compile and a self-contained static package was produced |
| Browser | Existing 14:31 synthetic scenario, offline Chromium, compact interface test at desktop and 390 px | UI/IndexedDB/checkpoint/export controls work in test Chromium |
| Real device | HW-1–HW-7 from PR-30 using actual audio and hardware | **NOT TESTED** until performed outside GitHub CI |
| Production URL | Verify live site SHA, HTTPS, model downloads, IndexedDB migration, TXT download, and source audio | **NOT TESTED** until deployment and live smoke test |

### Manual browser smoke test (after integrating the stacked PRs)

1. Open the real **HTTPS** site, not `tests/e2e/harness.html`; confirm **Тестовая сборка · SHA** agrees with the intended Git commit.
2. Confirm Whisper Tiny, Small and full Large v3 are horizontal and diarization is selectable; keep Small/`ru` for acceptance.
3. Load the original audio. Before first recognition, all TXT export controls must be disabled. Start ASR, confirm partial plain TXT becomes available as checkpoints are committed.
4. Expand **Дополнительно** to inspect PCM or export diagnostic JSON while keeping existing text controls in place.
5. Reload after two windows: verify the saved checkpoint remains and start/resume continues from the next uncommitted window, not from zero.
6. Verify three independent downloads and partial diarization behavior. Speaker failures must not discard plain TXT.
7. Perform the PR-30 hardware validation; do not mark any gate PASS based only on the successful code or test runner.
8. Test at common desktop size and at a narrow mobile viewport; confirm keyboard navigation and absence of horizontal overflow.

## Release and rollback

1. Sequentially integrate the dependency chain **PR-21 → PR-22 → … → PR-31**. The PRs were stacked, so merge each into its intended parent carefully and confirm the resulting `main` contains the full code exactly once. A PR passing CI on its intermediate parent does not prove the final integrated branch.
2. Run complete CI on `main` after final integration. `dist-web/` should be produced from that `main` SHA and pass `release:check:web`.
3. Check IndexedDB v2 migration from the old deployed version. **Important:** older site code calling `indexedDB.open('iscribe-jobs-v1',1)` cannot access a DB already upgraded to version 2; no direct rollback to a v1-only build without compatibility work.
4. Service Worker uses a build-pinned cache and intentionally does not `skipWaiting`: when the previous site is still open, the new controller may not activate immediately; confirm version after closing/reopening old tabs.
5. Keep the existing deployment host separate from the GitHub Pages workflow. GitHub Pages workflow does **not automatically update** `https://iscribe-alexander.politebook7.chatgpt.site/`. Verify the real publication path explicitly; do not invent a GitHub action that claims to deploy to ChatGPT Sites.
6. Conduct real-device HW-1/HW-2 as minimum reliability acceptance, and HW-3–HW-7 before promising complete offline, speaker or GPU-fallback reliability. If a gate fails, document the limitation and do not claim production readiness.
7. Only publish the live site after an explicit release decision and real-site verification. This PR does **not** merge any branch or publish the site.

## Evidence labels

- **CI PASS** means recorded TypeScript, lint, unit, package and mocked Chromium tests passed for an exact SHA.
- **HARDWARE NOT TESTED** means the real user MP3/model/GPU were not executed.
- **DEPLOYMENT NOT TESTED** means the target public URL has not been updated and verified.
