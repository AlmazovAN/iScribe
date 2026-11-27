# GPU-04 — Decoder & KV Cache experiment

## Scope
Production inference still uses the pinned external engine (0.1.1) and Transformers.js (4.3.1). The actual decoder session configuration and cache residency have not been verified from installed dependency sources. No production inference changes are made. Existing model selection, generation options, timestamps and recovery behavior are unchanged.

## Isolated experiment
Close the running iScribe tab, run `npm ci` and `npm run dev`, then open `/tests/gpu/decoder-lab.html` on the local Vite origin. Choose a self-contained merged Whisper decoder ONNX file with FP32 inputs/outputs and conventional past_key_values/present names, <=512 MiB, and the matching Tiny/Small/Large v3 preset. Graphs with external weights, other signatures or dtypes are not covered. No private audio is needed. Both sessions request WebGPU; baseline asks for CPU cache outputs, candidate asks for GPU-buffer cache outputs using preferredOutputLocation. Logits are on CPU in both. Each sequence starts with empty caches and synthetic encoder features, feeds the same eight fixed token IDs, reuses present tensors, retains a previous cross-attention cache if the graph emits an empty placeholder, checks nonempty cache shapes and locations, and disposes owned tensors and the session. No cache crosses independent sequences. One warm-up and three measured sequences per variant. Timings include run, queue completion and logits availability, exclude validation. Steps/s is not end-to-end generated tokens/s.

Compare every measured logit element for finite values and abs 0.001 + rel 0.001 tolerance, plus argmax agreement. JSON exports timings, cache location categories, parity and speed ratio only; no tokens, logits, filename or tensors. A 1.10x speed ratio plus numerical parity is a proposed threshold for further testing, not production acceptance. No claim is made about CPU fallback or measured VRAM. A stalled run can be stopped by closing the isolated tab.

## Integration gates
Verify actual pinned engine and model graph, compare current production cache policy with the experimental policy (current behavior may already retain caches on GPU), measure real decoder tokens/s and RTF with real speech and identical generation settings. Verify timestamp fidelity, WER, memory stability, cancellation, recovery and model changes. Keep logits and required host-side generation operations available on CPU. Do not retain cache across independent windows, recovery or a changed model. Do not apply a static Graph Capture option to a dynamically growing cache without proof of compatibility. Integrate with GPU-01/02 telemetry after their acceptance.

## Verification
JavaScript parsed after excluding module imports. Ten pure helper assertions passed in the tool environment (signature mapping/rejection, median, parity/mismatch/nonfinite/different lengths, cache shape, residency predicate, fixed token). No dependency resolution, npm CI, typecheck, lint, build, browser or GPU execution: NOT TESTED. Container cannot resolve GitHub host; no repository/dependency checkout is available. The lab is development-only, not part of standalone HTML. Draft only; no merge or deployment.

Reference: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
