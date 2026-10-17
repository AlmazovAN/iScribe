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
