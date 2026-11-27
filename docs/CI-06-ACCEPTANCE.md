# CI-06 acceptance — V6.4
Date: 2026-11-27. Production script blob: `617af9882334c5ef9c2ba31810eb49ceb581068e`.

## Evidence obtained

- Read `main` CI and Pages workflow definitions: both use only workflow_dispatch; all three CI jobs remain.
- GitHub connector reports no PR-triggered workflow runs for V6.4 commit 32ca880 and test-harness commit c5a0f53. The connector filters to pull_request runs, so this is not evidence that no other event triggered runs.
- Four real, isolated local Git checks passed: merge tree equals candidate tree when base is unchanged; stale non-fast-forward push is rejected and remote preserved; merging on an advanced base reproduces a different tree; Git blob SHA reference vector for hello + LF.
- No workflow was dispatched in this acceptance session. No real build, application hardware acceptance, integration PR merge, or diagnostic upload was performed.
- GitHub diagnostics repo returned 404; existence vs insufficient access is unresolved. Main branch protection and complete run inventory unavailable through current connector.
- PowerShell and gh unavailable in current execution environment; direct git access to GitHub failed DNS. The added PowerShell harness was reviewed but **not executed**.

## Local instructions (from the root of a clean main checkout)

```powershell
git switch main
git pull --ff-only origin main
.\scripts\Test-CI06.ps1
.\scripts\Audit-CI06.ps1
.\iScribe-Update-Build.ps1 -Mode DiagnosticsSetup
```

Test-CI06 parses the production script, loads named functions only, substitutes external commands, and checks 28 scenarios plus parser acceptance. It does not execute the production entry point, invoke npm/git/gh, or dispatch workflows. Audit-CI06 uses GET requests only to inspect classic protection, rulesets, workflow inventory, recent runs and diagnostic permissions. DiagnosticsSetup is an explicit write operation: it may create a private repo and writes a synthetic check, then reads back the matching Git blob SHA. After setup, DiagnosticsCheck repeats the check without creating a repository.

## Acceptance matrix

| Gate | State |
| --- | --- |
| Known workflow definitions manual-only | PASS by inspection |
| Isolated Git semantics | PASS, four checks |
| PowerShell parser and 28 mocked scenarios | NOT RUN |
| Effective main protection and all active workflows | UNVERIFIED |
| Actual local CI on a candidate | NOT RUN |
| Actual manual Actions run and correct SHA/job binding | NOT RUN; explicit authorization only |
| Diagnostics create/write/read and connector access | BLOCKED, repo 404 |
| No unintended run events in entire live history | UNVERIFIED |

## Open defect before final acceptance

V6.4 online route checks current base before invoking gh pr merge --match-head-commit, but that option pins only the PR head. A concurrent main update between the check and merge may cause the server to merge a tree different from the one tested. The post-merge tree comparison prevents installing an unverified HTML, but cannot undo the already changed main. Reproduced the underlying Git tree difference locally. Do not mark online integration accepted until a reviewed approach closes this race (e.g. exact tested merge commit and normal fast-forward push when protection allows, or suitable server-side policy). Do not bypass main protection.

If branch rules require PR-only updates or required status checks that cannot be met locally, the local direct push may be blocked by design; explicitly decide the integration policy before altering protection. Do not disable existing rules automatically.

CI-06 is partially verified, not complete. CI-07 should record the final accepted procedure after these gates are closed.
