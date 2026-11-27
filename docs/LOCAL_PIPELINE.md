# Local pipeline v7

The launcher fetches the exact script from main using Git and starts it from a temporary directory, passing the existing project directory. It must not execute a candidate script before acceptance.

## Developer protocol
Create a release branch named `codex/<plan>-release-candidate` from current main. Stage PRs target the release branch (or form a stack); preserve stage heads in history, no squash. The final same-repository PR targets main, is non-draft, and contains a single line:

<!-- iscribe-release: {"schema":1,"release_id":"EXAMPLE-001","base_sha":"<40 lowercase hex>","head_sha":"<40 lowercase hex>","stages":[{"id":"EXAMPLE-01","pr":123,"sha":"<40 lowercase hex>"}]} -->

Replace all placeholders with actual SHA values. For a single-stage plan the final PR itself can be the stage. For multi-stage plans list the real stage PRs and exact head SHAs. The manifest lives in the PR body to avoid a self-referencing commit. Update it after any change to base/head. Stage PRs must be non-draft, same-repo, open or merged and their heads must be ancestors of the candidate. A release must contain current main before testing. The script checks the declared stages, not semantic completeness or exclusivity of arbitrary commits; review the final diff.

## Operation
The Auto mode inventories all open PRs, excludes draft/unrelated/experimental/paused/abandoned/development/failed candidates and stale manifests. One manifest-ready candidate is selected automatically if there are no legacy candidates. Otherwise choose a single eligible PR by number. Legacy candidates require explicit selection and confirmation; unattended integration requires a manifest, PR number and SHA. A stale base or conflict stops the run, not an automatic merge of unrelated code. Local CI never dispatches Actions; changes to workflow definitions are blocked in local mode. The existing remote diagnostics privacy gate and read-back verification remain.

No automatic deletion of branches or remote success-report publication in v7. Failure recovery after changed main may require rebuilding from main. Do not upload audio, transcripts or raw private logs. No actual hardware acceptance is claimed. Windows execution and complete end-to-end acceptance are pending.

Playwright 1.56.1 is pinned in devDependencies and package-lock.json. Local CI verifies the locally installed CLI instead of running a second npm install. Chromium installation and all browser checks remain mandatory. Lock entries were reconstructed from matching published lock metadata; Windows npm ci and browser acceptance remain required before integration. The stable v6.4 launcher needs a one-time compatible local bootstrap until this candidate is integrated. Cloud workflow definition is unchanged.
