# GPU-06 — Pyannote GPU Acceleration (experiment)

The production engine patches pin Pyannote segmentation and WeSpeaker to WASM/q8. This independent development-only lab does not alter those patches or the speaker pipeline. It tests the same locally selected self-contained q8 Pyannote ONNX graph with WASM (one thread) and requested WebGPU. The user must verify that the selected file is the same model_quantized.onnx as production; the lab checks signature and size, not file identity. Both variants use identical synthetic 10-second PCM windows, one warmup and three measured runs. No private audio or network upload. Model signature must be input_values [1,1,160000], logits [1,frames,7].

## Run
Close the running iScribe tab. On this branch run npm ci and npm run dev; open /tests/gpu/pyannote-lab.html on the local Vite origin. Choose the locally available model_quantized.onnx (<=64 MiB). Each backend runs in a separate disposable worker with a 120-second whole-variant timeout; on WebGPU failure a fresh WASM worker is tried once. This is lab-only recovery, not an actual change to production. JSON exports timing, frame-class agreement and logit differences, not audio or logits. A proposed threshold for further testing is >=99% frame argmax agreement, mean absolute logit difference <=0.01 and >=1.10x median speed ratio. These are engineering screening criteria, not DER or a release gate. Successful requested WebGPU is not proof of actual GPU placement. The WASM reference is single-threaded; compare against actual production thread policy before drawing a speed conclusion.

## Integration gates
Verify actual operator placement and runtime GPU events with GPU-01/02; investigate unsupported operators and quantized kernels. Test same artifact and actual processor, diarizer thresholds and real speech windows (including overlap and silence); measure DER and unassigned/wrong labels with human reference, end-to-end speaker time, memory, offline cache and cancellation. Integrate GPU only when faster and quality is maintained; ensure a fresh WASM retry preserves committed ASR and doesn't loop. Do not silently change dtype or WeSpeaker. No production changes in this draft.

## Verification
10 pure helper assertions passed in the tool environment. JavaScript parsed excluding imports and substituting import.meta.url. Added Vitest regression tests, not run via npm. Actual dependency resolution, pinned ORT compatibility, browser/worker execution, hardware, quality and production acceptance NOT TESTED. No merge or deployment.

References: https://huggingface.co/onnx-community/pyannote-segmentation-3.0 and https://onnxruntime.ai/docs/tutorials/web/
