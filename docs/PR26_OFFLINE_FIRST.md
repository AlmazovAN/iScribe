# PR-26 — Local First: Offline shell, WASM profile and model-cache checks

## What is now designed to work offline

The browser saves the **application shell** (index.html, versioned UI script/CSS, ML Worker scripts, compressed local ONNX/WASM runtime) using a build-specific, same-origin Service Worker. The service worker is generated from the exact Vite bundle for each release; it does not fetch or cache arbitrary URLs. The original `transformers-cache` still owns Hugging Face model weights, separate from app shell data.

### First run and upgrades

1. Open the published iScribe site using HTTPS while connected to the internet.
2. Let the site's Service Worker install and finish pre-caching app assets. Confirm **Автономная работа → Приложение: сохранено** and **ONNX/WASM: сохранён**.
3. Download the selected Whisper model. A GPU profile alone is not a WASM fallback: use **Подготовить WASM** to fetch/initialize the q8 WASM profile, then recheck.
4. If speaker diarization is required, download both speaker models separately.
5. Open the app again **without internet**, then run a real transcript to establish actual offline inference. The status widget reports **file readiness only**, not successful inference.

Current status counts a cached Whisper model only when its required config/tokenizer files and one compatible pair of ONNX files are present. The WASM cache check requires the matching *q8 encoder and decoder*, both from the same model revision; mixed backend models cannot falsely pass. Speaker caches are checked separately. A partial or missing cache is reported explicitly.

The runtime uses pinned same-origin ONNX assets from the build, not an unpinned CDN. For matching Hugging Face model URLs, a failed online request may use an exact valid CacheStorage response. When the browser reports offline, eligible model-file requests are read from `transformers-cache` without reaching the network. **HTTP Range requests are never synthesized** from whole-file responses. If a required file is unavailable, the operation fails with an explicit message rather than claiming the model is ready.

### Safety, privacy and lifecycle

- The Service Worker **does not cache uploaded audio, transcripts, model files, API responses, or unknown URLs**. Audio and text remain in IndexedDB under the established application origin. Models stay in their dedicated Transformers cache.
- All caches can be evicted by the browser under storage pressure or removed with site data. An offline readiness indicator must never be treated as permanent.
- The Service Worker does **not** use `skipWaiting` automatically. A new release should not silently replace the active fetch controller during an ongoing recognition job. Reloading after updates may still interrupt computation; the app resumes from committed checkpoints.
- The Service Worker **cannot continue recognition after a browser tab is closed**. It caches files and serves offline loads only.
- Vite dev mode intentionally skips Service Worker registration. The real offline tests must run against a **built production bundle** using Vite preview.
- The backend may still request external non-cached resources due to its internal loading logic; only running the actual model with the network disabled can validate complete coverage. Worker content and ONNX session startup must be hardware tested.
- `navigator.onLine` is an informational browser hint, not a connectivity guarantee. The status widget deliberately uses cautious terms: “файлы предварительно готовы”.
- The previous PR-25 IndexedDB v2 upgrade remains one-way relative to old builds; do not deploy or roll back without migration checks.

## CI gates

- Existing typecheck, ESLint, Vitest, and production Vite build.
- New unit tests: build manifest includes hashed JS/CSS and compressed WASM, never private audio; missing runtime fails build.
- New unit tests: model cache profile correctness; offline cached responses; no uncached offline fetch; Range requests bypass cached fallback; HTTP failure recovers from exact model cache.
- Existing Playwright mocked-ML acceptance remains unchanged.
- New **production Chromium tests** (separate Playwright config) launch the built site over localhost, install its Service Worker, confirm cached local ONNX runtime, disconnect network, reload app, and recover a local queued audio job; also confirm a GPU-only cache does not pass the q8 WASM readiness gate.

## Remaining validation — NOT TESTED

- User's original 14:31 / 33.3 MB MP3 with real Whisper Small on the target browser/device, truly disconnected from the internet.
- Real Pyannote + WeSpeaker inference, offline, on a long conversation.
- Real WebGPU/WebNN loss and successful offline WASM fallback after a loaded q8 profile.
- Full resource list and CDN redirects on the deployed ChatGPT Site domain; deployment network/security behavior can differ from localhost preview.
- Browser eviction/quota errors and 30/60-minute memory usage.

Do not call the app “guaranteed fully offline” until those hardware and deployment checks pass.
