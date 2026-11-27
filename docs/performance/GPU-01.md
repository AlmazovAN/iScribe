# GPU-01: experimental WebGPU profiler

Opt-in build: set VITE_GPU_PROFILE=1 before npm run build (or build:web). Default builds do not enable profiling. In PowerShell: `$env:VITE_GPU_PROFILE='1'; npm run build`; remove the environment variable afterwards with `Remove-Item Env:VITE_GPU_PROFILE`.

Open browser DevTools, enable worker console messages, run a short Whisper recording and filter for `[iscribe:gpu-profile]`. Each JSON record contains ORT version of profiling event, kernel ID/type/name, program name and raw start/end timestamps. No audio or transcript is exported. Raw timestamp units must be checked against the pinned ORT implementation before conversion. Positive GPU kernel events demonstrate GPU work, not GPU utilization percentage or absence of CPU fallback. Missing events are inconclusive. Detailed logging can distort timing; use ordinary builds for baseline throughput.

This draft is only the first instrumentation increment. Still required: verify callback types against pinned dependencies, adapter identity from actual ORT device, bounded aggregation, encoder/decoder attribution, generated token count, per-window timing and JSON export through diagnostics, CPU operator audit, failure isolation and hardware acceptance. Do not merge until typecheck, lint, tests, build and appropriate browser acceptance pass. No tests or hardware runs performed in this change session.

Reference: https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html
