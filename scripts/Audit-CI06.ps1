# CI-06 live audit: read-only GitHub API calls. No workflow dispatch, no merge.
[CmdletBinding()]
param([string]$Repository='AlmazovAN/iScribe',[string]$DiagnosticsRepo='AlmazovAN/iScribe-diagnostics')
$ErrorActionPreference='Stop'
if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw 'gh.exe is required' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository name' }
function Read-Api([string]$Endpoint) {
    $old=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        $out=& gh.exe api --method GET $Endpoint 2>$null
        if ($LASTEXITCODE -ne 0) { return @{ok=$false;data=$null} }
        return @{ok=$true;data=(($out | Out-String) | ConvertFrom-Json)}
    } catch { return @{ok=$false;data=$null} }
    finally { $ErrorActionPreference=$old }
}
$script:Unknown=0
function Unknown([string]$Message) { $script:Unknown++; Write-Warning $Message }
$branch=Read-Api "repos/$Repository/branches/main"
if ($branch.ok) {
    Write-Host "main protected flag: $($branch.data.protected)"
    Write-Host "main SHA: $($branch.data.commit.sha)"
} else { Unknown 'Cannot read main branch metadata' }
$rules=Read-Api "repos/$Repository/rules/branches/main"
if ($rules.ok) {
    $types=@($rules.data | ForEach-Object {$_.type})
    Write-Host ('Effective ruleset types: '+($types -join ', '))
    foreach ($rule in @($rules.data | Where-Object {$_.type -eq 'required_status_checks'})) {
        Write-Host ('Required contexts (ruleset): '+(@($rule.parameters.required_status_checks | ForEach-Object {$_.context}) -join ', '))
    }
    if ($types -contains 'pull_request' -or $types -contains 'required_status_checks') {
        Write-Warning 'Direct local push may be blocked by rulesets. Do not bypass these rules.'
    }
} else { Unknown 'Cannot read effective branch rulesets' }
$classic=Read-Api "repos/$Repository/branches/main/protection"
if ($classic.ok) {
    Write-Host ('Classic required contexts: '+(@($classic.data.required_status_checks.contexts) -join ', '))
    Write-Host "Classic strict status checks: $($classic.data.required_status_checks.strict)"
    Write-Host "Classic required PR review: $($null -ne $classic.data.required_pull_request_reviews)"
    Write-Host "Classic enforce admins: $($classic.data.enforce_admins.enabled)"
    if ($classic.data.required_status_checks -or $classic.data.required_pull_request_reviews) {
        Write-Warning 'Local direct push or manual workflow checks may be blocked by classic protection.'
    }
} elseif (-not $branch.ok -or $branch.data.protected -ne $false) {
    Unknown 'Classic protection details not readable; do not assume there are no restrictions'
} else { Write-Host 'Classic protection endpoint not readable; branch protected flag is false' }
$workflows=Read-Api "repos/$Repository/actions/workflows?per_page=100"
if ($workflows.ok) {
    Write-Host 'Workflow inventory (first page):'
    foreach ($w in @($workflows.data.workflows)) { Write-Host "  $($w.path) state=$($w.state)" }
    if ($workflows.data.total_count -gt 100) { Unknown 'Workflow inventory truncated' }
    $extra=@($workflows.data.workflows | Where-Object { $_.state -eq 'active' -and $_.path -notin @('.github/workflows/ci.yml','.github/workflows/pages.yml') })
    if ($extra.Count -gt 0) { Unknown 'Additional active workflow detected; inspect its triggers' }
} else { Unknown 'Cannot read workflow inventory' }
$runs=Read-Api "repos/$Repository/actions/runs?per_page=100"
if ($runs.ok) {
    Write-Host 'Recent workflow runs (up to 100, no new runs requested):'
    foreach ($r in @($runs.data.workflow_runs)) { Write-Host "  $($r.id) event=$($r.event) status=$($r.status) created=$($r.created_at) sha=$($r.head_sha)" }
    if ($runs.data.total_count -gt 100) { Write-Host 'Older runs not included' }
} else { Unknown 'Cannot read Actions run history' }
$diag=Read-Api "repos/$DiagnosticsRepo"
if ($diag.ok -and $diag.data.private -eq $true -and $diag.data.visibility -eq 'private' -and $diag.data.permissions.push -eq $true -and $diag.data.archived -ne $true) {
    Write-Host 'Diagnostics repo: private and writable (no file written)'
} else { Unknown 'Diagnostics repo not confirmed private and writable' }
Write-Host "CI-06 READ-ONLY AUDIT: $script:Unknown unresolved checks"
if ($script:Unknown -ne 0) { exit 2 }
exit 0
