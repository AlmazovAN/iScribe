# PERF-06 — Memory Optimization

## Implemented
- Non-16 kHz full decode: use the original mono AudioBuffer as the offline source; for multichannel input, mix directly into the resampling AudioBuffer. Streaming: mix directly into the resampling AudioBuffer instead of a temporary Float32Array and copyToChannel. Preserve the same Web Audio resampling, sample positions, overlap and per-channel accumulation.
- A single per-job exact-size host ASR dispatch buffer may be reused after a successful settled request if it was not detached. Copy the authoritative PCM into it on each dispatch; failed/timed-out requests are never reused. The external EngineClient owns its transport; actual cloning/transfer behavior is not changed. Do not detach original audio or lose retry input. Calibration uses a view of the existing source, with private dispatch copies.
- Speaker transfer compacts subviews to avoid transferring unrelated backing bytes or detaching their owner. Existing full-buffer transfer and clone fallback remain.
- ModelManager tracks the ASR Worker, clears references and explicitly terminates it even if EngineClient.dispose throws. Cancellation and failure release idle sessions; model replacement/recovery still creates only one active ASR session. Speaker workers retain existing disposal path.
- After the queue drains, unload idle ASR in eco, on reported <=8 GiB or unknown memory, or for Large v3. Retain the model during the queue and on high-memory medium/max for reuse. Manual preparation remains resident until work completes or user cancels. Model cache is not deleted.
- Numeric diagnostics: allocation/reuse counts, payload copy bytes, detached successful payloads, peak dispatch size, idle release success/failure. Not measurements of process RAM, VRAM, or OS reclamation.

## Limits
Standalone runtime binary retains the original buffer to support replacement workers; cloning that binary is unchanged. No engine protocol patch or assumed zero-copy ASR transfer. No forced garbage collection, new memory limits, model/dtype changes, or decoder rotation changes. Native memory release and real audio equality require hardware tests; browser may retain internal buffers. Unknown memory hint uses conservative release; restarting a job may incur model initialization cost. No speedup/RAM savings claimed without PERF-09.

Tests added for direct full resampling, mixing equivalence, subview transfer, pool reuse/detachment, model release, and runner checkpoint preservation. Full CI and real-device validation NOT TESTED until actual results.
