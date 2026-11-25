# Test matrix

PASS means an observed execution, not merely code presence. NOT TESTED is the initial status for hardware tests below.

| Gate | Test | Expected result | Status |
| --- | --- | --- | --- |
| CI-1 | npm ci, typecheck, lint, Vitest, build | All commands succeed on current SHA | NOT TESTED |
| CI-2 | Playwright browser acceptance with deterministic ML stub | Reload, checkpoint, TXT exports pass | NOT TESTED |
| HW-1 | Real Whisper Small, ru, 14:31 MP3 | 35 windows complete; TXT export | NOT TESTED |
| HW-2 | Reload after two committed windows | Resume without duplicate text | NOT TESTED |
| HW-3 | Real GPU error and WASM fallback | Bounded retry, truthful backend | NOT TESTED |
| HW-4 | Offline reload with cached weights/runtime | ASR succeeds without network | NOT TESTED |
| HW-5 | Diarization on reference audio | Measured coverage and speaker quality | NOT TESTED |
| HW-6 | Memory and long-audio 30/60 minutes | No uncontrolled growth or lost checkpoints | NOT TESTED |

For each run record commit SHA, OS/browser, GPU/RAM, model/backend, audio length, checkpoint, duration, logs (redacted), outcome and reproducibility. Keep personal audio out of GitHub.
