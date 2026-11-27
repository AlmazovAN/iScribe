# CI-06 acceptance harness. Windows PowerShell 5.1 / PowerShell 7.
# No production entry point is executed. All remote/build operations are mocked.
[CmdletBinding()]
param([string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) 'iScribe-Update-Build.ps1'))
$ErrorActionPreference='Stop'
$script:Pass=0
$script:Fail=0
function Check([string]$Name,[scriptblock]$Body) {
    try { & $Body; $script:Pass++; Write-Host "PASS $Name" -ForegroundColor Green }
    catch { $script:Fail++; Write-Host "FAIL $Name : $($_.Exception.Message)" -ForegroundColor Red }
}
function Equal($Actual,$Expected) {
    if ($Actual -cne $Expected) { throw "Expected [$Expected], got [$Actual]" }
}
function Throws([scriptblock]$Body) {
    $caught=$false
    try { $null=& $Body } catch { $caught=$true }
    if (-not $caught) { throw 'Expected an exception' }
}
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Host $_ }; exit 1 }
Write-Host 'PASS PowerShell parser'
$script:Pass++
$wanted=@('Add-DiagnosticEvent','Get-DiagnosticCode','Get-DiagnosticCommand','ConvertTo-SafeLogLine','Get-SafeLogExcerpt','Get-ApiFailureKind','Invoke-GhApiRead','Gh-Json','Get-GitBlobSha','Get-DiagnosticRemoteState','Get-VerifiedDiagnosticRepo','Upload-DiagnosticJournal','Save-DiagnosticJournal','Start-CloudCI','Get-CIState','Wait-CI','Run-LocalCI','Build-Only','Assert-CurrentCandidate','Assert-PRIdentity')
# Load only named top-level function definitions, never the main script.
foreach ($name in $wanted) {
    $nodes=@($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name })
    if ($nodes.Count -ne 1) { throw "Missing or ambiguous function: $name" }
    . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$rules=@($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$script:SafeDiagnosticRules' })
if ($rules.Count -ne 1) { throw 'Diagnostic rules assignment missing' }
. ([scriptblock]::Create($rules[0].Extent.Text))
$script:DiagnosticEvents=[System.Collections.Generic.List[object]]::new()
$script:DiagnosticOmitted=0
$script:DiagnosticStage='self-test'
$script:DiagnosticRoute='diagnostics-check'
$script:Revision='unknown'
$script:PinnedSha='a'*40
$script:BaseSha='b'*40
$script:SelectedPR=99
$script:RemoteChanged=$false
$script:CiRequestId=$null
$script:CiRunId=$null
$script:CiBranch=$null
$script:Repository='AlmazovAN/iScribe'
$script:DiagnosticsRepo='AlmazovAN/iScribe-diagnostics'
$script:UploadDiagnostics=$true
$script:NoUploadDiagnostics=$false
$script:IntegrationBranch=$null
$script:ExpectedHeadSha=$null
$script:CiTimeoutMinutes=1
$script:Calls=[System.Collections.Generic.List[string]]::new()
$script:Queue=[System.Collections.Generic.Queue[object]]::new()
$script:FailCommand=''
function Log([string]$Message) {}
function Step([string]$Name) {}
function Assert-CleanTracked {}
function Run([string]$Exe,[string[]]$Arguments) {
    $call=$Exe+' '+($Arguments -join ' ')
    $script:Calls.Add($call)
    if ($script:FailCommand -and $call -like $script:FailCommand) { throw 'synthetic command failure' }
}
function Git-Text([string[]]$GitArgs) { return ('c'*40) }
function Wait-ApiRetry([int]$Attempt) { $script:Calls.Add("retry $Attempt") }
function Start-Sleep { param([int]$Seconds) } # no real waits in mocked tests
function Invoke-GhApiOnce([string[]]$CliArgs) {
    $script:Calls.Add(($CliArgs -join ' '))
    if ($script:Queue.Count -eq 0) { throw 'Unexpected API call' }
    return $script:Queue.Dequeue()
}
function Response([string]$Kind,[string]$Text='') {
    return @{Kind=$Kind;Text=$Text;ExitCode=$(if ($Kind -eq 'success') {0} else {1})}
}
Check 'API classification' {
    Equal (Get-ApiFailureKind 'gh: Not Found (HTTP 404)') 'not-found'
    Equal (Get-ApiFailureKind 'gh: HTTP 503') 'transient'
    Equal (Get-ApiFailureKind 'gh: HTTP 401') 'permanent'
    Equal (Get-ApiFailureKind 'gh: HTTP 403 rate limit') 'rate-limited'
    Equal (Get-ApiFailureKind 'dial tcp: connection reset') 'transient'
}
Check 'GET retry succeeds on third attempt' {
    $script:Calls.Clear(); $script:Queue.Clear()
    $script:Queue.Enqueue((Response transient)); $script:Queue.Enqueue((Response transient)); $script:Queue.Enqueue((Response success '{}'))
    Equal (Invoke-GhApiRead 'repos/example').Kind 'success'
    Equal @($script:Calls | Where-Object {$_ -like 'api -X GET *'}).Count 3
    Equal @($script:Calls | Where-Object {$_ -like 'retry *'}).Count 2
}
Check 'GET permanent and unknown failure do not retry' {
    foreach ($kind in @('permanent','unknown','not-found','rate-limited')) {
        $script:Calls.Clear(); $script:Queue.Clear()
        $script:Queue.Enqueue((Response $kind))
        Equal (Invoke-GhApiRead 'repos/example').Kind $kind
        Equal $script:Calls.Count 1
    }
}
Check 'GET retry limit' {
    $script:Calls.Clear(); $script:Queue.Clear()
    1..3 | ForEach-Object { $script:Queue.Enqueue((Response transient)) }
    Equal (Invoke-GhApiRead 'repos/example').Kind 'transient'
    Equal @($script:Calls | Where-Object {$_ -like 'api -X GET *'}).Count 3
}
Check 'Git blob hash known vector' {
    Equal (Get-GitBlobSha ([Text.Encoding]::ASCII.GetBytes("hello" + [char]10))) 'ce013625030ba8dba906f756967f9e9ca394464a'
}
Check 'privacy filter allowed technical fields' {
    Equal (ConvertTo-SafeLogLine 'C:\Users\Example\private.ts(12,3): error TS2322: private text') 'TypeScript TS2322; line 12, column 3'
    Equal (ConvertTo-SafeLogLine 'npm error code ERESOLVE') 'npm error code ERESOLVE'
    Equal (ConvertTo-SafeLogLine '42 passed (12.2s)') 'Tests: 42 passed'
    Equal (ConvertTo-SafeLogLine 'HTTP 404 at https://private.invalid/a') 'HTTP 404'
}
Check 'privacy filter rejects secret and arbitrary lines' {
    foreach ($line in @('Authorization: Bearer synthetic-only-0000 HTTP 403','password=synthetic HTTP 404','github_pat_FAKEEXAMPLE HTTP 404','sk-proj-FAKEEXAMPLE HTTP 404','person@example.invalid HTTP 404','+ git.exe fetch https://user:pass@private.invalid','unknown private text','C:\Users\Example\private.txt')) {
        Equal (ConvertTo-SafeLogLine $line) $null
    }
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('iscribe-ci06-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $raw=Join-Path $temp 'fixture.log'
    [IO.File]::WriteAllLines($raw,[string[]]@('HTTP 404','-----BEGIN PRIVATE KEY-----','HTTP 500','-----END PRIVATE KEY-----','example.ts(12,3): error TS2322: secret text','unknown private line'),[Text.UTF8Encoding]::new($false))
    Check 'multiline secret block and original unchanged' {
        $before=(Get-FileHash -LiteralPath $raw -Algorithm SHA256).Hash
        $result=Get-SafeLogExcerpt $raw
        Equal $result.lines.Count 2
        Equal $result.lines[0].message 'HTTP 404'
        Equal $result.lines[1].message 'TypeScript TS2322; line 12, column 3'
        Equal (Get-FileHash -LiteralPath $raw -Algorithm SHA256).Hash $before
    }
    $journal=Save-DiagnosticJournal $raw -SelfTest
    Check 'synthetic journal contains no arbitrary source text' {
        $text=[IO.File]::ReadAllText($journal)
        $report=$text | ConvertFrom-Json
        Equal $report.outcome 'self-test'
        Equal $report.text_excerpt.lines.Count 2
        Equal ($text -match 'unknown private line|example\.ts|secret text|BEGIN PRIVATE KEY') $false
    }
    Check 'read-back matched, absent, conflict and unknown' {
        $script:Queue.Clear()
        $sha='d'*40
        $script:Queue.Enqueue((Response success ('{"type":"file","sha":"'+$sha+'"}')))
        $script:Queue.Enqueue((Response not-found))
        $script:Queue.Enqueue((Response success '{"type":"file","sha":"different"}'))
        $script:Queue.Enqueue((Response unknown))
        Equal (Get-DiagnosticRemoteState 'repos/example/contents/a' 'main' $sha) 'matched'
        Equal (Get-DiagnosticRemoteState 'repos/example/contents/a' 'main' $sha) 'absent'
        Equal (Get-DiagnosticRemoteState 'repos/example/contents/a' 'main' $sha) 'conflict'
        Equal (Get-DiagnosticRemoteState 'repos/example/contents/a' 'main' $sha) 'unknown'
    }
    Check 'private repository gate rejects public repo' {
        $script:Queue.Clear()
        $script:Queue.Enqueue((Response success '{"full_name":"AlmazovAN/iScribe-diagnostics","private":false,"visibility":"public","permissions":{"push":true},"default_branch":"main"}'))
        Equal (Get-VerifiedDiagnosticRepo) $null
    }
    Check 'private repository gate accepts private writable repo' {
        $script:Queue.Clear()
        $script:Queue.Enqueue((Response success '{"full_name":"AlmazovAN/iScribe-diagnostics","private":true,"visibility":"private","permissions":{"push":true},"default_branch":"main"}'))
        Equal (Get-VerifiedDiagnosticRepo).default_branch 'main'
    }
    # Override only the external dependencies for upload. No gh executable is invoked.
    function Get-Command { param([string]$Name,$ErrorAction); if ($Name -eq 'gh.exe') { return 'mock-gh' }; throw 'Unexpected command discovery' }
    function Get-VerifiedDiagnosticRepo { return @{default_branch='main'} }
    $script:States=[System.Collections.Generic.Queue[string]]::new()
    function Get-DiagnosticRemoteState([string]$Path,[string]$Branch,[string]$ExpectedSha) {
        $script:Calls.Add('state '+$Path)
        return $script:States.Dequeue()
    }
    Check 'upload success requires read-back' {
        $script:Calls.Clear(); $script:Queue.Clear(); $script:States.Clear()
        $script:States.Enqueue('absent'); $script:States.Enqueue('matched')
        $script:Queue.Enqueue((Response success '{}'))
        Equal (Upload-DiagnosticJournal $journal) $true
        Equal @($script:Calls | Where-Object {$_ -like 'api -X PUT *'}).Count 1
        Equal @($script:Calls | Where-Object {$_ -like 'state *'}).Count 2
    }
    Check 'ambiguous PUT already committed is not repeated' {
        $script:Calls.Clear(); $script:Queue.Clear(); $script:States.Clear()
        $script:States.Enqueue('absent'); $script:States.Enqueue('matched')
        $script:Queue.Enqueue((Response transient))
        Equal (Upload-DiagnosticJournal $journal) $true
        Equal @($script:Calls | Where-Object {$_ -like 'api -X PUT *'}).Count 1
    }
    Check 'transient PUT confirmed absent retries same path' {
        $script:Calls.Clear(); $script:Queue.Clear(); $script:States.Clear()
        @('absent','absent','absent','matched') | ForEach-Object { $script:States.Enqueue($_) }
        $script:Queue.Enqueue((Response transient)); $script:Queue.Enqueue((Response success '{}'))
        Equal (Upload-DiagnosticJournal $journal) $true
        $puts=@($script:Calls | Where-Object {$_ -like 'api -X PUT *'})
        Equal $puts.Count 2
        Equal $puts[0] $puts[1]
    }
    Check 'unknown read-back stops upload' {
        $script:Calls.Clear(); $script:Queue.Clear(); $script:States.Clear()
        $script:States.Enqueue('absent'); $script:States.Enqueue('unknown')
        $script:Queue.Enqueue((Response transient))
        Equal (Upload-DiagnosticJournal $journal) $false
        Equal @($script:Calls | Where-Object {$_ -like 'api -X PUT *'}).Count 1
    }
    Check 'existing conflicting file is never overwritten' {
        $script:Calls.Clear(); $script:Queue.Clear(); $script:States.Clear()
        $script:States.Enqueue('conflict')
        Equal (Upload-DiagnosticJournal $journal) $false
        Equal @($script:Calls | Where-Object {$_ -like 'api -X PUT *'}).Count 0
    }
    Check 'upload disabled performs no API calls' {
        $script:Calls.Clear()
        $script:NoUploadDiagnostics=$true
        try { Equal (Upload-DiagnosticJournal $journal) $false } finally { $script:NoUploadDiagnostics=$false }
        Equal $script:Calls.Count 0
    }
    Remove-Item Function:\Get-Command
} finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
Check 'local route invokes 12 expected commands, zero Actions' {
    $script:Calls.Clear()
    $old=$env:CI
    Run-LocalCI
    Equal $script:Calls.Count 12
    Equal @($script:Calls | Where-Object {$_ -like 'gh.exe *'}).Count 0
    Equal $env:CI $old
}
Check 'local failure stops remaining tests' {
    $script:Calls.Clear(); $script:FailCommand='npm.cmd run lint'
    try { Throws { Run-LocalCI } } finally { $script:FailCommand='' }
    Equal $script:Calls.Count 3
}
Check 'cloud dispatch once and duplicate blocked' {
    $script:Calls.Clear(); $script:CiRequestId=$null
    Start-CloudCI @{head=@{ref='codex/synthetic-release-candidate'}}
    Equal @($script:Calls | Where-Object {$_ -like 'gh.exe workflow run ci.yml*'}).Count 1
    Throws { Start-CloudCI @{head=@{ref='codex/synthetic-release-candidate'}} }
    Equal $script:Calls.Count 1
}
# Mock only API response objects for the production CI state function.
$script:FakeRun=@{name='CI';event='workflow_dispatch';display_title=('CI / '+$script:CiRequestId);head_branch=$script:CiBranch;head_sha=$script:PinnedSha;id=123;run_attempt=1;status='completed';conclusion='success';html_url='https://example.invalid/run'}
$script:FakeJobs=@('verify','browser-acceptance','build') | ForEach-Object { @{name=$_;status='completed';conclusion='success'} }
function Gh-Json([string[]]$CliArgs) {
    if ($CliArgs[1] -like '*/jobs?*') { return @{jobs=$script:FakeJobs} }
    if ($CliArgs[1] -like '*/runs?*') { return @{workflow_runs=@($script:FakeRun)} }
    return $script:FakeRun
}
Check 'cloud all required jobs pass for exact SHA' {
    $script:CiRunId=$null
    Equal (Get-CIState).Status 'passed'
}
Check 'cloud wrong SHA rejected' {
    $script:FakeRun.head_sha='e'*40
    try { Throws { Get-CIState } } finally { $script:FakeRun.head_sha=$script:PinnedSha }
}
Check 'cloud failed or missing job blocks success' {
    $script:FakeJobs[0].conclusion='failure'
    try { Equal (Get-CIState).Status 'failed' } finally { $script:FakeJobs[0].conclusion='success' }
}
Check 'cloud rerun rejected' {
    $script:FakeRun.run_attempt=2
    try { Throws { Get-CIState } } finally { $script:FakeRun.run_attempt=1 }
}
$script:FakePR=@{number=99;state='open';draft=$false;head=@{ref='codex/synthetic-release-candidate';sha=$script:PinnedSha;repo=@{full_name=$Repository}};base=@{ref='main';sha=$script:BaseSha;repo=@{full_name=$Repository}}}
$script:RemoteMain=$script:BaseSha
function Get-PR([int]$Number) { return $script:FakePR }
function Fetch-Main { return $script:RemoteMain }
Check 'candidate unchanged passes' { Equal (Assert-CurrentCandidate $true).number 99 }
Check 'main changed blocks integration' {
    $script:RemoteMain='f'*40
    try { Throws { Assert-CurrentCandidate $true } } finally { $script:RemoteMain=$script:BaseSha }
}
Check 'draft rejected when readiness required' {
    $script:FakePR.draft=$true
    try { Throws { Assert-CurrentCandidate $true } } finally { $script:FakePR.draft=$false }
}
Write-Host "CI-06 OFFLINE: $script:Pass passed, $script:Fail failed"
if ($script:Fail -ne 0) { exit 1 }
exit 0
