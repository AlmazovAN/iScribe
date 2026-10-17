# ML feasibility — IS-01

Source: @yourdevice/engine 0.1.1, MIT, pinned in package-lock.json.
The installed package exports dist/worker.js; Vite must resolve it through a
local worker entry (not a bare new URL into node_modules).

## Isolated extension approach

Upstream MODELS and isModelId are closed over Tiny/Base/Small/Distil.
Large v3 requires a version-checked patch to dist/models.js and its declaration,
using onnx-community/whisper-large-v3-ONNX, never Turbo. It remains NOT TESTED.

ensureDiarizer is private. A narrow version-checked patch can export a preload
helper calling releaseAsrPipeline, ensureDiarizer and releaseDiarizer; a wrapper
worker handles its own preload messages. No dummy audio or fake transcription.
Keep upstream ASR-before-diarization memory release behavior.

Patch implementation and regression checks belong in IS-06/IS-07. Patch must
fail closed on version/source mismatch. Retain upstream MIT notice; model
licenses must be checked before integration.

Actual inference, GPU, cache reuse and speaker quality: NOT TESTED.

## IS-06 implementation

scripts/engine-patches.json records exact original and patched SHA-256 hashes;
scripts/patch-engine.mjs applies the narrow patches explicitly before dev,
typecheck, tests and build (npm lifecycle scripts remain disabled).
Unknown engine versions or modified files fail closed. npm ci restores originals.
The published bundle includes the Large v3 registry entry and exact ONNX repo.
Large v3 uses fp16 encoder / q4 merged decoder on accelerated backends, q8 on
WASM under upstream policy. Approximate size metadata is not a download quote;
the selected backend/dtype determines the actual files. An explicit warning
precedes any experimental Large v3 download. This is integration, NOT Gate L.

Gate L: NOT TESTED. Neither successful graph build nor the upstream short
validation clip establishes successful Russian transcription or 8 GB stability.
