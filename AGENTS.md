# iScribe development rules

- Work from the current `main`; use one focused pull request per stage.
- Preserve browser-only inference, user audio privacy, and the existing React/TypeScript architecture.
- Never claim real Whisper/WebGPU hardware acceptance from mocked Playwright or Vitest tests.
- Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and the Playwright suite when supported. Record NOT TESTED when unavailable.
- Preserve IndexedDB job/audio/checkpoint compatibility; migrations require explicit tests.
- Keep plain TXT export independent of speaker diarization. A failed speaker pass must not discard committed ASR.
- Do not silently change Whisper model IDs, engine patches, dtype/backend selection, or cache assumptions.
- No private audio/transcripts in commits, CI logs, or test fixtures.
- Update docs/PROJECT_STATUS.md, docs/KNOWN_ISSUES.md, docs/TEST_MATRIX.md for behavioral changes.
- Publishing to production requires real-device acceptance and explicit verification of the deployed version.

## Local release protocol
- One plan has one release branch; stage PRs are merged into that branch using history-preserving merge commits. Do not merge stages directly into main.
- Final PR must target main, use a same-repo `codex/<plan>-release-candidate` branch, be non-draft, and carry the single-line manifest described in docs/LOCAL_PIPELINE.md.
- Keep experiments draft or label experimental/on-hold/abandoned. Never auto-integrate them or close unrelated work.
- CI and Pages workflows remain manual only. No Actions dispatch without explicit user request.
- Publish the exact locally tested commit; never bypass branch rules. Update manifest SHAs after any candidate or base change.
