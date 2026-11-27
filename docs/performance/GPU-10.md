# GPU-10 — integrated release candidate

Base: `d76f6e426647ab7b2b9bf8efdb8ace12da568b79`. Integrates PRs #58–66 without enabling experimental GPU model settings. Prior stage docs retain historical verification statements. Individual exact-head CI runs were verified successful on 2026-11-27:

| PR | Head | CI run |
|---|---|---|
| #58 | `569b385737f394e445c254f6bbc775510dd20ac4` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45949322114) |
| #59 | `e98e3a9b4c67d25905c4aee83736853e1add689f` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45949467385) |
| #60 | `05bcb9230721939112845941b27fe89e8a9ac281` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45949670943) |
| #61 | `187ea90e938e29f8fdad126fbe7206c8c4a79b69` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45950050440) |
| #62 | `486a872fadf2af95e3beec63f1e5c4a2af03e731` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45950268299) |
| #63 | `382c5a420d9b19653189adb6a118309cd8b40c9c` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45951762544) |
| #64 | `9b5e2c36ae48f7c81f31ed7e26b0f968178b30b6` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45953623668) |
| #65 | `e5872b6896cd787a170f84f91bc2ffc08cfc17f0` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45954947269) |
| #66 | `1e5b99857e656e7e4da86fcd0800d6e33cdcd1f0` | [success](https://github.com/AlmazovAN/iScribe/actions/runs/45959196992) |

Five shared files merged against the common base: DiagnosticsPanel, JobRunner, and the three status/known-issues/test-matrix documents. Existing GPU profiling is opt-in. The production speaker backend is still WASM/q8; encoder/decoder/buffer/Pyannote/WeSpeaker labs are development-only, not production optimizations. Early scheduling and adaptive prefetch are actual host-side runtime changes. No actual GPU throughput, WER, DER or memory benefit established.

## Local hardware procedure

Run npm ci, npm run dev; open `/tests/gpu/` pages from the local Vite origin: encoder-lab.html, decoder-lab.html, io-binding-lab.html, pyannote-lab.html, wespeaker-lab.html. Follow GPU-03–07 model/shape restrictions. Export numeric JSON only. Compare exact same real speech on prior build and candidate, same model, language, backend, performance mode, cold and warm runs, at least three repeats; include 14:31, 35:38 and 63:54, cancellation/recovery and committed checkpoint checks. Capture RTF, WER, DER, memory and actual GPU evidence. No private audio or transcripts in GitHub. Run npm run build and npm run release:check to create local dist/iScribe.html. Do not publish without real-device acceptance. Combined CI pending at creation; local git network DNS failure prevents local checkout. Hardware NOT TESTED.
