# GPU-05 — GPU Memory & Data Transfer

## Scope
Existing AsrPayloadPool and ResourceManager manage host PCM and job boundaries, not internal ONNX GPU tensors. The existing external engine remains unchanged. This lab isolates I/O binding before any modification of actual Whisper sessions. It does not integrate a GPU allocator into the production ResourceManager yet.

## Run
Close the running iScribe tab. On the GPU-05 branch run `npm ci` and `npm run dev`, then open `/tests/gpu/io-binding-lab.html` on the local Vite origin. Choose 1, 4 or 16 MiB per tensor. No model download or audio is required: the lab constructs a small ONNX Add(X,X) graph. Three sequential sessions request WebGPU: CPU output after each step; GPU-resident output passed to the next step; preallocated ping-pong buffers plus staging readback. Eight dependent steps, one warmup, three measured runs per variant, exact FP32 final-output validation. The fixed path creates two storage buffers and one staging buffer, reused across runs, released in finally. It checks ORT device buffer limits. All variants include initial input and final host result in timing; relative speed is local to this synthetic workload. Export JSON, no tensor values. Close the isolated tab if execution stalls.

## Accounting
For tensor size B, CPU strategy plans 8 uploads and 8 downloads (16B total); GPU strategies plan one upload and one final download (2B total). These are logical payload estimates, NOT observed bus traffic, actual transfers, VRAM occupancy, or savings in Whisper. Explicit fixed buffers use 3B, excluding ORT and driver allocations. Actual CPU fallback and allocator overhead are unknown. No data leaves the browser during this experiment.

## Release gates
Validate generated graph with actual pinned ONNX Runtime. Run on real devices, then inspect installed engine and actual Whisper encoder/decoder session configuration. Confirm compatible GPU device and ownership before passing tensors across sessions. Integrate with GPU-01/02 diagnostics and GPU-03/04 results, use bounded GPU resource ownership and release on cancellation/recovery/model change, retain PCM/checkpoint semantics, compare full RTF and quality. ResourceManager integration requires observed allocation policy and hardware results; no change to default backend, dtype, model or production UI in this PR.

## Verification
JavaScript syntax parsed excluding imports; 13 pure helper assertions passed in the tool environment with an ASCII-only TextEncoder test double. Added Vitest regression tests, not executed via npm. Actual dependency resolution, ONNX graph validation by ORT, CI, browser, GPU, and production acceptance NOT TESTED. GitHub host resolution failed in the local container; no checkout/dependencies available. No merge or deployment.

Reference: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
