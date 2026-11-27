# GPU-03 — Whisper Encoder optimization experiment

## Static audit
The existing ModelManager keeps one initialized model session until release/recovery or backend/model changes. The queue already prefetches up to two audio windows. The defensive PCM copy must remain because transfer may detach the input and retries require the original audio. None of these facts establish reuse of intermediate GPU tensors inside the external engine.

## Isolated test
The development-only page `tests/gpu/encoder-lab.html` uses the pinned ONNX Runtime Web package, not the normal transcription pipeline. Close the running iScribe tab, run `npm ci` and `npm run dev`, then open `/tests/gpu/encoder-lab.html` on the local Vite origin. Choose a self-contained Whisper encoder ONNX file (float32 input/output, no external data, <=512 MiB) and matching architecture preset. Models outside these constraints are not covered. No private audio is required, and no files or activations are exported. The experiment is not included in the production standalone HTML.

The baseline and candidate both use the same fixed input and output GPU-buffer strategy, with separate sequential sessions; only enableGraphCapture changes. One warm-up, then three measured runs with distinct deterministic synthetic feature tensors. Timed interval includes input upload, session.run and queue completion; output readback is excluded equally. Full float32 output arrays are compared for finite values and elementwise tolerance (absolute 0.001 + relative 0.001). Also check that baseline reacts to changed input, to guard against obvious stale output. Download JSON with timings and parity; no tensor values. A candidate is flagged for further testing only if parity and changing-input checks pass and median speedup is at least 1.10. This threshold is an engineering proposal, not acceptance. Failures are reported as failed, not as zero duration. Close/reload the isolated page if a GPU run stalls.

## Integration gates
Graph Capture requires compatible static shapes and WebGPU operator coverage. Test with actual pinned model graph/dtype on the target device, repeat with real speech features, check full pipeline WER and RTF, verify recovery, GPU memory, and cold/warm timing before changing production. Do not apply a global session option to the dynamic autoregressive decoder. Batch size changes and alternative dtypes are separate experiments. A synthetic benchmark cannot establish production acceleration or absence of CPU fallback. GPU-01/02 drafts remain independent prerequisites for the production integration.

## Verification
The committed JavaScript was parsed after stripping module import declarations in the tool environment. Five pure helper assertions passed (median, equal arrays, different synthetic inputs, NaN and mismatched shapes). This is not a browser build, lint, dependency resolution, GPU execution, or hardware acceptance. Those remain NOT TESTED because the local environment cannot fetch the repository or npm dependencies. No changes to the production runtime, model, UI, or build configuration.

Reference: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
