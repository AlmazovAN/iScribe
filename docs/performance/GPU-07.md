# GPU-07 — WeSpeaker GPU Acceleration (experiment)

Production patches pin WeSpeaker and Pyannote to WASM/q8. No production model or engine changes are made. The development-only lab uses a locally selected self-contained q8 ONNX graph (<=64 MiB), fixed synthetic FP32 filterbank-like inputs [batch,198,80], and expects a single model input and a selected two-dimensional FP32 embedding output. The 80 mel components are documented by the model preprocessor configuration; graph signature, dynamic batch support and artifact identity are not confirmed. Select the actual embedding output if the model has multiple outputs. The same file is used in all variants; the lab does not verify its identity.

## Run
Close the running iScribe tab, run npm ci and npm run dev on this branch, open /tests/gpu/wespeaker-lab.html. Compare WASM and requested WebGPU for batch sizes 1, 2, 4, 8. Eight identical independent feature examples per sequence; one warmup, three measured sequences. Timings include inference and output availability, exclude input preparation and validation. Separate workers, 120-second whole-variant timeout, stop button, tensor disposal, one fresh WASM batch-1 recovery after WebGPU failure. If WebGPU batch-1 fails, larger WebGPU batches are skipped. JSON includes timings, cosine and pairwise similarity drift, not features or embedding vectors. Preliminary screening: >=1.10x throughput ratio versus single-thread WASM batch-1, minimum cosine >=0.999 and maximum pairwise cosine drift <=0.01 in all measured sequences. Not a real speech quality or release gate.

## Integration gates
Inspect actual pinned engine, model session and preprocessing/output signature. Verify actual operator placement with GPU-01/02. Compare with current production WASM thread policy and actual speaker segments, including variable-length segments and masks. Do not pad/truncate actual segments without verifying model semantics. Measure DER, clustering and speaker assignment accuracy on labeled recordings, overall speaker-pass RTF, memory and recovery. Accept batching only if supported, faster and quality maintained. Keep Pyannote independent, preserve committed ASR, release failed workers and retry WASM once. Do not identify speakers by name or export voice embeddings. No production integration or merge in this draft.

## Verification
12 pure helper assertions passed in tool environment. JavaScript parsed excluding imports and substituting import.meta.url. Added Vitest tests, not run via npm. Actual dependency resolution, model signature, browser, hardware, quality and production acceptance NOT TESTED. No deployment.

Reference: https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/raw/main/preprocessor_config.json
