# iScribe Update & Build v7.0 — Windows PowerShell 5.1 / PowerShell 7
# Auto: offer local CI by default; cloud CI only after explicit selection.
# Local: test exact merge commit, then normal push; no Actions dispatch.
# Online: dispatch CI once for the pinned candidate, wait, then ordinary PR merge.
# MainOnly: sync and build only.
# DiagnosticsSetup: explicitly provision the private diagnostics repo and run a smoke check.
# DiagnosticsCheck: run the smoke check only; no build, PR, push or Actions.
# No force-push, hard reset, arbitrary PR merge, or publishing to Pages.
[CmdletBinding()]
param(
    [string]$ProjectDirectory = '',
    [ValidateSet('Auto','Local','Online','MainOnly','DiagnosticsSetup','DiagnosticsCheck')][string]$Mode = 'Auto',
    [ValidateRange(0,2147483647)][int]$PullRequest = 0,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]*$')][string]$IntegrationBranch,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedHeadSha,
    [switch]$Integrate,
    [ValidateRange(1,120)][int]$CiTimeoutMinutes = 30,
    [switch]$UploadDiagnostics = $true,
    [switch]$NoUploadDiagnostics,
    [string]$DiagnosticsRepo = 'AlmazovAN/iScribe-diagnostics'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repository = 'AlmazovAN/iScribe'
$StepName = 'Подготовка'
$Revision = 'unknown'
$PinnedSha = $null
$BaseSha = $null
$SelectedPR = 0
$SelectedManifest = $null
$CiRequestId = $null
$CiRunId = $null
$CiBranch = $null
$Worktree = $null
$WorktreeRegistered = $false
$TempHtml = $null
$LogWriter = $null
$ExitCode = 1
$RemoteChanged = $false
$DiagnosticEvents = [System.Collections.Generic.List[object]]::new()
$DiagnosticOmitted = 0
$DiagnosticStage = 'initialization'
$DiagnosticRoute = 'not-selected'
$InitialLocation = (Get-Location).Path
$PriorGpuProfile = $env:VITE_GPU_PROFILE
$Root = $null
$LogRoot = Join-Path $env:LOCALAPPDATA 'iScribe\BuildDiagnostics'
$FullLog = Join-Path $env:TEMP ('iscribe-build-' + [guid]::NewGuid().ToString('N') + '.log')

# CI-03: create a structured, allowlisted diagnostic journal. Never serialize
# raw stdout/stderr, exception messages, paths, environment or command arguments.
# CI-04 adds reconstructed technical excerpts; unknown messages remain local.
function Add-DiagnosticEvent([string]$Kind,[string]$Code,[int]$Exit=-1) {
    if ($script:DiagnosticEvents.Count -ge 2000) { $script:DiagnosticOmitted++; return }
    $script:DiagnosticEvents.Add([ordered]@{
        utc=[DateTime]::UtcNow.ToString('o')
        stage=$script:DiagnosticStage; kind=$Kind; code=$Code; exit_code=$Exit
    })
}
function Get-DiagnosticCode([string]$Message) {
    switch -Regex ($Message) {
        'Cannot bind argument to parameter .LiteralPath. because it is an empty string' { return 'EMPTY_LITERAL_PATH' }
        'Cannot bind argument to parameter .Path. because it is an empty string|ParameterArgumentValidationErrorEmptyStringNotAllowed' { return 'EMPTY_PATH' }
        'Cannot find path|PathNotFound|ItemNotFound' { return 'PATH_NOT_FOUND' }
        'ENOSPC|not enough space|disk full' { return 'DISK_FULL' }
        'out of memory|ENOMEM|heap limit' { return 'OUT_OF_MEMORY' }
        'HTTP 404|404 Not Found' { return 'HTTP_404' }
        'HTTP 403|403 Forbidden|Permission denied|Access is denied' { return 'ACCESS_DENIED' }
        'HTTP 401|authentication failed|не авторизован' { return 'AUTH_FAILED' }
        'ETIMEDOUT|ECONNRESET|ENOTFOUND|Could not resolve host|connection timed out' { return 'NETWORK_ERROR' }
        '(?i)\bTS([0-9]{4,5})\s*:' { return ('TYPESCRIPT_TS'+$Matches[1]) }
        'npm (ERR!|error)' { return 'NPM_ERROR' }
        'AssertionError|expect\(.*\)' { return 'ASSERTION_ERROR' }
        'merge conflict|CONFLICT \(' { return 'MERGE_CONFLICT' }
        'non-fast-forward|fetch first' { return 'NON_FAST_FORWARD' }
        'protected branch|GH006|GH013' { return 'BRANCH_PROTECTION' }
        'CI не пройден' { return 'CLOUD_CI_FAILED' }
        'Время ожидания CI истекло' { return 'CLOUD_CI_TIMEOUT' }
        'Конфигурация CI кандидата отличается' { return 'WORKFLOW_MISMATCH' }
        'Кандидат не содержит актуальный main|origin/main изменился|PR или main изменился' { return 'STALE_CANDIDATE' }
        'Не найдена встроенная точка входа|Повреждён встроенный блок|не обнаружена ревизия сборки' { return 'HTML_VALIDATION' }
        'Не установлена программа' { return 'TOOL_MISSING' }
        'Не найден локальный репозиторий' { return 'PROJECT_NOT_FOUND' }
        'Есть изменения отслеживаемых файлов' { return 'DIRTY_WORKTREE' }
        default { return 'UNCLASSIFIED' }
    }
}
function Get-DiagnosticCommand([string]$Exe,[string[]]$Arguments) {
    if ($Exe -eq 'git.exe' -and $Arguments[0] -in @('fetch','switch','merge','worktree','push','rev-parse','status','merge-base')) { return ('git '+$Arguments[0]) }
    if ($Exe -eq 'npm.cmd') {
        if ($Arguments[0] -in @('ci','install','test')) { return ('npm '+$Arguments[0]) }
        if ($Arguments[0] -eq 'run' -and $Arguments[1] -in @('typecheck','lint','build','build:web','release:check','release:check:web')) { return ('npm run '+$Arguments[1]) }
    }
    if ($Exe -eq 'npx.cmd' -and $Arguments[0] -eq 'playwright' -and $Arguments[1] -in @('install','test')) { return ('playwright '+$Arguments[1]) }
    if ($Exe -eq 'gh.exe' -and $Arguments[0] -eq 'workflow' -and $Arguments[1] -eq 'run') { return 'gh workflow run' }
    if ($Exe -eq 'gh.exe' -and $Arguments[0] -eq 'pr' -and $Arguments[1] -in @('ready','merge')) { return ('gh pr '+$Arguments[1]) }
    return 'other'
}

function Log([string]$Message) {
    Write-Host $Message
    if ($script:LogWriter) { $script:LogWriter.WriteLine($Message); $script:LogWriter.Flush() }
}
function Step([string]$Name) {
    $script:StepName = $Name
    $script:DiagnosticStage = switch ($Name) {
        '1. Подготовка и синхронизация исходного main' { 'sync-main' }
        '2. Поиск интеграционного PR' { 'find-pr' }
        '3. Локальный кандидат слияния в изолированном worktree' { 'local-merge' }
        'Локальный CI: зависимости, типы, линтер, Vitest' { 'local-unit' }
        'Локальный CI: браузерные испытания Playwright' { 'local-browser' }
        '4. Отправка точного проверенного merge commit в GitHub main' { 'local-push' }
        '3. GitHub Actions и слияние PR' { 'cloud-ci' }
        '3. Только синхронизация и сборка main' { 'main-only' }
        'Сборка проверяемой ревизии main' { 'build' }
        'Синхронизация main и замена HTML' { 'install-html' }
        default { 'other' }
    }
    Add-DiagnosticEvent 'stage' 'begin'
    Log ("`n=== " + $Name + ' ===')
}
function Run([string]$Exe,[string[]]$Arguments) {
    Log ('+ ' + $Exe + ' ' + ($Arguments -join ' '))
    $command=Get-DiagnosticCommand $Exe $Arguments
    Add-DiagnosticEvent 'command-start' $command
    $prior = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Exe @Arguments 2>&1 | ForEach-Object {
            $line=[string]$_
            Log $line
            $diagnosticCode=Get-DiagnosticCode $line
            if ($diagnosticCode -ne 'UNCLASSIFIED') { Add-DiagnosticEvent 'output-class' $diagnosticCode }
        }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prior }
    Add-DiagnosticEvent 'command-end' $command $code
    if ($code -ne 0) { throw ('Код ' + $code + ': ' + $Exe + ' ' + ($Arguments -join ' ')) }
}
function Capture([string]$Exe,[string[]]$Arguments) {
    $prior = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $Exe @Arguments 2>$null
        $code = $LASTEXITCODE
        return @{ ExitCode=$code; Text=(($output | Out-String).Trim()) }
    } finally { $ErrorActionPreference = $prior }
}
function Git-Text([string[]]$GitArgs) {
    $r = Capture 'git.exe' $GitArgs
    if ($r.ExitCode -ne 0) { throw ('git: ' + ($GitArgs -join ' ')) }
    return $r.Text
}
# CI-05: retry only safe GETs and reconciled diagnostic writes. Never
# automatically retry workflow dispatch, git push, PR merge or test commands.
function Get-ApiFailureKind([string]$ErrorText) {
    if ($ErrorText -match '(?i)\bHTTP\s*[: ]?\s*([1-5][0-9]{2})\b') {
        $status=[int]$Matches[1]
        if ($status -eq 404) { return 'not-found' }
        if ($status -in @(408,429,500,502,503,504)) { return 'transient' }
        if ($status -eq 403 -and $ErrorText -match '(?i)rate limit') { return 'rate-limited' }
        if ($status -in @(409,422)) { return 'conflict' }
        return 'permanent'
    }
    if ($ErrorText -match '(?i)\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|i/o timeout|TLS handshake timeout|connection reset|connection refused|connection timed out|no such host|temporary failure in name resolution|unexpected EOF|network is unreachable)\b') { return 'transient' }
    return 'unknown'
}
function Invoke-GhApiOnce([string[]]$CliArgs) {
    $errFile=Join-Path $env:TEMP ('iscribe-gh-error-'+[guid]::NewGuid().ToString('N')+'.txt')
    $prior=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        $output=& gh.exe @CliArgs 2> $errFile
        $code=$LASTEXITCODE
        $err=''
        if (Test-Path -LiteralPath $errFile -PathType Leaf) { $err=[IO.File]::ReadAllText($errFile) }
        $kind='success'
        if ($code -ne 0) { $kind=Get-ApiFailureKind $err }
        # Never log or serialize raw stderr or response bodies.
        return @{ExitCode=$code; Text=(($output | Out-String).Trim()); Kind=$kind}
    } finally {
        $ErrorActionPreference=$prior
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}
function Wait-ApiRetry([int]$Attempt) {
    $seconds=@(2,5)[$Attempt-1]
    Write-Host "Временная ошибка GitHub API. Повтор через $seconds с."
    Start-Sleep -Seconds $seconds
}
function Invoke-GhApiRead([string]$Endpoint) {
    # Explicit method, so this helper cannot accidentally dispatch or mutate.
    for ($attempt=1; $attempt -le 3; $attempt++) {
        $r=Invoke-GhApiOnce @('api','-X','GET',$Endpoint)
        if ($r.Kind -ne 'transient' -or $attempt -eq 3) { return $r }
        Add-DiagnosticEvent 'api-retry' 'read-transient' $r.ExitCode
        Wait-ApiRetry $attempt
    }
}
function Gh-Json([string[]]$CliArgs) {
    if ($CliArgs.Count -ne 2 -or $CliArgs[0] -ne 'api') { throw 'Gh-Json accepts only read-only API endpoints.' }
    $r=Invoke-GhApiRead $CliArgs[1]
    if ($r.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($r.Text)) {
        throw ('GitHub API read failed: '+$r.Kind+'. Проверьте gh auth status и доступ.')
    }
    return ($r.Text | ConvertFrom-Json)
}
function Assert-Tools([bool]$NeedGh) {
    $list = @('git.exe','node.exe','npm.cmd','npx.cmd')
    if ($NeedGh) { $list += 'gh.exe' }
    foreach ($exe in $list) { if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { throw "Не установлена программа $exe" } }
    if ($NeedGh -and (Capture 'gh.exe' @('auth','status','--hostname','github.com')).ExitCode -ne 0) {
        throw 'GitHub CLI не авторизован. Выполните gh auth login или используйте -Mode MainOnly.'
    }
}
function Resolve-Project {
    $choices = @()
    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) { $choices += $ProjectDirectory }
    else {
        if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $choices += $PSScriptRoot }
        $choices += $InitialLocation
    }
    foreach ($dir in $choices) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        $probe = Capture 'git.exe' @('-C',$dir,'rev-parse','--show-toplevel')
        if ($probe.ExitCode -eq 0 -and $probe.Text -and (Test-Path -LiteralPath (Join-Path $probe.Text 'package.json') -PathType Leaf)) {
            $remote = Capture 'git.exe' @('-C',$probe.Text,'remote','get-url','origin')
            if ($remote.ExitCode -eq 0 -and $remote.Text -match '^(https://github\.com/AlmazovAN/iScribe(?:\.git)?/?|git@github\.com:AlmazovAN/iScribe(?:\.git)?|ssh://git@github\.com/AlmazovAN/iScribe(?:\.git)?)$') { return [IO.Path]::GetFullPath($probe.Text) }
        }
    }
    throw 'Не найден локальный репозиторий AlmazovAN/iScribe. Укажите -ProjectDirectory с путём к корню проекта.'
}
function Assert-CleanTracked {
    if (Git-Text @('status','--porcelain','--untracked-files=no')) { throw 'Есть изменения отслеживаемых файлов. Сначала сохраните их (commit или stash). Скрипт не сбрасывает изменения.' }
}
function Test-Ancestor([string]$Ancestor,[string]$Descendant) {
    $r = Capture 'git.exe' @('merge-base','--is-ancestor',$Ancestor,$Descendant)
    if ($r.ExitCode -eq 0) { return $true }
    if ($r.ExitCode -eq 1) { return $false }
    throw 'Не удалось проверить историю Git.'
}
function Fetch-Main {
    Run 'git.exe' @('fetch','origin','refs/heads/main:refs/remotes/origin/main')
    return (Git-Text @('rev-parse','refs/remotes/origin/main'))
}
function Sync-Main {
    Set-Location -LiteralPath $script:Root
    Assert-CleanTracked
    $remote = Fetch-Main
    $local = Git-Text @('rev-parse','refs/heads/main')
    if (-not (Test-Ancestor $local $remote)) { throw 'Локальный main содержит собственные коммиты или расходится с origin/main. Требуется ручная проверка.' }
    Run 'git.exe' @('switch','main')
    Run 'git.exe' @('merge','--ff-only','refs/remotes/origin/main')
    if ((Git-Text @('rev-parse','HEAD')) -ne $remote) { throw 'Локальный main не совпадает с полученным origin/main.' }
    return $remote
}
function Get-PR([int]$Number) { return (Gh-Json @('api',('repos/' + $Repository + '/pulls/' + $Number))) }
function Assert-PRIdentity($Pr) {
    if ($Pr.base.ref -ne 'main' -or $Pr.base.repo.full_name -ne $Repository -or $Pr.head.repo.full_name -ne $Repository) { throw 'PR должен быть из того же репозитория в main.' }
    if ($IntegrationBranch -and $Pr.head.ref -ne $IntegrationBranch) { throw 'PR не соответствует явно указанной ветке.' }
    if ($ExpectedHeadSha -and $Pr.head.sha -ne $ExpectedHeadSha) { throw 'PR не соответствует явно указанному SHA.' }
}
# Manifest is stored in the integration PR description, not in its own commit.
# Exact format: <!-- iscribe-release: {"schema":1,"release_id":"...","base_sha":"...","head_sha":"...","stages":[{"id":"...","pr":123,"sha":"..."}]} -->
function Get-ReleaseManifest($Pr) {
    $body=[string]$Pr.body
    $matches=[regex]::Matches($body,'(?m)^<!-- iscribe-release: (\{[^\r\n]*\}) -->\s*$')
    if ($matches.Count -eq 0) { return $null }
    if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value.Length -gt 30000) { throw 'Invalid or duplicate release manifest.' }
    $m=$matches[0].Groups[1].Value | ConvertFrom-Json
    if ($m.schema -ne 1 -or [string]$m.release_id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' -or
        [string]$m.base_sha -cnotmatch '^[0-9a-f]{40}$' -or [string]$m.head_sha -cnotmatch '^[0-9a-f]{40}$' -or
        $m.base_sha -cne $Pr.base.sha -or $m.head_sha -cne $Pr.head.sha) { throw 'Release manifest identity or SHA is stale.' }
    $stages=@($m.stages)
    if ($stages.Count -lt 1 -or $stages.Count -gt 100) { throw 'Invalid manifest stage count.' }
    $ids=@{}; $numbers=@{}
    foreach ($stage in $stages) {
        if ([string]$stage.id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' -or
            [string]$stage.pr -notmatch '^[1-9][0-9]{0,8}$' -or [string]$stage.sha -cnotmatch '^[0-9a-f]{40}$' -or
            $ids.ContainsKey([string]$stage.id) -or $numbers.ContainsKey([string]$stage.pr)) { throw 'Invalid or duplicate manifest stage.' }
        $ids[[string]$stage.id]=$true; $numbers[[string]$stage.pr]=$true
    }
    return @{Data=$m;Raw=$matches[0].Groups[1].Value}
}
function Test-ReadyRelease($Pr) {
    if ($Pr.state -ne 'open' -or $Pr.draft -or $Pr.base.ref -ne 'main' -or
        $Pr.base.repo.full_name -ne $Repository -or $Pr.head.repo.full_name -ne $Repository -or
        $Pr.head.ref -notmatch '^codex/.+-release-candidate$') { return $false }
    $labels=@($Pr.labels | ForEach-Object {$_.name})
    if (@($labels | Where-Object {$_ -in @('experimental','on-hold','abandoned','development','local-ci-failed')}).Count -gt 0) { return $false }
    return $true
}
function Find-Candidate {
    if ($PullRequest -gt 0) {
        $p=Get-PR $PullRequest; Assert-PRIdentity $p
        if ($p.state -eq 'open' -and -not (Test-ReadyRelease $p)) { throw 'Explicit PR is not a ready integration candidate.' }
        $script:SelectedManifest=Get-ReleaseManifest $p
        if (-not $script:SelectedManifest -and $p.state -eq 'open') { Log 'Legacy integration PR: no manifest; explicit selection and confirmation required.'; if ($Integrate) { throw 'Unattended integration requires a manifest.' } }
        return $p
    }
    $all=@()
    for ($page=1;$page -le 20;$page++) {
        $batch=@(Gh-Json @('api',('repos/'+$Repository+'/pulls?state=open&per_page=100&page='+$page)) | Where-Object {$_ -ne $null})
        $all+= $batch
        if ($batch.Count -lt 100) { break }
        if ($page -eq 20) { throw 'PR inventory exceeds safe pagination limit.' }
    }
    $ready=@(); $legacy=@()
    foreach ($p in $all) {
        if (-not (Test-ReadyRelease $p) -or ($IntegrationBranch -and $p.head.ref -ne $IntegrationBranch)) { continue }
        try {
            $manifest=Get-ReleaseManifest $p
            if ($manifest) { $ready+= $p }
            else { $legacy+= $p }
        } catch { Log ('Excluded invalid/stale manifest on PR #'+$p.number) }
    }
    Log ('Open PRs: '+$all.Count+'; manifest-ready: '+$ready.Count+'; legacy candidates: '+$legacy.Count+'; ignored: '+($all.Count-$ready.Count-$legacy.Count))
    $choices=@($ready)+@($legacy)
    if ($choices.Count -eq 0) {
        if ($IntegrationBranch -or $ExpectedHeadSha -or $Mode -in @('Local','Online')) { throw 'No ready integration candidate.' }
        return $null
    }
    if ($ready.Count -eq 1 -and $legacy.Count -eq 0) { $p=$ready[0] }
    else {
        foreach ($p in $choices) {
            $m=Get-ReleaseManifest $p
            if ($m) { Log ('#'+$p.number+' '+$m.Data.release_id+' / '+@($m.Data.stages).Count+' stages') }
            else { Log ('#'+$p.number+' '+$p.head.ref+' / legacy, no manifest') }
        }
        $answer=Read-Host 'Enter one PR number (0 = cancel)'
        if ($answer -eq '0') { $script:ExitCode=2; throw 'Integration cancelled.' }
        $picked=@($choices | Where-Object {[string]$_.number -ceq $answer})
        if ($picked.Count -ne 1) { throw 'Select exactly one listed integration PR.' }
        $p=$picked[0]
    }
    $p=Get-PR ([int]$p.number)
    Assert-PRIdentity $p
    if (-not (Test-ReadyRelease $p)) { throw 'Candidate readiness changed.' }
    $script:SelectedManifest=Get-ReleaseManifest $p
    if (-not $script:SelectedManifest -and $Integrate) { throw 'Unattended integration requires a manifest.' }
    return $p
}
function Assert-ManifestStages($Manifest) {
    if (-not $Manifest) { return }
    foreach ($stage in @($Manifest.Data.stages)) {
        $p=Get-PR ([int]$stage.pr)
        if ($p.head.repo.full_name -ne $Repository -or $p.base.repo.full_name -ne $Repository -or
            $p.head.sha -cne $stage.sha -or $p.draft -or ($p.state -ne 'open' -and -not $p.merged)) {
            throw ('Manifest stage PR identity/state changed: #'+$stage.pr)
        }
        if (-not (Test-Ancestor $stage.sha $script:PinnedSha)) { throw ('Manifest stage not in candidate history: #'+$stage.pr) }
    }
}
function Assert-CurrentCandidate([bool]$RequireReady=$false) {
    $p=Get-PR $script:SelectedPR
    Assert-PRIdentity $p
    if ($p.state -ne 'open' -or $p.head.sha -ne $script:PinnedSha -or $p.base.sha -ne $script:BaseSha) { throw 'PR или main изменился. Повторите запуск с новой ревизией.' }
    if ($RequireReady -and $p.draft) { throw 'PR всё ещё является Draft.' }
    if ($script:SelectedManifest) {
        if (-not (Test-ReadyRelease $p)) { throw 'Candidate readiness changed.' }
        $now=Get-ReleaseManifest $p
        if (-not $now -or $now.Raw -cne $script:SelectedManifest.Raw) { throw 'Release manifest changed during testing.' }
        Assert-ManifestStages $now
    }
    $remote=Fetch-Main
    if ($remote -ne $script:BaseSha) { throw 'origin/main изменился. Проверка устарела; повторите запуск.' }
    return $p
}
function Start-CloudCI($Pr) {
    if ($script:CiRequestId) { throw 'CI уже запрошен в этом запуске скрипта. Повторный запуск запрещён.' }
    # The candidate must contain the same CI definition as the current main.
    # An intentional workflow change must be reviewed/integrated separately.
    $baseWorkflow=Git-Text @('rev-parse',($script:BaseSha+':.github/workflows/ci.yml'))
    $headWorkflow=Git-Text @('rev-parse',($script:PinnedSha+':.github/workflows/ci.yml'))
    if ($baseWorkflow -ne $headWorkflow) { throw 'Конфигурация CI кандидата отличается от main. Сначала согласуйте конфигурацию CI.' }
    $script:CiBranch=[string]$Pr.head.ref
    $script:CiRequestId=[guid]::NewGuid().ToString('N')
    Log "Запуск GitHub Actions по запросу: CI / $script:CiRequestId; head=$script:PinnedSha; base=$script:BaseSha"
    # Dispatch exactly once. A network failure can be ambiguous: do not retry
    # automatically, as GitHub might already have accepted the request.
    Run 'gh.exe' @('workflow','run','ci.yml','--repo',$Repository,'--ref',$script:CiBranch,'-f',('request_id='+$script:CiRequestId))
}
function Get-CIState {
    if (-not $script:CiRequestId) { throw 'Облачный CI не был запрошен этим запуском скрипта.' }
    $runTitle='CI / '+$script:CiRequestId
    if (-not $script:CiRunId) {
        $branch=[uri]::EscapeDataString($script:CiBranch)
        $path='repos/'+$Repository+'/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch='+$branch+'&per_page=100'
        $data=Gh-Json @('api',$path)
        $matches=@($data.workflow_runs | Where-Object { $_.display_title -ceq $runTitle })
        if ($matches.Count -eq 0) { return @{Status='missing';Url=''} }
        if ($matches.Count -ne 1) { throw 'Найдено несколько CI с одним request_id. Интеграция запрещена.' }
        $r=$matches[0]
        if ([string]$r.id -notmatch '^[0-9]+$') { throw 'Некорректный ID запуска CI.' }
        $script:CiRunId=[string]$r.id
    } else {
        $r=Gh-Json @('api',('repos/'+$Repository+'/actions/runs/'+$script:CiRunId))
    }
    # A manual dispatch does not populate PR metadata reliably. Instead bind
    # to the unique request ID, exact pinned branch and SHA; base is checked
    # independently by Assert-CurrentCandidate before dispatch and merge.
    if ($r.name -cne 'CI' -or $r.event -cne 'workflow_dispatch' -or
        $r.display_title -cne $runTitle -or $r.head_branch -cne $script:CiBranch -or
        $r.head_sha -ne $script:PinnedSha -or [string]$r.id -ne $script:CiRunId) {
        throw 'Запуск CI не соответствует точному кандидату. Интеграция запрещена.'
    }
    if ([int]$r.run_attempt -ne 1) { throw 'Обнаружен повторный запуск CI. Требуется новый явный запрос скрипта.' }
    if ($r.status -ne 'completed') { return @{Status='pending';Url=$r.html_url} }
    if ($r.conclusion -ne 'success') { return @{Status='failed';Url=$r.html_url} }
    $jobs=Gh-Json @('api',('repos/'+$Repository+'/actions/runs/'+$script:CiRunId+'/attempts/1/jobs?per_page=100'))
    foreach ($name in @('verify','browser-acceptance','build')) {
        if (@($jobs.jobs | Where-Object { $_.name -ceq $name -and $_.status -eq 'completed' -and $_.conclusion -eq 'success' }).Count -ne 1) { return @{Status='failed';Url=$r.html_url} }
    }
    return @{Status='passed';Url=$r.html_url}
}
function Wait-CI {
    $deadline=(Get-Date).AddMinutes($CiTimeoutMinutes)
    $last=''
    do {
        $c=Get-CIState
        if ($c.Status -ne $last) { Log ('GitHub CI: '+$c.Status+' '+$c.Url); $last=$c.Status }
        if ($c.Status -eq 'passed') { return $c }
        if ($c.Status -eq 'failed') { throw ('GitHub CI не пройден: '+$c.Url+'. Исправьте ошибки; автоматическое слияние запрещено.') }
        Start-Sleep -Seconds 10
    } while ((Get-Date) -lt $deadline)
    throw 'Время ожидания CI истекло. Проверьте Actions по request_id из журнала. Скрипт не запускает повторные испытания и не объединяет PR при неизвестном результате.'
}
function New-Worktree([string]$Commit) {
    Set-Location -LiteralPath $script:Root
    $script:Worktree=Join-Path $env:TEMP ('iscribe-verify-'+[guid]::NewGuid().ToString('N'))
    Run 'git.exe' @('worktree','add','--detach',$script:Worktree,$Commit)
    $script:WorktreeRegistered=$true
    Set-Location -LiteralPath $script:Worktree
}
function Run-LocalCI {
    Step 'Локальный CI: зависимости, типы, линтер, Vitest'
    Run 'npm.cmd' @('ci')
    Run 'npm.cmd' @('run','typecheck')
    Run 'npm.cmd' @('run','lint')
    Run 'npm.cmd' @('test')
    Step 'Локальный CI: браузерные испытания Playwright'
    Run 'npm.cmd' @('install','--no-save','--package-lock=false','@playwright/test@1.56.1')
    Run 'npx.cmd' @('playwright','install','chromium')
    $priorCI=$env:CI
    try {
        # Do not let Playwright reuse a server from another checkout.
        $env:CI='true'
        Run 'npx.cmd' @('playwright','test')
        Run 'npm.cmd' @('run','build')
        Run 'npm.cmd' @('run','build:web')
        Run 'npm.cmd' @('run','release:check:web')
        Run 'npx.cmd' @('playwright','test','--config','playwright.offline.config.mjs')
        Run 'npm.cmd' @('run','release:check')
    } finally { $env:CI=$priorCI }
    Assert-CleanTracked
    Log 'LOCAL CI PASS (проверки текущего CI на Windows; не аппаратная приёмка).'
}
function Build-Only {
    Step 'Сборка проверяемой ревизии main'
    Run 'npm.cmd' @('ci')
    Run 'npm.cmd' @('run','build')
    Run 'npm.cmd' @('run','release:check')
    Assert-CleanTracked
}
function Assert-Html([string]$Html,[string]$Revision) {
    if (-not (Test-Path -LiteralPath $Html -PathType Leaf)) { throw 'Не найден новый dist\iScribe.html' }
    if ((Get-Item -LiteralPath $Html).Length -le 0) { throw 'Собранный HTML пуст.' }
    if ((Git-Text @('rev-parse','HEAD')) -ne $Revision) { throw 'HEAD изменился во время сборки.' }
    $shortRevision = $Revision.Substring(0,7)
    # Standalone Vite packs the application JS into a Base64 payload.
    # Search the decoded entry only (not the HTML, Worker or WASM payloads).
    $htmlText = [IO.File]::ReadAllText($Html, [Text.Encoding]::UTF8)
    $entryPrefix = 'await import(blobUrl([decode("'
    $entrySuffix = '")],"text/javascript"));'
    $entryStart = $htmlText.IndexOf($entryPrefix, [StringComparison]::Ordinal)
    if ($entryStart -lt 0) { throw 'Не найдена встроенная точка входа JavaScript в standalone HTML.' }
    $entryStart += $entryPrefix.Length
    $entryEnd = $htmlText.IndexOf($entrySuffix, $entryStart, [StringComparison]::Ordinal)
    if ($entryEnd -le $entryStart) { throw 'Повреждён встроенный блок JavaScript в standalone HTML.' }
    $encodedEntry = $htmlText.Substring($entryStart, $entryEnd - $entryStart)
    $entryCode = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedEntry))
    # Vite defines the full SHA; a minifier may fold .slice(0,7) to a short
    # quoted literal. Prefer exact full SHA, allow the actual UI revision.
    $fullMatch = $entryCode.Contains(('"' + $Revision + '"')) -or $entryCode.Contains(("'" + $Revision + "'"))
    $shortMatch = $entryCode.Contains(('"' + $shortRevision + '"')) -or $entryCode.Contains(("'" + $shortRevision + "'"))
    if (-not ($fullMatch -or $shortMatch)) { throw "Во встроенном JavaScript не обнаружена ревизия сборки $shortRevision." }
    if ($fullMatch) { Log "Проверена полная ревизия во встроенном JavaScript: $Revision" }
    else { Log "Проверена короткая ревизия во встроенном JavaScript: $shortRevision" }
}
function Confirm-Integration([string]$Route) {
    Log "PR #$script:SelectedPR; head=$script:PinnedSha; base=$script:BaseSha; маршрут=$Route"
    if ($Integrate) {
        if (-not $ExpectedHeadSha -or $PullRequest -le 0) { throw 'Для запуска без подтверждения (-Integrate) укажите -PullRequest и -ExpectedHeadSha.' }
        return
    }
    $answer=Read-Host 'Подтвердите проверку и слияние этого кандидата в main (YES)'
    if ($answer -ne 'YES') { $script:ExitCode=2; throw 'Интеграция отменена. HTML не заменён.' }
}
function Install-Html([string]$Source,[string]$Commit) {
    Step 'Синхронизация main и замена HTML'
    Set-Location -LiteralPath $script:Root
    $actual=Sync-Main
    if ($actual -ne $Commit) { throw 'main изменился после проверки или сборки. Старый HTML оставлен. Повторите запуск.' }
    $folder=Join-Path $script:Root 'dist'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $destination=Join-Path $folder 'iScribe.html'
    $script:TempHtml=Join-Path $folder ('.iscribe-new-'+[guid]::NewGuid().ToString('N')+'.html')
    Copy-Item -LiteralPath $Source -Destination $script:TempHtml
    $hash=(Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    if ((Get-FileHash -LiteralPath $script:TempHtml -Algorithm SHA256).Hash -ne $hash) { throw 'Копия HTML не совпадает с проверенным файлом.' }
    if ((Fetch-Main) -ne $Commit) { throw 'origin/main изменился перед заменой HTML. Повторите запуск.' }
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $backup=Join-Path $folder ('.iscribe-previous-'+[guid]::NewGuid().ToString('N')+'.html')
        # Replace on the same volume; old file remains available on failure.
        [IO.File]::Replace($script:TempHtml,$destination,$backup)
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } else { [IO.File]::Move($script:TempHtml,$destination) }
    $script:TempHtml=$null
    Log "BUILD OK: $destination"
    Log "main=$Commit; HTML SHA256=$hash; bytes=$((Get-Item -LiteralPath $destination).Length)"
    Log 'Аппаратная приёмка Whisper/WebGPU и публикация сайта не выполнялись.'
}
function Get-SafeSha([string]$Value) {
    if ($Value -cmatch '^[0-9a-f]{40}$') { return $Value }
    return $null
}
# Reconstruct known technical messages; never return the input line or
# arbitrary captures. Only fixed templates and constrained numeric/enum
# captures are allowed. Unknown text is omitted, not merely masked.
$script:SafeDiagnosticRules = @(
        @{ pattern='(?i)Cannot bind argument to parameter .Path. because it is an empty string'; template='PowerShell: Path is empty' }
        @{ pattern='(?i)\bParameterArgumentValidationErrorEmptyStringNotAllowed\b'; template='PowerShell: ParameterArgumentValidationErrorEmptyStringNotAllowed' }
        @{ pattern='(?i)^\s*At\s+[^\r\n]*[\\/]scripts[\\/]Test-CI06\.ps1:\s*([0-9]{1,6})\s+char:\s*([0-9]{1,6})'; template='Source: scripts/Test-CI06.ps1:$1:$2' }
        @{ pattern='(?i)^\s*At\s+[^\r\n]*[\\/]scripts[\\/]Test-CI06\.ps1:\s*        @{ pattern='(?i)\bTS([0-9]{4,5})\s*:'; template='TypeScript TS$1' }
        @{ pattern='(?i)\bnpm\s+(?:ERR!|error)\s+code\s+(EACCES|EPERM|ENOENT|ENOSPC|ENOMEM|ERESOLVE|EINTEGRITY|ECONNRESET|ETIMEDOUT|ENOTFOUND|E401|E403|E404|ELIFECYCLE)\b'; template='npm error code $1' }
        @{ pattern='(?i)^\s*(?:Test Files|Tests)\s+([0-9]{1,6})\s+(passed|failed)\s+\(([0-9]{1,6})\)\s*$'; template='Tests: $1 $2 ($3 total)' }
        @{ pattern='(?i)^\s*([0-9]{1,6})\s+(passed|failed|skipped)\s*(?:\([0-9.]+(?:ms|s|m)\))?\s*$'; template='Tests: $1 $2' }
        @{ pattern='(?i)\bHTTP\s+(400|401|403|404|408|409|422|429|500|502|503|504)\b'; template='HTTP $1' }
        @{ pattern='(?i)^\s*Node:\s*v([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\s+\(CI использует Node 22\)\s*$'; template='Node v$1' }
        @{ pattern='(?i)^\s*\+\s*(npm\.cmd|git\.exe|npx\.cmd|gh\.exe)\s+'; template='Command: $1 (arguments omitted)' }
        @{ pattern='(?i)\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENOSPC|ENOMEM|EACCES|EPERM|ENOENT|ERESOLVE|EINTEGRITY)\b'; template='System error: $1' }
        @{ pattern='(?i)Cannot bind argument to parameter .LiteralPath. because it is an empty string'; template='PowerShell: LiteralPath is empty' }
        @{ pattern='(?i)Cannot find path|PathNotFound|ItemNotFound'; template='PowerShell: path not found' }
        @{ pattern='(?i)JavaScript heap out of memory|out of memory|heap limit'; template='Memory exhausted' }
        @{ pattern='(?i)Permission denied|Access is denied'; template='Access denied' }
        @{ pattern='(?i)authentication failed|не авторизован'; template='Authentication failed' }
        @{ pattern='(?i)Could not resolve host|connection timed out'; template='Network resolution or timeout failure' }
        @{ pattern='(?i)non-fast-forward|fetch first'; template='Git: non-fast-forward' }
        @{ pattern='(?i)protected branch|GH006|GH013'; template='Git: branch protection rejected operation' }
        @{ pattern='(?i)merge conflict|CONFLICT \('; template='Git: merge conflict' }
        @{ pattern='(?i)AssertionError|expect\(.*\)'; template='Test assertion failed' }
        @{ pattern='(?i)CI не пройден'; template='Cloud CI failed' }
        @{ pattern='(?i)Время ожидания CI истекло'; template='Cloud CI timed out' }
        @{ pattern='(?i)Конфигурация CI кандидата отличается'; template='CI workflow differs from base' }
        @{ pattern='(?i)Кандидат не содержит актуальный main|origin/main изменился|PR или main изменился'; template='Candidate or main changed' }
        @{ pattern='(?i)Не найдена встроенная точка входа|Повреждён встроенный блок|не обнаружена ревизия сборки'; template='HTML validation failed' }
        @{ pattern='(?i)Не установлена программа'; template='Required tool not installed' }
        @{ pattern='(?i)Не найден локальный репозиторий'; template='Local project not found' }
        @{ pattern='(?i)Есть изменения отслеживаемых файлов'; template='Tracked working tree is dirty' }
)
function ConvertTo-SafeLogLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -gt 8192) { return $null }
    if ($Line -match '(?i)-----\s*(BEGIN|END)\s+[^-]*PRIVATE KEY|authorization\s*[:=]|(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|(?:token|secret|password|passwd|api[_-]?key|credential|cookie|set-cookie|client[_-]?secret)\s*["'']?\s*[:=]|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:env:|export\s+|set\s+)[A-Za-z_][A-Za-z0-9_]*\s*=|https?://[^/\s]+@') { return $null }
    foreach ($rule in $script:SafeDiagnosticRules) {
        $m=[regex]::Match($Line,$rule.pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromMilliseconds(100))
        if ($m.Success) {
            $safe=$m.Result($rule.template)
            if ($safe -match '^TypeScript TS[0-9]{4,5}$') {
                $location=[regex]::Match($Line,'\(([0-9]{1,6}),([0-9]{1,6})\)\s*:\s*(?:error\s+)?TS[0-9]{4,5}\s*:',[Text.RegularExpressions.RegexOptions]::IgnoreCase,[TimeSpan]::FromMilliseconds(100))
                if ($location.Success) { $safe += ('; line '+$location.Groups[1].Value+', column '+$location.Groups[2].Value) }
            }
            return $safe
        }
    }
    return $null
}
function Get-SafeLogExcerpt([string]$LocalLog) {
    $items=[System.Collections.Generic.Queue[object]]::new()
    $read=0
    $matched=0
    $privateBlock=$false
    if (-not (Test-Path -LiteralPath $LocalLog -PathType Leaf)) { return @{status='unavailable';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    if ((Get-Item -LiteralPath $LocalLog).Length -gt 16777216) { return @{status='size-limit';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $reader=[IO.StreamReader]::new($LocalLog,[Text.Encoding]::UTF8,$true)
    try {
        while ($null -ne ($line=$reader.ReadLine())) {
            $read++
            if ($line -match '(?i)-----\s*BEGIN\s+[^-]*PRIVATE KEY') { $privateBlock=$true }
            if ($privateBlock) {
                if ($line -match '(?i)-----\s*END\s+[^-]*PRIVATE KEY') { $privateBlock=$false }
                continue
            }
            $safe=ConvertTo-SafeLogLine $line
            if ($null -ne $safe) {
                $matched++
                if ($items.Count -ge 500) { $null=$items.Dequeue() }
                $items.Enqueue([ordered]@{log_line=$read;message=$safe})
            }
        }
    } finally { $reader.Dispose() }
    return @{status='reconstructed';lines=$items.ToArray();read_lines=$read;omitted_lines=($read-$matched);truncated_matches=($matched-$items.Count)}
}

function Save-DiagnosticJournal([string]$LocalLog,[switch]$SelfTest) {
    $journalPath=[IO.Path]::ChangeExtension($LocalLog,'.diagnostic.json')
    try { $excerpt=Get-SafeLogExcerpt $LocalLog }
    catch { $excerpt=@{status='filter-error';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $report=[ordered]@{
        schema='iscribe-build-diagnostics/v2'
        script_version='7.0'
        utc=[DateTime]::UtcNow.ToString('o')
        route=$script:DiagnosticRoute
        revision=(Get-SafeSha $script:Revision)
        candidate_sha=(Get-SafeSha $script:PinnedSha)
        base_sha=(Get-SafeSha $script:BaseSha)
        pull_request=$script:SelectedPR
        remote_changed=$script:RemoteChanged
        ci_request_id=$(if ($script:CiRequestId -cmatch '^[0-9a-f]{32}$') { $script:CiRequestId } else { $null })
        ci_run_id=$(if ($script:CiRunId -match '^[0-9]+$') { $script:CiRunId } else { $null })
        outcome=$(if ($SelfTest) { 'self-test' } else { 'failed' })
        detail='allowlisted events and reconstructed technical excerpt only; full original retained locally'
        text_excerpt=$excerpt
        events=$script:DiagnosticEvents.ToArray()
        omitted_events=$script:DiagnosticOmitted
    }
    [IO.File]::WriteAllText($journalPath,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    return $journalPath
}
function Get-VerifiedDiagnosticRepo {
    $repoInfo=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
    if ($repoInfo.ExitCode -ne 0 -or -not $repoInfo.Text) {
        Write-Warning ('Диагностический репозиторий недоступен: '+$repoInfo.Kind+'. Проверьте существование и права gh.')
        return $null
    }
    $info=$repoInfo.Text | ConvertFrom-Json
    if ($info.full_name -ne $DiagnosticsRepo -or $info.private -ne $true -or $info.visibility -ne 'private' -or $info.permissions.push -ne $true -or $info.archived -eq $true -or -not $info.default_branch) {
        Write-Warning 'Не подтверждены приватность, активность и права записи репозитория. Ничего не отправлено.'
        return $null
    }
    return $info
}
function Get-GitBlobSha([byte[]]$Bytes) {
    # GitHub contents API uses Git blob SHA-1, not SHA-1 of raw file bytes.
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $buffer=[byte[]]::new($header.Length+$Bytes.Length)
    [Buffer]::BlockCopy($header,0,$buffer,0,$header.Length)
    [Buffer]::BlockCopy($Bytes,0,$buffer,$header.Length,$Bytes.Length)
    $sha=[Security.Cryptography.SHA1]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($buffer))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-DiagnosticRemoteState([string]$Path,[string]$Branch,[string]$ExpectedSha) {
    $r=Invoke-GhApiRead ($Path+'?ref='+[uri]::EscapeDataString($Branch))
    if ($r.ExitCode -ne 0) {
        if ($r.Kind -eq 'not-found') { return 'absent' }
        return 'unknown'
    }
    try {
        $file=$r.Text | ConvertFrom-Json
        if ($file.type -ceq 'file' -and $file.sha -ceq $ExpectedSha) { return 'matched' }
        return 'conflict'
    } catch { return 'unknown' }
}
function Upload-DiagnosticJournal([string]$JournalPath) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { Write-Host 'Отправка диагностики отключена.'; return $false }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { Write-Warning 'gh.exe недоступен; диагностический журнал сохранён локально.'; return $false }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { Write-Warning 'Требуется отдельный приватный репозиторий диагностики.'; return $false }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { return $false }
    $bytes=[IO.File]::ReadAllBytes($JournalPath)
    if ($bytes.Length -gt 2097152) { Write-Warning 'Диагностический журнал превышает лимит 2 МБ; отправка отменена.'; return $false }
    $expected=Get-GitBlobSha $bytes
    $branch=[string]$info.default_branch
    # Stable filename for these exact bytes: all retries use the same path.
    $report=$null
    try { $report=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { throw 'Некорректный диагностический JSON.' }
    $utc=[DateTimeOffset]::Parse([string]$report.utc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    $prefix='failures'
    $label='failure'
    if ($report.outcome -ceq 'self-test') { $prefix='checks'; $label='check' }
    elseif ($report.outcome -cne 'failed') { throw 'Неизвестный тип диагностического отчёта.' }
    $remotePath=$prefix+'/'+$utc.ToString('yyyy-MM')+'/'+$label+'-'+$utc.ToString('yyyyMMdd-HHmmss')+'-'+$expected+'.json'
    $path='repos/'+$DiagnosticsRepo+'/contents/'+$remotePath
    $url='https://github.com/'+$DiagnosticsRepo+'/blob/'+$branch+'/'+$remotePath
    $payload=@{message='Add structured build failure diagnostic [skip ci]';content=[Convert]::ToBase64String($bytes);branch=$branch}
    $json=Join-Path $env:TEMP ('iscribe-gh-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        [IO.File]::WriteAllText($json,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        for ($attempt=1; $attempt -le 3; $attempt++) {
            # Recheck the privacy and access gate before every write.
            $current=Get-VerifiedDiagnosticRepo
            if (-not $current -or $current.default_branch -cne $branch) { Write-Warning 'Репозиторий или ветка изменились. Отправка остановлена.'; return $false }
            $before=Get-DiagnosticRemoteState $path $branch $expected
            if ($before -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (уже записан)"; return $true }
            if ($before -ne 'absent') { Write-Warning 'Не подтверждено отсутствие файла или обнаружен конфликт. Запись запрещена.'; return $false }
            # Create only: no sha field, no overwriting an existing file.
            $result=Invoke-GhApiOnce @('api','-X','PUT',$path,'--input',$json)
            # Always confirm read-back of exact contents, even if PUT reported success.
            # A timeout can mean the server already committed the file.
            # Reconcile by exact path and blob hash before allowing retry.
            $after=Get-DiagnosticRemoteState $path $branch $expected
            if ($after -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (запись подтверждена)"; return $true }
            if ($after -ne 'absent' -or $result.Kind -ne 'transient' -or $attempt -eq 3) {
                Write-Warning 'Отправка не подтверждена или повтор небезопасен. Локальная копия сохранена.'
                return $false
            }
            Add-DiagnosticEvent 'api-retry' 'upload-transient' $result.ExitCode
            Wait-ApiRetry $attempt
        }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
    return $false
}

function Invoke-DiagnosticsCheck([bool]$Provision) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { throw 'Для проверки отправки диагностика должна быть включена.' }
    if ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate) { throw 'Режим диагностики не принимает параметры интеграции.' }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { throw 'Требуется отдельный приватный репозиторий.' }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { throw 'Не установлен GitHub CLI (gh.exe).' }
    if ((Capture 'gh.exe' @('auth','status','--hostname','github.com')).ExitCode -ne 0) { throw 'GitHub CLI не авторизован. Выполните gh auth login.' }
    if ($Provision) {
        if ($DiagnosticsRepo -cne 'AlmazovAN/iScribe-diagnostics') { throw 'DiagnosticsSetup разрешён только для штатного диагностического репозитория.' }
        $probe=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
        if ($probe.Kind -eq 'not-found') {
            # 404 may mean missing repository or insufficient access. The create
            # request is explicit, private, and never modifies an existing repo.
            Write-Host "Создание приватного репозитория $DiagnosticsRepo (одна попытка)"
            $creation=Capture 'gh.exe' @('repo','create',$DiagnosticsRepo,'--private','--add-readme')
            if ($creation.ExitCode -ne 0) { Write-Warning 'Создание не подтверждено; проверяем фактическое состояние без повторного создания.' }
        } elseif ($probe.ExitCode -ne 0) {
            throw ('Не удалось проверить существование репозитория: '+$probe.Kind)
        }
    }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { throw 'Приватный диагностический репозиторий с правами записи не подтверждён.' }
    $script:DiagnosticRoute='diagnostics-check'
    $script:DiagnosticStage='self-test'
    Add-DiagnosticEvent 'self-test' 'synthetic-only'
    $sample=Join-Path $env:TEMP ('iscribe-diag-check-'+[guid]::NewGuid().ToString('N')+'.log')
    $journal=[IO.Path]::ChangeExtension($sample,'.diagnostic.json')
    try {
        # Synthetic fixture only, no local source paths, personal data or real credentials.
        [IO.File]::WriteAllLines($sample,[string[]]@(
            'HTTP 404',
            'example.ts(12,3): error TS2322: synthetic message',
            'Authorization: Bearer synthetic-only-0000',
            'UNRECOGNIZED_SYNTHETIC_TEXT'
        ),[Text.UTF8Encoding]::new($false))
        $journal=Save-DiagnosticJournal $sample -SelfTest
        $data=[IO.File]::ReadAllText($journal)
        $report=$data | ConvertFrom-Json
        $messages=@($report.text_excerpt.lines | ForEach-Object { $_.message })
        if ($report.outcome -cne 'self-test' -or $report.text_excerpt.status -cne 'reconstructed' -or
            $messages.Count -ne 2 -or $messages[0] -cne 'HTTP 404' -or
            $messages[1] -cne 'TypeScript TS2322; line 12, column 3' -or
            $data.Contains('synthetic-only-0000') -or $data.Contains('UNRECOGNIZED_SYNTHETIC_TEXT') -or $data.Contains('example.ts')) {
            throw 'Проверка фильтрации не пройдена. Отправка запрещена.'
        }
        if (-not (Upload-DiagnosticJournal $journal)) { throw 'Тестовая запись или обратное чтение не подтверждены.' }
        Write-Host 'DIAGNOSTICS CHECK PASS: приватность, фильтрация, запись и SHA при обратном чтении подтверждены.' -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $sample,$journal -Force -ErrorAction SilentlyContinue
    }
}
if ($Mode -in @('DiagnosticsSetup','DiagnosticsCheck')) {
    try {
        Invoke-DiagnosticsCheck ($Mode -eq 'DiagnosticsSetup')
        exit 0
    } catch {
        Write-Warning ('DIAGNOSTICS CHECK FAIL: '+$_.Exception.Message)
        exit 1
    }
}

try {
    $LogWriter=[IO.StreamWriter]::new($FullLog,$false,[Text.UTF8Encoding]::new($false))
    Step '1. Подготовка и синхронизация исходного main'
    if ($Mode -eq 'MainOnly' -and ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate)) { throw 'MainOnly не принимает параметры интеграции.' }
    Assert-Tools ($Mode -ne 'MainOnly')
    # Standard build must not inherit an opt-in profiling build flag.
    Remove-Item Env:VITE_GPU_PROFILE -ErrorAction SilentlyContinue
    $Root=Resolve-Project
    Set-Location -LiteralPath $Root
    Log "Репозиторий: $Root"
    $Revision=Sync-Main
    $BaseSha=$Revision
    Log "Исходный main: $BaseSha"
    $node=Capture 'node.exe' @('--version'); Log ('Node: '+$node.Text+' (CI использует Node 22)')
    $pr=$null
    if ($Mode -ne 'MainOnly') { Step '2. Поиск интеграционного PR'; $pr=Find-Candidate }
    $route='MainOnly'
    if ($pr) {
        $SelectedPR=[int]$pr.number
        $PinnedSha=[string]$pr.head.sha
        if ($PinnedSha -notmatch '^[0-9a-f]{40}$') { throw 'GitHub не вернул корректный SHA кандидата.' }
        if ($pr.merged -eq $true -or $pr.state -eq 'closed') {
            if ($pr.merged -ne $true -or -not (Test-Ancestor $PinnedSha $BaseSha)) { throw 'PR закрыт без подтверждённого включения его head в main.' }
            Log 'Кандидат уже в main. Повторное слияние не требуется.'
        } else {
            if ($pr.state -ne 'open' -or $pr.base.sha -ne $BaseSha) { throw 'PR не соответствует актуальному main.' }
            Run 'git.exe' @('fetch','origin',('refs/heads/'+$pr.head.ref+':refs/remotes/origin/'+$pr.head.ref))
            if ((Git-Text @('rev-parse',('refs/remotes/origin/'+$pr.head.ref))) -ne $PinnedSha) { throw 'Ветка изменилась во время получения. Повторите запуск.' }
            if (-not (Test-Ancestor $BaseSha $PinnedSha)) { throw 'Кандидат не содержит актуальный main. Сначала нужна новая интеграционная ветка.' }
            Assert-ManifestStages $SelectedManifest
            if (Test-Ancestor $PinnedSha $BaseSha) { Log 'Кандидат уже в main.' }
            else {
                Log "PR #${SelectedPR}: $($pr.html_url)"
                $route=$Mode
                if ($route -eq 'Auto') {
                    Log '1 — локальный конвейер (по умолчанию); 2 — GitHub Actions (новый запуск); 0 — отмена.'
                    $answer=Read-Host 'Выберите маршрут [1]'
                    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq '1') { $route='Local' }
                    elseif ($answer -eq '2') { $route='Online' }
                    else { $ExitCode=2; throw 'Операция отменена.' }
                }
                if ($route -eq 'Local') { Log 'Выбран локальный CI. GitHub Actions не запускается и не проверяется.' }
                else { Log 'Выбран облачный CI. После подтверждения будет запрошен один новый запуск.' }
                Confirm-Integration $route
            }
        }
    } else { Log 'Интеграционный кандидат не выбран. Сборка актуального main без слияния.' }
    $DiagnosticRoute=$route
    if ($route -eq 'Local') {
        Step '3. Локальный кандидат слияния в изолированном worktree'
        if ((Git-Text @('rev-parse',($BaseSha+':.github/workflows'))) -ne (Git-Text @('rev-parse',($PinnedSha+':.github/workflows')))) { throw 'Workflow changes require a separate reviewed integration; local push blocked.' }
        New-Worktree $BaseSha
        Run 'git.exe' @('merge','--no-ff','--no-edit',$PinnedSha)
        $Revision=Git-Text @('rev-parse','HEAD')
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'Кандидат отсутствует в локальном merge commit.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево слияния отличается от кандидата.' }
        Run-LocalCI
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
        Step '4. Отправка точного проверенного merge commit в GitHub main'
        $null=Assert-CurrentCandidate $true
        # Normal fast-forward push only. GitHub protection rules are respected.
        # Do NOT use --force, --admin, or bypass required checks.
        Run 'git.exe' @('push','origin',($Revision+':refs/heads/main'))
        $RemoteChanged=$true
        if ((Fetch-Main) -ne $Revision) { throw 'Удалённый main отличается от проверенного merge commit.' }
        Log 'Проверенный локальный merge commit находится в GitHub main.'
    } elseif ($route -eq 'Online') {
        Step '3. GitHub Actions и слияние PR'
        $fresh=Assert-CurrentCandidate
        if ($fresh.draft) { Run 'gh.exe' @('pr','ready',[string]$SelectedPR,'--repo',$Repository) }
        $fresh=Assert-CurrentCandidate $true
        Start-CloudCI $fresh
        $null=Wait-CI
        $null=Assert-CurrentCandidate $true
        Run 'gh.exe' @('pr','merge',[string]$SelectedPR,'--repo',$Repository,'--merge','--match-head-commit',$PinnedSha)
        $RemoteChanged=$true
        $Revision=Sync-Main
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'GitHub не подтвердил включение точного кандидата в main.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево main после слияния отличается от проверенного кандидата. Сборка остановлена до проверки.' }
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    } else {
        Step '3. Только синхронизация и сборка main'
        $Revision=Sync-Main
        Log 'Статус прежних CI не подтверждается этим маршрутом; выполняются сборка и release:check.'
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    }
    Install-Html $source $Revision
    $ExitCode=0
} catch {
    Add-DiagnosticEvent 'failure' (Get-DiagnosticCode ([string]$_.Exception.Message))
    Log ("FAILED [$StepName]: "+$_.Exception.Message)
    if ($RemoteChanged) { Log 'ВНИМАНИЕ: удалённый main уже изменён. Автоматический откат Git запрещён. После исправления повторите синхронизацию/сборку.' }
    else { Log 'Скрипт не подтвердил изменение удалённого main. При сетевой ошибке проверьте его фактический SHA.' }
    Log 'Предыдущий HTML не считается новым релизом.'
} finally {
    if ($TempHtml -and (Test-Path -LiteralPath $TempHtml)) { Remove-Item -LiteralPath $TempHtml -Force -ErrorAction SilentlyContinue }
    if ($WorktreeRegistered -and $Root) {
        try {
            Set-Location -LiteralPath $Root
            # Only the isolated worktree created by THIS invocation is removed.
            Run 'git.exe' @('worktree','remove','--force',$Worktree)
        } catch { Write-Warning "Не удалось убрать временный worktree: $Worktree. Основной проект не удалён." }
    }
    $env:VITE_GPU_PROFILE=$PriorGpuProfile
    try { Set-Location -LiteralPath $InitialLocation } catch {}
    if ($LogWriter) { $LogWriter.Dispose(); $LogWriter=$null }
    if ($ExitCode -eq 0 -or $ExitCode -eq 2) { Remove-Item -LiteralPath $FullLog -Force -ErrorAction SilentlyContinue }
    else {
        try {
            New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
            $local=Join-Path $LogRoot ('failure-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)+'.log')
            Move-Item -LiteralPath $FullLog -Destination $local
            Write-Host "Локальный журнал ошибки: $local" -ForegroundColor Yellow
            try {
                $journal=Save-DiagnosticJournal $local
                Write-Host "Локальная диагностическая копия: $journal"
                $null=Upload-DiagnosticJournal $journal
            } catch { Write-Warning 'Не удалось создать или отправить диагностическую копию. Оригинальный журнал сохранён.' }
            Get-ChildItem -LiteralPath $LogRoot -Filter 'failure-*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Журнал оставлен: $FullLog" }
    }
}
exit $ExitCode
; template='Source: scripts/Test-CI06.ps1' }
        @{ pattern='(?i)^\s*([0-9]{1,6})\s+char:\s*([0-9]{1,6})\s*        @{ pattern='(?i)\bTS([0-9]{4,5})\s*:'; template='TypeScript TS$1' }
        @{ pattern='(?i)\bnpm\s+(?:ERR!|error)\s+code\s+(EACCES|EPERM|ENOENT|ENOSPC|ENOMEM|ERESOLVE|EINTEGRITY|ECONNRESET|ETIMEDOUT|ENOTFOUND|E401|E403|E404|ELIFECYCLE)\b'; template='npm error code $1' }
        @{ pattern='(?i)^\s*(?:Test Files|Tests)\s+([0-9]{1,6})\s+(passed|failed)\s+\(([0-9]{1,6})\)\s*$'; template='Tests: $1 $2 ($3 total)' }
        @{ pattern='(?i)^\s*([0-9]{1,6})\s+(passed|failed|skipped)\s*(?:\([0-9.]+(?:ms|s|m)\))?\s*$'; template='Tests: $1 $2' }
        @{ pattern='(?i)\bHTTP\s+(400|401|403|404|408|409|422|429|500|502|503|504)\b'; template='HTTP $1' }
        @{ pattern='(?i)^\s*Node:\s*v([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\s+\(CI использует Node 22\)\s*$'; template='Node v$1' }
        @{ pattern='(?i)^\s*\+\s*(npm\.cmd|git\.exe|npx\.cmd|gh\.exe)\s+'; template='Command: $1 (arguments omitted)' }
        @{ pattern='(?i)\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENOSPC|ENOMEM|EACCES|EPERM|ENOENT|ERESOLVE|EINTEGRITY)\b'; template='System error: $1' }
        @{ pattern='(?i)Cannot bind argument to parameter .LiteralPath. because it is an empty string'; template='PowerShell: LiteralPath is empty' }
        @{ pattern='(?i)Cannot find path|PathNotFound|ItemNotFound'; template='PowerShell: path not found' }
        @{ pattern='(?i)JavaScript heap out of memory|out of memory|heap limit'; template='Memory exhausted' }
        @{ pattern='(?i)Permission denied|Access is denied'; template='Access denied' }
        @{ pattern='(?i)authentication failed|не авторизован'; template='Authentication failed' }
        @{ pattern='(?i)Could not resolve host|connection timed out'; template='Network resolution or timeout failure' }
        @{ pattern='(?i)non-fast-forward|fetch first'; template='Git: non-fast-forward' }
        @{ pattern='(?i)protected branch|GH006|GH013'; template='Git: branch protection rejected operation' }
        @{ pattern='(?i)merge conflict|CONFLICT \('; template='Git: merge conflict' }
        @{ pattern='(?i)AssertionError|expect\(.*\)'; template='Test assertion failed' }
        @{ pattern='(?i)CI не пройден'; template='Cloud CI failed' }
        @{ pattern='(?i)Время ожидания CI истекло'; template='Cloud CI timed out' }
        @{ pattern='(?i)Конфигурация CI кандидата отличается'; template='CI workflow differs from base' }
        @{ pattern='(?i)Кандидат не содержит актуальный main|origin/main изменился|PR или main изменился'; template='Candidate or main changed' }
        @{ pattern='(?i)Не найдена встроенная точка входа|Повреждён встроенный блок|не обнаружена ревизия сборки'; template='HTML validation failed' }
        @{ pattern='(?i)Не установлена программа'; template='Required tool not installed' }
        @{ pattern='(?i)Не найден локальный репозиторий'; template='Local project not found' }
        @{ pattern='(?i)Есть изменения отслеживаемых файлов'; template='Tracked working tree is dirty' }
)
function ConvertTo-SafeLogLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -gt 8192) { return $null }
    if ($Line -match '(?i)-----\s*(BEGIN|END)\s+[^-]*PRIVATE KEY|authorization\s*[:=]|(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|(?:token|secret|password|passwd|api[_-]?key|credential|cookie|set-cookie|client[_-]?secret)\s*["'']?\s*[:=]|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:env:|export\s+|set\s+)[A-Za-z_][A-Za-z0-9_]*\s*=|https?://[^/\s]+@') { return $null }
    foreach ($rule in $script:SafeDiagnosticRules) {
        $m=[regex]::Match($Line,$rule.pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromMilliseconds(100))
        if ($m.Success) {
            $safe=$m.Result($rule.template)
            if ($safe -match '^TypeScript TS[0-9]{4,5}$') {
                $location=[regex]::Match($Line,'\(([0-9]{1,6}),([0-9]{1,6})\)\s*:\s*(?:error\s+)?TS[0-9]{4,5}\s*:',[Text.RegularExpressions.RegexOptions]::IgnoreCase,[TimeSpan]::FromMilliseconds(100))
                if ($location.Success) { $safe += ('; line '+$location.Groups[1].Value+', column '+$location.Groups[2].Value) }
            }
            return $safe
        }
    }
    return $null
}
function Get-SafeLogExcerpt([string]$LocalLog) {
    $items=[System.Collections.Generic.Queue[object]]::new()
    $read=0
    $matched=0
    $privateBlock=$false
    if (-not (Test-Path -LiteralPath $LocalLog -PathType Leaf)) { return @{status='unavailable';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    if ((Get-Item -LiteralPath $LocalLog).Length -gt 16777216) { return @{status='size-limit';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $reader=[IO.StreamReader]::new($LocalLog,[Text.Encoding]::UTF8,$true)
    try {
        while ($null -ne ($line=$reader.ReadLine())) {
            $read++
            if ($line -match '(?i)-----\s*BEGIN\s+[^-]*PRIVATE KEY') { $privateBlock=$true }
            if ($privateBlock) {
                if ($line -match '(?i)-----\s*END\s+[^-]*PRIVATE KEY') { $privateBlock=$false }
                continue
            }
            $safe=ConvertTo-SafeLogLine $line
            if ($null -ne $safe) {
                $matched++
                if ($items.Count -ge 500) { $null=$items.Dequeue() }
                $items.Enqueue([ordered]@{log_line=$read;message=$safe})
            }
        }
    } finally { $reader.Dispose() }
    return @{status='reconstructed';lines=$items.ToArray();read_lines=$read;omitted_lines=($read-$matched);truncated_matches=($matched-$items.Count)}
}

function Save-DiagnosticJournal([string]$LocalLog,[switch]$SelfTest) {
    $journalPath=[IO.Path]::ChangeExtension($LocalLog,'.diagnostic.json')
    try { $excerpt=Get-SafeLogExcerpt $LocalLog }
    catch { $excerpt=@{status='filter-error';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $report=[ordered]@{
        schema='iscribe-build-diagnostics/v2'
        script_version='6.4'
        utc=[DateTime]::UtcNow.ToString('o')
        route=$script:DiagnosticRoute
        revision=(Get-SafeSha $script:Revision)
        candidate_sha=(Get-SafeSha $script:PinnedSha)
        base_sha=(Get-SafeSha $script:BaseSha)
        pull_request=$script:SelectedPR
        remote_changed=$script:RemoteChanged
        ci_request_id=$(if ($script:CiRequestId -cmatch '^[0-9a-f]{32}$') { $script:CiRequestId } else { $null })
        ci_run_id=$(if ($script:CiRunId -match '^[0-9]+$') { $script:CiRunId } else { $null })
        outcome=$(if ($SelfTest) { 'self-test' } else { 'failed' })
        detail='allowlisted events and reconstructed technical excerpt only; full original retained locally'
        text_excerpt=$excerpt
        events=$script:DiagnosticEvents.ToArray()
        omitted_events=$script:DiagnosticOmitted
    }
    [IO.File]::WriteAllText($journalPath,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    return $journalPath
}
function Get-VerifiedDiagnosticRepo {
    $repoInfo=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
    if ($repoInfo.ExitCode -ne 0 -or -not $repoInfo.Text) {
        Write-Warning ('Диагностический репозиторий недоступен: '+$repoInfo.Kind+'. Проверьте существование и права gh.')
        return $null
    }
    $info=$repoInfo.Text | ConvertFrom-Json
    if ($info.full_name -ne $DiagnosticsRepo -or $info.private -ne $true -or $info.visibility -ne 'private' -or $info.permissions.push -ne $true -or $info.archived -eq $true -or -not $info.default_branch) {
        Write-Warning 'Не подтверждены приватность, активность и права записи репозитория. Ничего не отправлено.'
        return $null
    }
    return $info
}
function Get-GitBlobSha([byte[]]$Bytes) {
    # GitHub contents API uses Git blob SHA-1, not SHA-1 of raw file bytes.
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $buffer=[byte[]]::new($header.Length+$Bytes.Length)
    [Buffer]::BlockCopy($header,0,$buffer,0,$header.Length)
    [Buffer]::BlockCopy($Bytes,0,$buffer,$header.Length,$Bytes.Length)
    $sha=[Security.Cryptography.SHA1]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($buffer))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-DiagnosticRemoteState([string]$Path,[string]$Branch,[string]$ExpectedSha) {
    $r=Invoke-GhApiRead ($Path+'?ref='+[uri]::EscapeDataString($Branch))
    if ($r.ExitCode -ne 0) {
        if ($r.Kind -eq 'not-found') { return 'absent' }
        return 'unknown'
    }
    try {
        $file=$r.Text | ConvertFrom-Json
        if ($file.type -ceq 'file' -and $file.sha -ceq $ExpectedSha) { return 'matched' }
        return 'conflict'
    } catch { return 'unknown' }
}
function Upload-DiagnosticJournal([string]$JournalPath) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { Write-Host 'Отправка диагностики отключена.'; return $false }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { Write-Warning 'gh.exe недоступен; диагностический журнал сохранён локально.'; return $false }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { Write-Warning 'Требуется отдельный приватный репозиторий диагностики.'; return $false }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { return $false }
    $bytes=[IO.File]::ReadAllBytes($JournalPath)
    if ($bytes.Length -gt 2097152) { Write-Warning 'Диагностический журнал превышает лимит 2 МБ; отправка отменена.'; return $false }
    $expected=Get-GitBlobSha $bytes
    $branch=[string]$info.default_branch
    # Stable filename for these exact bytes: all retries use the same path.
    $report=$null
    try { $report=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { throw 'Некорректный диагностический JSON.' }
    $utc=[DateTimeOffset]::Parse([string]$report.utc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    $prefix='failures'
    $label='failure'
    if ($report.outcome -ceq 'self-test') { $prefix='checks'; $label='check' }
    elseif ($report.outcome -cne 'failed') { throw 'Неизвестный тип диагностического отчёта.' }
    $remotePath=$prefix+'/'+$utc.ToString('yyyy-MM')+'/'+$label+'-'+$utc.ToString('yyyyMMdd-HHmmss')+'-'+$expected+'.json'
    $path='repos/'+$DiagnosticsRepo+'/contents/'+$remotePath
    $url='https://github.com/'+$DiagnosticsRepo+'/blob/'+$branch+'/'+$remotePath
    $payload=@{message='Add structured build failure diagnostic [skip ci]';content=[Convert]::ToBase64String($bytes);branch=$branch}
    $json=Join-Path $env:TEMP ('iscribe-gh-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        [IO.File]::WriteAllText($json,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        for ($attempt=1; $attempt -le 3; $attempt++) {
            # Recheck the privacy and access gate before every write.
            $current=Get-VerifiedDiagnosticRepo
            if (-not $current -or $current.default_branch -cne $branch) { Write-Warning 'Репозиторий или ветка изменились. Отправка остановлена.'; return $false }
            $before=Get-DiagnosticRemoteState $path $branch $expected
            if ($before -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (уже записан)"; return $true }
            if ($before -ne 'absent') { Write-Warning 'Не подтверждено отсутствие файла или обнаружен конфликт. Запись запрещена.'; return $false }
            # Create only: no sha field, no overwriting an existing file.
            $result=Invoke-GhApiOnce @('api','-X','PUT',$path,'--input',$json)
            # Always confirm read-back of exact contents, even if PUT reported success.
            # A timeout can mean the server already committed the file.
            # Reconcile by exact path and blob hash before allowing retry.
            $after=Get-DiagnosticRemoteState $path $branch $expected
            if ($after -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (запись подтверждена)"; return $true }
            if ($after -ne 'absent' -or $result.Kind -ne 'transient' -or $attempt -eq 3) {
                Write-Warning 'Отправка не подтверждена или повтор небезопасен. Локальная копия сохранена.'
                return $false
            }
            Add-DiagnosticEvent 'api-retry' 'upload-transient' $result.ExitCode
            Wait-ApiRetry $attempt
        }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
    return $false
}

function Invoke-DiagnosticsCheck([bool]$Provision) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { throw 'Для проверки отправки диагностика должна быть включена.' }
    if ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate) { throw 'Режим диагностики не принимает параметры интеграции.' }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { throw 'Требуется отдельный приватный репозиторий.' }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { throw 'Не установлен GitHub CLI (gh.exe).' }
    if ((Capture 'gh.exe' @('auth','status','--hostname','github.com')).ExitCode -ne 0) { throw 'GitHub CLI не авторизован. Выполните gh auth login.' }
    if ($Provision) {
        if ($DiagnosticsRepo -cne 'AlmazovAN/iScribe-diagnostics') { throw 'DiagnosticsSetup разрешён только для штатного диагностического репозитория.' }
        $probe=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
        if ($probe.Kind -eq 'not-found') {
            # 404 may mean missing repository or insufficient access. The create
            # request is explicit, private, and never modifies an existing repo.
            Write-Host "Создание приватного репозитория $DiagnosticsRepo (одна попытка)"
            $creation=Capture 'gh.exe' @('repo','create',$DiagnosticsRepo,'--private','--add-readme')
            if ($creation.ExitCode -ne 0) { Write-Warning 'Создание не подтверждено; проверяем фактическое состояние без повторного создания.' }
        } elseif ($probe.ExitCode -ne 0) {
            throw ('Не удалось проверить существование репозитория: '+$probe.Kind)
        }
    }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { throw 'Приватный диагностический репозиторий с правами записи не подтверждён.' }
    $script:DiagnosticRoute='diagnostics-check'
    $script:DiagnosticStage='self-test'
    Add-DiagnosticEvent 'self-test' 'synthetic-only'
    $sample=Join-Path $env:TEMP ('iscribe-diag-check-'+[guid]::NewGuid().ToString('N')+'.log')
    $journal=[IO.Path]::ChangeExtension($sample,'.diagnostic.json')
    try {
        # Synthetic fixture only, no local source paths, personal data or real credentials.
        [IO.File]::WriteAllLines($sample,[string[]]@(
            'HTTP 404',
            'example.ts(12,3): error TS2322: synthetic message',
            'Authorization: Bearer synthetic-only-0000',
            'UNRECOGNIZED_SYNTHETIC_TEXT'
        ),[Text.UTF8Encoding]::new($false))
        $journal=Save-DiagnosticJournal $sample -SelfTest
        $data=[IO.File]::ReadAllText($journal)
        $report=$data | ConvertFrom-Json
        $messages=@($report.text_excerpt.lines | ForEach-Object { $_.message })
        if ($report.outcome -cne 'self-test' -or $report.text_excerpt.status -cne 'reconstructed' -or
            $messages.Count -ne 2 -or $messages[0] -cne 'HTTP 404' -or
            $messages[1] -cne 'TypeScript TS2322; line 12, column 3' -or
            $data.Contains('synthetic-only-0000') -or $data.Contains('UNRECOGNIZED_SYNTHETIC_TEXT') -or $data.Contains('example.ts')) {
            throw 'Проверка фильтрации не пройдена. Отправка запрещена.'
        }
        if (-not (Upload-DiagnosticJournal $journal)) { throw 'Тестовая запись или обратное чтение не подтверждены.' }
        Write-Host 'DIAGNOSTICS CHECK PASS: приватность, фильтрация, запись и SHA при обратном чтении подтверждены.' -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $sample,$journal -Force -ErrorAction SilentlyContinue
    }
}
if ($Mode -in @('DiagnosticsSetup','DiagnosticsCheck')) {
    try {
        Invoke-DiagnosticsCheck ($Mode -eq 'DiagnosticsSetup')
        exit 0
    } catch {
        Write-Warning ('DIAGNOSTICS CHECK FAIL: '+$_.Exception.Message)
        exit 1
    }
}

try {
    $LogWriter=[IO.StreamWriter]::new($FullLog,$false,[Text.UTF8Encoding]::new($false))
    Step '1. Подготовка и синхронизация исходного main'
    if ($Mode -eq 'MainOnly' -and ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate)) { throw 'MainOnly не принимает параметры интеграции.' }
    Assert-Tools ($Mode -ne 'MainOnly')
    # Standard build must not inherit an opt-in profiling build flag.
    Remove-Item Env:VITE_GPU_PROFILE -ErrorAction SilentlyContinue
    $Root=Resolve-Project
    Set-Location -LiteralPath $Root
    Log "Репозиторий: $Root"
    $Revision=Sync-Main
    $BaseSha=$Revision
    Log "Исходный main: $BaseSha"
    $node=Capture 'node.exe' @('--version'); Log ('Node: '+$node.Text+' (CI использует Node 22)')
    $pr=$null
    if ($Mode -ne 'MainOnly') { Step '2. Поиск интеграционного PR'; $pr=Find-Candidate }
    $route='MainOnly'
    if ($pr) {
        $SelectedPR=[int]$pr.number
        $PinnedSha=[string]$pr.head.sha
        if ($PinnedSha -notmatch '^[0-9a-f]{40}$') { throw 'GitHub не вернул корректный SHA кандидата.' }
        if ($pr.merged -eq $true -or $pr.state -eq 'closed') {
            if ($pr.merged -ne $true -or -not (Test-Ancestor $PinnedSha $BaseSha)) { throw 'PR закрыт без подтверждённого включения его head в main.' }
            Log 'Кандидат уже в main. Повторное слияние не требуется.'
        } else {
            if ($pr.state -ne 'open' -or $pr.base.sha -ne $BaseSha) { throw 'PR не соответствует актуальному main.' }
            Run 'git.exe' @('fetch','origin',('refs/heads/'+$pr.head.ref+':refs/remotes/origin/'+$pr.head.ref))
            if ((Git-Text @('rev-parse',('refs/remotes/origin/'+$pr.head.ref))) -ne $PinnedSha) { throw 'Ветка изменилась во время получения. Повторите запуск.' }
            if (-not (Test-Ancestor $BaseSha $PinnedSha)) { throw 'Кандидат не содержит актуальный main. Сначала нужна новая интеграционная ветка.' }
            Assert-ManifestStages $SelectedManifest
            if (Test-Ancestor $PinnedSha $BaseSha) { Log 'Кандидат уже в main.' }
            else {
                Log "PR #${SelectedPR}: $($pr.html_url)"
                $route=$Mode
                if ($route -eq 'Auto') {
                    Log '1 — локальный конвейер (по умолчанию); 2 — GitHub Actions (новый запуск); 0 — отмена.'
                    $answer=Read-Host 'Выберите маршрут [1]'
                    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq '1') { $route='Local' }
                    elseif ($answer -eq '2') { $route='Online' }
                    else { $ExitCode=2; throw 'Операция отменена.' }
                }
                if ($route -eq 'Local') { Log 'Выбран локальный CI. GitHub Actions не запускается и не проверяется.' }
                else { Log 'Выбран облачный CI. После подтверждения будет запрошен один новый запуск.' }
                Confirm-Integration $route
            }
        }
    } else { Log 'Интеграционный кандидат не выбран. Сборка актуального main без слияния.' }
    $DiagnosticRoute=$route
    if ($route -eq 'Local') {
        Step '3. Локальный кандидат слияния в изолированном worktree'
        if ((Git-Text @('rev-parse',($BaseSha+':.github/workflows'))) -ne (Git-Text @('rev-parse',($PinnedSha+':.github/workflows')))) { throw 'Workflow changes require a separate reviewed integration; local push blocked.' }
        New-Worktree $BaseSha
        Run 'git.exe' @('merge','--no-ff','--no-edit',$PinnedSha)
        $Revision=Git-Text @('rev-parse','HEAD')
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'Кандидат отсутствует в локальном merge commit.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево слияния отличается от кандидата.' }
        Run-LocalCI
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
        Step '4. Отправка точного проверенного merge commit в GitHub main'
        $null=Assert-CurrentCandidate $true
        # Normal fast-forward push only. GitHub protection rules are respected.
        # Do NOT use --force, --admin, or bypass required checks.
        Run 'git.exe' @('push','origin',($Revision+':refs/heads/main'))
        $RemoteChanged=$true
        if ((Fetch-Main) -ne $Revision) { throw 'Удалённый main отличается от проверенного merge commit.' }
        Log 'Проверенный локальный merge commit находится в GitHub main.'
    } elseif ($route -eq 'Online') {
        Step '3. GitHub Actions и слияние PR'
        $fresh=Assert-CurrentCandidate
        if ($fresh.draft) { Run 'gh.exe' @('pr','ready',[string]$SelectedPR,'--repo',$Repository) }
        $fresh=Assert-CurrentCandidate $true
        Start-CloudCI $fresh
        $null=Wait-CI
        $null=Assert-CurrentCandidate $true
        Run 'gh.exe' @('pr','merge',[string]$SelectedPR,'--repo',$Repository,'--merge','--match-head-commit',$PinnedSha)
        $RemoteChanged=$true
        $Revision=Sync-Main
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'GitHub не подтвердил включение точного кандидата в main.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево main после слияния отличается от проверенного кандидата. Сборка остановлена до проверки.' }
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    } else {
        Step '3. Только синхронизация и сборка main'
        $Revision=Sync-Main
        Log 'Статус прежних CI не подтверждается этим маршрутом; выполняются сборка и release:check.'
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    }
    Install-Html $source $Revision
    $ExitCode=0
} catch {
    Add-DiagnosticEvent 'failure' (Get-DiagnosticCode ([string]$_.Exception.Message))
    Log ("FAILED [$StepName]: "+$_.Exception.Message)
    if ($RemoteChanged) { Log 'ВНИМАНИЕ: удалённый main уже изменён. Автоматический откат Git запрещён. После исправления повторите синхронизацию/сборку.' }
    else { Log 'Скрипт не подтвердил изменение удалённого main. При сетевой ошибке проверьте его фактический SHA.' }
    Log 'Предыдущий HTML не считается новым релизом.'
} finally {
    if ($TempHtml -and (Test-Path -LiteralPath $TempHtml)) { Remove-Item -LiteralPath $TempHtml -Force -ErrorAction SilentlyContinue }
    if ($WorktreeRegistered -and $Root) {
        try {
            Set-Location -LiteralPath $Root
            # Only the isolated worktree created by THIS invocation is removed.
            Run 'git.exe' @('worktree','remove','--force',$Worktree)
        } catch { Write-Warning "Не удалось убрать временный worktree: $Worktree. Основной проект не удалён." }
    }
    $env:VITE_GPU_PROFILE=$PriorGpuProfile
    try { Set-Location -LiteralPath $InitialLocation } catch {}
    if ($LogWriter) { $LogWriter.Dispose(); $LogWriter=$null }
    if ($ExitCode -eq 0 -or $ExitCode -eq 2) { Remove-Item -LiteralPath $FullLog -Force -ErrorAction SilentlyContinue }
    else {
        try {
            New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
            $local=Join-Path $LogRoot ('failure-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)+'.log')
            Move-Item -LiteralPath $FullLog -Destination $local
            Write-Host "Локальный журнал ошибки: $local" -ForegroundColor Yellow
            try {
                $journal=Save-DiagnosticJournal $local
                Write-Host "Локальная диагностическая копия: $journal"
                $null=Upload-DiagnosticJournal $journal
            } catch { Write-Warning 'Не удалось создать или отправить диагностическую копию. Оригинальный журнал сохранён.' }
            Get-ChildItem -LiteralPath $LogRoot -Filter 'failure-*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Журнал оставлен: $FullLog" }
    }
}
exit $ExitCode
; template='PowerShell location: line $1, column $2' }
        @{ pattern='(?i)^\s*FAIL\s+scripts/local-pipeline\.test\.mjs\s+>\s+PowerShell local pipeline regression suite\s*        @{ pattern='(?i)\bTS([0-9]{4,5})\s*:'; template='TypeScript TS$1' }
        @{ pattern='(?i)\bnpm\s+(?:ERR!|error)\s+code\s+(EACCES|EPERM|ENOENT|ENOSPC|ENOMEM|ERESOLVE|EINTEGRITY|ECONNRESET|ETIMEDOUT|ENOTFOUND|E401|E403|E404|ELIFECYCLE)\b'; template='npm error code $1' }
        @{ pattern='(?i)^\s*(?:Test Files|Tests)\s+([0-9]{1,6})\s+(passed|failed)\s+\(([0-9]{1,6})\)\s*$'; template='Tests: $1 $2 ($3 total)' }
        @{ pattern='(?i)^\s*([0-9]{1,6})\s+(passed|failed|skipped)\s*(?:\([0-9.]+(?:ms|s|m)\))?\s*$'; template='Tests: $1 $2' }
        @{ pattern='(?i)\bHTTP\s+(400|401|403|404|408|409|422|429|500|502|503|504)\b'; template='HTTP $1' }
        @{ pattern='(?i)^\s*Node:\s*v([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\s+\(CI использует Node 22\)\s*$'; template='Node v$1' }
        @{ pattern='(?i)^\s*\+\s*(npm\.cmd|git\.exe|npx\.cmd|gh\.exe)\s+'; template='Command: $1 (arguments omitted)' }
        @{ pattern='(?i)\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENOSPC|ENOMEM|EACCES|EPERM|ENOENT|ERESOLVE|EINTEGRITY)\b'; template='System error: $1' }
        @{ pattern='(?i)Cannot bind argument to parameter .LiteralPath. because it is an empty string'; template='PowerShell: LiteralPath is empty' }
        @{ pattern='(?i)Cannot find path|PathNotFound|ItemNotFound'; template='PowerShell: path not found' }
        @{ pattern='(?i)JavaScript heap out of memory|out of memory|heap limit'; template='Memory exhausted' }
        @{ pattern='(?i)Permission denied|Access is denied'; template='Access denied' }
        @{ pattern='(?i)authentication failed|не авторизован'; template='Authentication failed' }
        @{ pattern='(?i)Could not resolve host|connection timed out'; template='Network resolution or timeout failure' }
        @{ pattern='(?i)non-fast-forward|fetch first'; template='Git: non-fast-forward' }
        @{ pattern='(?i)protected branch|GH006|GH013'; template='Git: branch protection rejected operation' }
        @{ pattern='(?i)merge conflict|CONFLICT \('; template='Git: merge conflict' }
        @{ pattern='(?i)AssertionError|expect\(.*\)'; template='Test assertion failed' }
        @{ pattern='(?i)CI не пройден'; template='Cloud CI failed' }
        @{ pattern='(?i)Время ожидания CI истекло'; template='Cloud CI timed out' }
        @{ pattern='(?i)Конфигурация CI кандидата отличается'; template='CI workflow differs from base' }
        @{ pattern='(?i)Кандидат не содержит актуальный main|origin/main изменился|PR или main изменился'; template='Candidate or main changed' }
        @{ pattern='(?i)Не найдена встроенная точка входа|Повреждён встроенный блок|не обнаружена ревизия сборки'; template='HTML validation failed' }
        @{ pattern='(?i)Не установлена программа'; template='Required tool not installed' }
        @{ pattern='(?i)Не найден локальный репозиторий'; template='Local project not found' }
        @{ pattern='(?i)Есть изменения отслеживаемых файлов'; template='Tracked working tree is dirty' }
)
function ConvertTo-SafeLogLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -gt 8192) { return $null }
    if ($Line -match '(?i)-----\s*(BEGIN|END)\s+[^-]*PRIVATE KEY|authorization\s*[:=]|(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|(?:token|secret|password|passwd|api[_-]?key|credential|cookie|set-cookie|client[_-]?secret)\s*["'']?\s*[:=]|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:env:|export\s+|set\s+)[A-Za-z_][A-Za-z0-9_]*\s*=|https?://[^/\s]+@') { return $null }
    foreach ($rule in $script:SafeDiagnosticRules) {
        $m=[regex]::Match($Line,$rule.pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromMilliseconds(100))
        if ($m.Success) {
            $safe=$m.Result($rule.template)
            if ($safe -match '^TypeScript TS[0-9]{4,5}$') {
                $location=[regex]::Match($Line,'\(([0-9]{1,6}),([0-9]{1,6})\)\s*:\s*(?:error\s+)?TS[0-9]{4,5}\s*:',[Text.RegularExpressions.RegexOptions]::IgnoreCase,[TimeSpan]::FromMilliseconds(100))
                if ($location.Success) { $safe += ('; line '+$location.Groups[1].Value+', column '+$location.Groups[2].Value) }
            }
            return $safe
        }
    }
    return $null
}
function Get-SafeLogExcerpt([string]$LocalLog) {
    $items=[System.Collections.Generic.Queue[object]]::new()
    $read=0
    $matched=0
    $privateBlock=$false
    if (-not (Test-Path -LiteralPath $LocalLog -PathType Leaf)) { return @{status='unavailable';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    if ((Get-Item -LiteralPath $LocalLog).Length -gt 16777216) { return @{status='size-limit';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $reader=[IO.StreamReader]::new($LocalLog,[Text.Encoding]::UTF8,$true)
    try {
        while ($null -ne ($line=$reader.ReadLine())) {
            $read++
            if ($line -match '(?i)-----\s*BEGIN\s+[^-]*PRIVATE KEY') { $privateBlock=$true }
            if ($privateBlock) {
                if ($line -match '(?i)-----\s*END\s+[^-]*PRIVATE KEY') { $privateBlock=$false }
                continue
            }
            $safe=ConvertTo-SafeLogLine $line
            if ($null -ne $safe) {
                $matched++
                if ($items.Count -ge 500) { $null=$items.Dequeue() }
                $items.Enqueue([ordered]@{log_line=$read;message=$safe})
            }
        }
    } finally { $reader.Dispose() }
    return @{status='reconstructed';lines=$items.ToArray();read_lines=$read;omitted_lines=($read-$matched);truncated_matches=($matched-$items.Count)}
}

function Save-DiagnosticJournal([string]$LocalLog,[switch]$SelfTest) {
    $journalPath=[IO.Path]::ChangeExtension($LocalLog,'.diagnostic.json')
    try { $excerpt=Get-SafeLogExcerpt $LocalLog }
    catch { $excerpt=@{status='filter-error';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $report=[ordered]@{
        schema='iscribe-build-diagnostics/v2'
        script_version='6.4'
        utc=[DateTime]::UtcNow.ToString('o')
        route=$script:DiagnosticRoute
        revision=(Get-SafeSha $script:Revision)
        candidate_sha=(Get-SafeSha $script:PinnedSha)
        base_sha=(Get-SafeSha $script:BaseSha)
        pull_request=$script:SelectedPR
        remote_changed=$script:RemoteChanged
        ci_request_id=$(if ($script:CiRequestId -cmatch '^[0-9a-f]{32}$') { $script:CiRequestId } else { $null })
        ci_run_id=$(if ($script:CiRunId -match '^[0-9]+$') { $script:CiRunId } else { $null })
        outcome=$(if ($SelfTest) { 'self-test' } else { 'failed' })
        detail='allowlisted events and reconstructed technical excerpt only; full original retained locally'
        text_excerpt=$excerpt
        events=$script:DiagnosticEvents.ToArray()
        omitted_events=$script:DiagnosticOmitted
    }
    [IO.File]::WriteAllText($journalPath,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    return $journalPath
}
function Get-VerifiedDiagnosticRepo {
    $repoInfo=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
    if ($repoInfo.ExitCode -ne 0 -or -not $repoInfo.Text) {
        Write-Warning ('Диагностический репозиторий недоступен: '+$repoInfo.Kind+'. Проверьте существование и права gh.')
        return $null
    }
    $info=$repoInfo.Text | ConvertFrom-Json
    if ($info.full_name -ne $DiagnosticsRepo -or $info.private -ne $true -or $info.visibility -ne 'private' -or $info.permissions.push -ne $true -or $info.archived -eq $true -or -not $info.default_branch) {
        Write-Warning 'Не подтверждены приватность, активность и права записи репозитория. Ничего не отправлено.'
        return $null
    }
    return $info
}
function Get-GitBlobSha([byte[]]$Bytes) {
    # GitHub contents API uses Git blob SHA-1, not SHA-1 of raw file bytes.
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $buffer=[byte[]]::new($header.Length+$Bytes.Length)
    [Buffer]::BlockCopy($header,0,$buffer,0,$header.Length)
    [Buffer]::BlockCopy($Bytes,0,$buffer,$header.Length,$Bytes.Length)
    $sha=[Security.Cryptography.SHA1]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($buffer))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-DiagnosticRemoteState([string]$Path,[string]$Branch,[string]$ExpectedSha) {
    $r=Invoke-GhApiRead ($Path+'?ref='+[uri]::EscapeDataString($Branch))
    if ($r.ExitCode -ne 0) {
        if ($r.Kind -eq 'not-found') { return 'absent' }
        return 'unknown'
    }
    try {
        $file=$r.Text | ConvertFrom-Json
        if ($file.type -ceq 'file' -and $file.sha -ceq $ExpectedSha) { return 'matched' }
        return 'conflict'
    } catch { return 'unknown' }
}
function Upload-DiagnosticJournal([string]$JournalPath) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { Write-Host 'Отправка диагностики отключена.'; return $false }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { Write-Warning 'gh.exe недоступен; диагностический журнал сохранён локально.'; return $false }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { Write-Warning 'Требуется отдельный приватный репозиторий диагностики.'; return $false }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { return $false }
    $bytes=[IO.File]::ReadAllBytes($JournalPath)
    if ($bytes.Length -gt 2097152) { Write-Warning 'Диагностический журнал превышает лимит 2 МБ; отправка отменена.'; return $false }
    $expected=Get-GitBlobSha $bytes
    $branch=[string]$info.default_branch
    # Stable filename for these exact bytes: all retries use the same path.
    $report=$null
    try { $report=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { throw 'Некорректный диагностический JSON.' }
    $utc=[DateTimeOffset]::Parse([string]$report.utc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    $prefix='failures'
    $label='failure'
    if ($report.outcome -ceq 'self-test') { $prefix='checks'; $label='check' }
    elseif ($report.outcome -cne 'failed') { throw 'Неизвестный тип диагностического отчёта.' }
    $remotePath=$prefix+'/'+$utc.ToString('yyyy-MM')+'/'+$label+'-'+$utc.ToString('yyyyMMdd-HHmmss')+'-'+$expected+'.json'
    $path='repos/'+$DiagnosticsRepo+'/contents/'+$remotePath
    $url='https://github.com/'+$DiagnosticsRepo+'/blob/'+$branch+'/'+$remotePath
    $payload=@{message='Add structured build failure diagnostic [skip ci]';content=[Convert]::ToBase64String($bytes);branch=$branch}
    $json=Join-Path $env:TEMP ('iscribe-gh-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        [IO.File]::WriteAllText($json,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        for ($attempt=1; $attempt -le 3; $attempt++) {
            # Recheck the privacy and access gate before every write.
            $current=Get-VerifiedDiagnosticRepo
            if (-not $current -or $current.default_branch -cne $branch) { Write-Warning 'Репозиторий или ветка изменились. Отправка остановлена.'; return $false }
            $before=Get-DiagnosticRemoteState $path $branch $expected
            if ($before -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (уже записан)"; return $true }
            if ($before -ne 'absent') { Write-Warning 'Не подтверждено отсутствие файла или обнаружен конфликт. Запись запрещена.'; return $false }
            # Create only: no sha field, no overwriting an existing file.
            $result=Invoke-GhApiOnce @('api','-X','PUT',$path,'--input',$json)
            # Always confirm read-back of exact contents, even if PUT reported success.
            # A timeout can mean the server already committed the file.
            # Reconcile by exact path and blob hash before allowing retry.
            $after=Get-DiagnosticRemoteState $path $branch $expected
            if ($after -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (запись подтверждена)"; return $true }
            if ($after -ne 'absent' -or $result.Kind -ne 'transient' -or $attempt -eq 3) {
                Write-Warning 'Отправка не подтверждена или повтор небезопасен. Локальная копия сохранена.'
                return $false
            }
            Add-DiagnosticEvent 'api-retry' 'upload-transient' $result.ExitCode
            Wait-ApiRetry $attempt
        }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
    return $false
}

function Invoke-DiagnosticsCheck([bool]$Provision) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { throw 'Для проверки отправки диагностика должна быть включена.' }
    if ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate) { throw 'Режим диагностики не принимает параметры интеграции.' }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { throw 'Требуется отдельный приватный репозиторий.' }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { throw 'Не установлен GitHub CLI (gh.exe).' }
    if ((Capture 'gh.exe' @('auth','status','--hostname','github.com')).ExitCode -ne 0) { throw 'GitHub CLI не авторизован. Выполните gh auth login.' }
    if ($Provision) {
        if ($DiagnosticsRepo -cne 'AlmazovAN/iScribe-diagnostics') { throw 'DiagnosticsSetup разрешён только для штатного диагностического репозитория.' }
        $probe=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
        if ($probe.Kind -eq 'not-found') {
            # 404 may mean missing repository or insufficient access. The create
            # request is explicit, private, and never modifies an existing repo.
            Write-Host "Создание приватного репозитория $DiagnosticsRepo (одна попытка)"
            $creation=Capture 'gh.exe' @('repo','create',$DiagnosticsRepo,'--private','--add-readme')
            if ($creation.ExitCode -ne 0) { Write-Warning 'Создание не подтверждено; проверяем фактическое состояние без повторного создания.' }
        } elseif ($probe.ExitCode -ne 0) {
            throw ('Не удалось проверить существование репозитория: '+$probe.Kind)
        }
    }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { throw 'Приватный диагностический репозиторий с правами записи не подтверждён.' }
    $script:DiagnosticRoute='diagnostics-check'
    $script:DiagnosticStage='self-test'
    Add-DiagnosticEvent 'self-test' 'synthetic-only'
    $sample=Join-Path $env:TEMP ('iscribe-diag-check-'+[guid]::NewGuid().ToString('N')+'.log')
    $journal=[IO.Path]::ChangeExtension($sample,'.diagnostic.json')
    try {
        # Synthetic fixture only, no local source paths, personal data or real credentials.
        [IO.File]::WriteAllLines($sample,[string[]]@(
            'HTTP 404',
            'example.ts(12,3): error TS2322: synthetic message',
            'Authorization: Bearer synthetic-only-0000',
            'UNRECOGNIZED_SYNTHETIC_TEXT'
        ),[Text.UTF8Encoding]::new($false))
        $journal=Save-DiagnosticJournal $sample -SelfTest
        $data=[IO.File]::ReadAllText($journal)
        $report=$data | ConvertFrom-Json
        $messages=@($report.text_excerpt.lines | ForEach-Object { $_.message })
        if ($report.outcome -cne 'self-test' -or $report.text_excerpt.status -cne 'reconstructed' -or
            $messages.Count -ne 2 -or $messages[0] -cne 'HTTP 404' -or
            $messages[1] -cne 'TypeScript TS2322; line 12, column 3' -or
            $data.Contains('synthetic-only-0000') -or $data.Contains('UNRECOGNIZED_SYNTHETIC_TEXT') -or $data.Contains('example.ts')) {
            throw 'Проверка фильтрации не пройдена. Отправка запрещена.'
        }
        if (-not (Upload-DiagnosticJournal $journal)) { throw 'Тестовая запись или обратное чтение не подтверждены.' }
        Write-Host 'DIAGNOSTICS CHECK PASS: приватность, фильтрация, запись и SHA при обратном чтении подтверждены.' -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $sample,$journal -Force -ErrorAction SilentlyContinue
    }
}
if ($Mode -in @('DiagnosticsSetup','DiagnosticsCheck')) {
    try {
        Invoke-DiagnosticsCheck ($Mode -eq 'DiagnosticsSetup')
        exit 0
    } catch {
        Write-Warning ('DIAGNOSTICS CHECK FAIL: '+$_.Exception.Message)
        exit 1
    }
}

try {
    $LogWriter=[IO.StreamWriter]::new($FullLog,$false,[Text.UTF8Encoding]::new($false))
    Step '1. Подготовка и синхронизация исходного main'
    if ($Mode -eq 'MainOnly' -and ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate)) { throw 'MainOnly не принимает параметры интеграции.' }
    Assert-Tools ($Mode -ne 'MainOnly')
    # Standard build must not inherit an opt-in profiling build flag.
    Remove-Item Env:VITE_GPU_PROFILE -ErrorAction SilentlyContinue
    $Root=Resolve-Project
    Set-Location -LiteralPath $Root
    Log "Репозиторий: $Root"
    $Revision=Sync-Main
    $BaseSha=$Revision
    Log "Исходный main: $BaseSha"
    $node=Capture 'node.exe' @('--version'); Log ('Node: '+$node.Text+' (CI использует Node 22)')
    $pr=$null
    if ($Mode -ne 'MainOnly') { Step '2. Поиск интеграционного PR'; $pr=Find-Candidate }
    $route='MainOnly'
    if ($pr) {
        $SelectedPR=[int]$pr.number
        $PinnedSha=[string]$pr.head.sha
        if ($PinnedSha -notmatch '^[0-9a-f]{40}$') { throw 'GitHub не вернул корректный SHA кандидата.' }
        if ($pr.merged -eq $true -or $pr.state -eq 'closed') {
            if ($pr.merged -ne $true -or -not (Test-Ancestor $PinnedSha $BaseSha)) { throw 'PR закрыт без подтверждённого включения его head в main.' }
            Log 'Кандидат уже в main. Повторное слияние не требуется.'
        } else {
            if ($pr.state -ne 'open' -or $pr.base.sha -ne $BaseSha) { throw 'PR не соответствует актуальному main.' }
            Run 'git.exe' @('fetch','origin',('refs/heads/'+$pr.head.ref+':refs/remotes/origin/'+$pr.head.ref))
            if ((Git-Text @('rev-parse',('refs/remotes/origin/'+$pr.head.ref))) -ne $PinnedSha) { throw 'Ветка изменилась во время получения. Повторите запуск.' }
            if (-not (Test-Ancestor $BaseSha $PinnedSha)) { throw 'Кандидат не содержит актуальный main. Сначала нужна новая интеграционная ветка.' }
            Assert-ManifestStages $SelectedManifest
            if (Test-Ancestor $PinnedSha $BaseSha) { Log 'Кандидат уже в main.' }
            else {
                Log "PR #${SelectedPR}: $($pr.html_url)"
                $route=$Mode
                if ($route -eq 'Auto') {
                    Log '1 — локальный конвейер (по умолчанию); 2 — GitHub Actions (новый запуск); 0 — отмена.'
                    $answer=Read-Host 'Выберите маршрут [1]'
                    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq '1') { $route='Local' }
                    elseif ($answer -eq '2') { $route='Online' }
                    else { $ExitCode=2; throw 'Операция отменена.' }
                }
                if ($route -eq 'Local') { Log 'Выбран локальный CI. GitHub Actions не запускается и не проверяется.' }
                else { Log 'Выбран облачный CI. После подтверждения будет запрошен один новый запуск.' }
                Confirm-Integration $route
            }
        }
    } else { Log 'Интеграционный кандидат не выбран. Сборка актуального main без слияния.' }
    $DiagnosticRoute=$route
    if ($route -eq 'Local') {
        Step '3. Локальный кандидат слияния в изолированном worktree'
        if ((Git-Text @('rev-parse',($BaseSha+':.github/workflows'))) -ne (Git-Text @('rev-parse',($PinnedSha+':.github/workflows')))) { throw 'Workflow changes require a separate reviewed integration; local push blocked.' }
        New-Worktree $BaseSha
        Run 'git.exe' @('merge','--no-ff','--no-edit',$PinnedSha)
        $Revision=Git-Text @('rev-parse','HEAD')
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'Кандидат отсутствует в локальном merge commit.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево слияния отличается от кандидата.' }
        Run-LocalCI
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
        Step '4. Отправка точного проверенного merge commit в GitHub main'
        $null=Assert-CurrentCandidate $true
        # Normal fast-forward push only. GitHub protection rules are respected.
        # Do NOT use --force, --admin, or bypass required checks.
        Run 'git.exe' @('push','origin',($Revision+':refs/heads/main'))
        $RemoteChanged=$true
        if ((Fetch-Main) -ne $Revision) { throw 'Удалённый main отличается от проверенного merge commit.' }
        Log 'Проверенный локальный merge commit находится в GitHub main.'
    } elseif ($route -eq 'Online') {
        Step '3. GitHub Actions и слияние PR'
        $fresh=Assert-CurrentCandidate
        if ($fresh.draft) { Run 'gh.exe' @('pr','ready',[string]$SelectedPR,'--repo',$Repository) }
        $fresh=Assert-CurrentCandidate $true
        Start-CloudCI $fresh
        $null=Wait-CI
        $null=Assert-CurrentCandidate $true
        Run 'gh.exe' @('pr','merge',[string]$SelectedPR,'--repo',$Repository,'--merge','--match-head-commit',$PinnedSha)
        $RemoteChanged=$true
        $Revision=Sync-Main
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'GitHub не подтвердил включение точного кандидата в main.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево main после слияния отличается от проверенного кандидата. Сборка остановлена до проверки.' }
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    } else {
        Step '3. Только синхронизация и сборка main'
        $Revision=Sync-Main
        Log 'Статус прежних CI не подтверждается этим маршрутом; выполняются сборка и release:check.'
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    }
    Install-Html $source $Revision
    $ExitCode=0
} catch {
    Add-DiagnosticEvent 'failure' (Get-DiagnosticCode ([string]$_.Exception.Message))
    Log ("FAILED [$StepName]: "+$_.Exception.Message)
    if ($RemoteChanged) { Log 'ВНИМАНИЕ: удалённый main уже изменён. Автоматический откат Git запрещён. После исправления повторите синхронизацию/сборку.' }
    else { Log 'Скрипт не подтвердил изменение удалённого main. При сетевой ошибке проверьте его фактический SHA.' }
    Log 'Предыдущий HTML не считается новым релизом.'
} finally {
    if ($TempHtml -and (Test-Path -LiteralPath $TempHtml)) { Remove-Item -LiteralPath $TempHtml -Force -ErrorAction SilentlyContinue }
    if ($WorktreeRegistered -and $Root) {
        try {
            Set-Location -LiteralPath $Root
            # Only the isolated worktree created by THIS invocation is removed.
            Run 'git.exe' @('worktree','remove','--force',$Worktree)
        } catch { Write-Warning "Не удалось убрать временный worktree: $Worktree. Основной проект не удалён." }
    }
    $env:VITE_GPU_PROFILE=$PriorGpuProfile
    try { Set-Location -LiteralPath $InitialLocation } catch {}
    if ($LogWriter) { $LogWriter.Dispose(); $LogWriter=$null }
    if ($ExitCode -eq 0 -or $ExitCode -eq 2) { Remove-Item -LiteralPath $FullLog -Force -ErrorAction SilentlyContinue }
    else {
        try {
            New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
            $local=Join-Path $LogRoot ('failure-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)+'.log')
            Move-Item -LiteralPath $FullLog -Destination $local
            Write-Host "Локальный журнал ошибки: $local" -ForegroundColor Yellow
            try {
                $journal=Save-DiagnosticJournal $local
                Write-Host "Локальная диагностическая копия: $journal"
                $null=Upload-DiagnosticJournal $journal
            } catch { Write-Warning 'Не удалось создать или отправить диагностическую копию. Оригинальный журнал сохранён.' }
            Get-ChildItem -LiteralPath $LogRoot -Filter 'failure-*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Журнал оставлен: $FullLog" }
    }
}
exit $ExitCode
; template='Failed test: scripts/local-pipeline.test.mjs / PowerShell local pipeline regression suite' }
        @{ pattern='(?i)^\s*(Test Files|Tests)\s+([0-9]{1,6})\s+failed\s*\|\s*([0-9]{1,6})\s+passed\s*\(([0-9]{1,6})\)\s*        @{ pattern='(?i)\bTS([0-9]{4,5})\s*:'; template='TypeScript TS$1' }
        @{ pattern='(?i)\bnpm\s+(?:ERR!|error)\s+code\s+(EACCES|EPERM|ENOENT|ENOSPC|ENOMEM|ERESOLVE|EINTEGRITY|ECONNRESET|ETIMEDOUT|ENOTFOUND|E401|E403|E404|ELIFECYCLE)\b'; template='npm error code $1' }
        @{ pattern='(?i)^\s*(?:Test Files|Tests)\s+([0-9]{1,6})\s+(passed|failed)\s+\(([0-9]{1,6})\)\s*$'; template='Tests: $1 $2 ($3 total)' }
        @{ pattern='(?i)^\s*([0-9]{1,6})\s+(passed|failed|skipped)\s*(?:\([0-9.]+(?:ms|s|m)\))?\s*$'; template='Tests: $1 $2' }
        @{ pattern='(?i)\bHTTP\s+(400|401|403|404|408|409|422|429|500|502|503|504)\b'; template='HTTP $1' }
        @{ pattern='(?i)^\s*Node:\s*v([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\s+\(CI использует Node 22\)\s*$'; template='Node v$1' }
        @{ pattern='(?i)^\s*\+\s*(npm\.cmd|git\.exe|npx\.cmd|gh\.exe)\s+'; template='Command: $1 (arguments omitted)' }
        @{ pattern='(?i)\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENOSPC|ENOMEM|EACCES|EPERM|ENOENT|ERESOLVE|EINTEGRITY)\b'; template='System error: $1' }
        @{ pattern='(?i)Cannot bind argument to parameter .LiteralPath. because it is an empty string'; template='PowerShell: LiteralPath is empty' }
        @{ pattern='(?i)Cannot find path|PathNotFound|ItemNotFound'; template='PowerShell: path not found' }
        @{ pattern='(?i)JavaScript heap out of memory|out of memory|heap limit'; template='Memory exhausted' }
        @{ pattern='(?i)Permission denied|Access is denied'; template='Access denied' }
        @{ pattern='(?i)authentication failed|не авторизован'; template='Authentication failed' }
        @{ pattern='(?i)Could not resolve host|connection timed out'; template='Network resolution or timeout failure' }
        @{ pattern='(?i)non-fast-forward|fetch first'; template='Git: non-fast-forward' }
        @{ pattern='(?i)protected branch|GH006|GH013'; template='Git: branch protection rejected operation' }
        @{ pattern='(?i)merge conflict|CONFLICT \('; template='Git: merge conflict' }
        @{ pattern='(?i)AssertionError|expect\(.*\)'; template='Test assertion failed' }
        @{ pattern='(?i)CI не пройден'; template='Cloud CI failed' }
        @{ pattern='(?i)Время ожидания CI истекло'; template='Cloud CI timed out' }
        @{ pattern='(?i)Конфигурация CI кандидата отличается'; template='CI workflow differs from base' }
        @{ pattern='(?i)Кандидат не содержит актуальный main|origin/main изменился|PR или main изменился'; template='Candidate or main changed' }
        @{ pattern='(?i)Не найдена встроенная точка входа|Повреждён встроенный блок|не обнаружена ревизия сборки'; template='HTML validation failed' }
        @{ pattern='(?i)Не установлена программа'; template='Required tool not installed' }
        @{ pattern='(?i)Не найден локальный репозиторий'; template='Local project not found' }
        @{ pattern='(?i)Есть изменения отслеживаемых файлов'; template='Tracked working tree is dirty' }
)
function ConvertTo-SafeLogLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -gt 8192) { return $null }
    if ($Line -match '(?i)-----\s*(BEGIN|END)\s+[^-]*PRIVATE KEY|authorization\s*[:=]|(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|(?:token|secret|password|passwd|api[_-]?key|credential|cookie|set-cookie|client[_-]?secret)\s*["'']?\s*[:=]|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:env:|export\s+|set\s+)[A-Za-z_][A-Za-z0-9_]*\s*=|https?://[^/\s]+@') { return $null }
    foreach ($rule in $script:SafeDiagnosticRules) {
        $m=[regex]::Match($Line,$rule.pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromMilliseconds(100))
        if ($m.Success) {
            $safe=$m.Result($rule.template)
            if ($safe -match '^TypeScript TS[0-9]{4,5}$') {
                $location=[regex]::Match($Line,'\(([0-9]{1,6}),([0-9]{1,6})\)\s*:\s*(?:error\s+)?TS[0-9]{4,5}\s*:',[Text.RegularExpressions.RegexOptions]::IgnoreCase,[TimeSpan]::FromMilliseconds(100))
                if ($location.Success) { $safe += ('; line '+$location.Groups[1].Value+', column '+$location.Groups[2].Value) }
            }
            return $safe
        }
    }
    return $null
}
function Get-SafeLogExcerpt([string]$LocalLog) {
    $items=[System.Collections.Generic.Queue[object]]::new()
    $read=0
    $matched=0
    $privateBlock=$false
    if (-not (Test-Path -LiteralPath $LocalLog -PathType Leaf)) { return @{status='unavailable';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    if ((Get-Item -LiteralPath $LocalLog).Length -gt 16777216) { return @{status='size-limit';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $reader=[IO.StreamReader]::new($LocalLog,[Text.Encoding]::UTF8,$true)
    try {
        while ($null -ne ($line=$reader.ReadLine())) {
            $read++
            if ($line -match '(?i)-----\s*BEGIN\s+[^-]*PRIVATE KEY') { $privateBlock=$true }
            if ($privateBlock) {
                if ($line -match '(?i)-----\s*END\s+[^-]*PRIVATE KEY') { $privateBlock=$false }
                continue
            }
            $safe=ConvertTo-SafeLogLine $line
            if ($null -ne $safe) {
                $matched++
                if ($items.Count -ge 500) { $null=$items.Dequeue() }
                $items.Enqueue([ordered]@{log_line=$read;message=$safe})
            }
        }
    } finally { $reader.Dispose() }
    return @{status='reconstructed';lines=$items.ToArray();read_lines=$read;omitted_lines=($read-$matched);truncated_matches=($matched-$items.Count)}
}

function Save-DiagnosticJournal([string]$LocalLog,[switch]$SelfTest) {
    $journalPath=[IO.Path]::ChangeExtension($LocalLog,'.diagnostic.json')
    try { $excerpt=Get-SafeLogExcerpt $LocalLog }
    catch { $excerpt=@{status='filter-error';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $report=[ordered]@{
        schema='iscribe-build-diagnostics/v2'
        script_version='6.4'
        utc=[DateTime]::UtcNow.ToString('o')
        route=$script:DiagnosticRoute
        revision=(Get-SafeSha $script:Revision)
        candidate_sha=(Get-SafeSha $script:PinnedSha)
        base_sha=(Get-SafeSha $script:BaseSha)
        pull_request=$script:SelectedPR
        remote_changed=$script:RemoteChanged
        ci_request_id=$(if ($script:CiRequestId -cmatch '^[0-9a-f]{32}$') { $script:CiRequestId } else { $null })
        ci_run_id=$(if ($script:CiRunId -match '^[0-9]+$') { $script:CiRunId } else { $null })
        outcome=$(if ($SelfTest) { 'self-test' } else { 'failed' })
        detail='allowlisted events and reconstructed technical excerpt only; full original retained locally'
        text_excerpt=$excerpt
        events=$script:DiagnosticEvents.ToArray()
        omitted_events=$script:DiagnosticOmitted
    }
    [IO.File]::WriteAllText($journalPath,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    return $journalPath
}
function Get-VerifiedDiagnosticRepo {
    $repoInfo=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
    if ($repoInfo.ExitCode -ne 0 -or -not $repoInfo.Text) {
        Write-Warning ('Диагностический репозиторий недоступен: '+$repoInfo.Kind+'. Проверьте существование и права gh.')
        return $null
    }
    $info=$repoInfo.Text | ConvertFrom-Json
    if ($info.full_name -ne $DiagnosticsRepo -or $info.private -ne $true -or $info.visibility -ne 'private' -or $info.permissions.push -ne $true -or $info.archived -eq $true -or -not $info.default_branch) {
        Write-Warning 'Не подтверждены приватность, активность и права записи репозитория. Ничего не отправлено.'
        return $null
    }
    return $info
}
function Get-GitBlobSha([byte[]]$Bytes) {
    # GitHub contents API uses Git blob SHA-1, not SHA-1 of raw file bytes.
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $buffer=[byte[]]::new($header.Length+$Bytes.Length)
    [Buffer]::BlockCopy($header,0,$buffer,0,$header.Length)
    [Buffer]::BlockCopy($Bytes,0,$buffer,$header.Length,$Bytes.Length)
    $sha=[Security.Cryptography.SHA1]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($buffer))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-DiagnosticRemoteState([string]$Path,[string]$Branch,[string]$ExpectedSha) {
    $r=Invoke-GhApiRead ($Path+'?ref='+[uri]::EscapeDataString($Branch))
    if ($r.ExitCode -ne 0) {
        if ($r.Kind -eq 'not-found') { return 'absent' }
        return 'unknown'
    }
    try {
        $file=$r.Text | ConvertFrom-Json
        if ($file.type -ceq 'file' -and $file.sha -ceq $ExpectedSha) { return 'matched' }
        return 'conflict'
    } catch { return 'unknown' }
}
function Upload-DiagnosticJournal([string]$JournalPath) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { Write-Host 'Отправка диагностики отключена.'; return $false }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { Write-Warning 'gh.exe недоступен; диагностический журнал сохранён локально.'; return $false }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { Write-Warning 'Требуется отдельный приватный репозиторий диагностики.'; return $false }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { return $false }
    $bytes=[IO.File]::ReadAllBytes($JournalPath)
    if ($bytes.Length -gt 2097152) { Write-Warning 'Диагностический журнал превышает лимит 2 МБ; отправка отменена.'; return $false }
    $expected=Get-GitBlobSha $bytes
    $branch=[string]$info.default_branch
    # Stable filename for these exact bytes: all retries use the same path.
    $report=$null
    try { $report=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { throw 'Некорректный диагностический JSON.' }
    $utc=[DateTimeOffset]::Parse([string]$report.utc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    $prefix='failures'
    $label='failure'
    if ($report.outcome -ceq 'self-test') { $prefix='checks'; $label='check' }
    elseif ($report.outcome -cne 'failed') { throw 'Неизвестный тип диагностического отчёта.' }
    $remotePath=$prefix+'/'+$utc.ToString('yyyy-MM')+'/'+$label+'-'+$utc.ToString('yyyyMMdd-HHmmss')+'-'+$expected+'.json'
    $path='repos/'+$DiagnosticsRepo+'/contents/'+$remotePath
    $url='https://github.com/'+$DiagnosticsRepo+'/blob/'+$branch+'/'+$remotePath
    $payload=@{message='Add structured build failure diagnostic [skip ci]';content=[Convert]::ToBase64String($bytes);branch=$branch}
    $json=Join-Path $env:TEMP ('iscribe-gh-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        [IO.File]::WriteAllText($json,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        for ($attempt=1; $attempt -le 3; $attempt++) {
            # Recheck the privacy and access gate before every write.
            $current=Get-VerifiedDiagnosticRepo
            if (-not $current -or $current.default_branch -cne $branch) { Write-Warning 'Репозиторий или ветка изменились. Отправка остановлена.'; return $false }
            $before=Get-DiagnosticRemoteState $path $branch $expected
            if ($before -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (уже записан)"; return $true }
            if ($before -ne 'absent') { Write-Warning 'Не подтверждено отсутствие файла или обнаружен конфликт. Запись запрещена.'; return $false }
            # Create only: no sha field, no overwriting an existing file.
            $result=Invoke-GhApiOnce @('api','-X','PUT',$path,'--input',$json)
            # Always confirm read-back of exact contents, even if PUT reported success.
            # A timeout can mean the server already committed the file.
            # Reconcile by exact path and blob hash before allowing retry.
            $after=Get-DiagnosticRemoteState $path $branch $expected
            if ($after -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (запись подтверждена)"; return $true }
            if ($after -ne 'absent' -or $result.Kind -ne 'transient' -or $attempt -eq 3) {
                Write-Warning 'Отправка не подтверждена или повтор небезопасен. Локальная копия сохранена.'
                return $false
            }
            Add-DiagnosticEvent 'api-retry' 'upload-transient' $result.ExitCode
            Wait-ApiRetry $attempt
        }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
    return $false
}

function Invoke-DiagnosticsCheck([bool]$Provision) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { throw 'Для проверки отправки диагностика должна быть включена.' }
    if ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate) { throw 'Режим диагностики не принимает параметры интеграции.' }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { throw 'Требуется отдельный приватный репозиторий.' }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { throw 'Не установлен GitHub CLI (gh.exe).' }
    if ((Capture 'gh.exe' @('auth','status','--hostname','github.com')).ExitCode -ne 0) { throw 'GitHub CLI не авторизован. Выполните gh auth login.' }
    if ($Provision) {
        if ($DiagnosticsRepo -cne 'AlmazovAN/iScribe-diagnostics') { throw 'DiagnosticsSetup разрешён только для штатного диагностического репозитория.' }
        $probe=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
        if ($probe.Kind -eq 'not-found') {
            # 404 may mean missing repository or insufficient access. The create
            # request is explicit, private, and never modifies an existing repo.
            Write-Host "Создание приватного репозитория $DiagnosticsRepo (одна попытка)"
            $creation=Capture 'gh.exe' @('repo','create',$DiagnosticsRepo,'--private','--add-readme')
            if ($creation.ExitCode -ne 0) { Write-Warning 'Создание не подтверждено; проверяем фактическое состояние без повторного создания.' }
        } elseif ($probe.ExitCode -ne 0) {
            throw ('Не удалось проверить существование репозитория: '+$probe.Kind)
        }
    }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { throw 'Приватный диагностический репозиторий с правами записи не подтверждён.' }
    $script:DiagnosticRoute='diagnostics-check'
    $script:DiagnosticStage='self-test'
    Add-DiagnosticEvent 'self-test' 'synthetic-only'
    $sample=Join-Path $env:TEMP ('iscribe-diag-check-'+[guid]::NewGuid().ToString('N')+'.log')
    $journal=[IO.Path]::ChangeExtension($sample,'.diagnostic.json')
    try {
        # Synthetic fixture only, no local source paths, personal data or real credentials.
        [IO.File]::WriteAllLines($sample,[string[]]@(
            'HTTP 404',
            'example.ts(12,3): error TS2322: synthetic message',
            'Authorization: Bearer synthetic-only-0000',
            'UNRECOGNIZED_SYNTHETIC_TEXT'
        ),[Text.UTF8Encoding]::new($false))
        $journal=Save-DiagnosticJournal $sample -SelfTest
        $data=[IO.File]::ReadAllText($journal)
        $report=$data | ConvertFrom-Json
        $messages=@($report.text_excerpt.lines | ForEach-Object { $_.message })
        if ($report.outcome -cne 'self-test' -or $report.text_excerpt.status -cne 'reconstructed' -or
            $messages.Count -ne 2 -or $messages[0] -cne 'HTTP 404' -or
            $messages[1] -cne 'TypeScript TS2322; line 12, column 3' -or
            $data.Contains('synthetic-only-0000') -or $data.Contains('UNRECOGNIZED_SYNTHETIC_TEXT') -or $data.Contains('example.ts')) {
            throw 'Проверка фильтрации не пройдена. Отправка запрещена.'
        }
        if (-not (Upload-DiagnosticJournal $journal)) { throw 'Тестовая запись или обратное чтение не подтверждены.' }
        Write-Host 'DIAGNOSTICS CHECK PASS: приватность, фильтрация, запись и SHA при обратном чтении подтверждены.' -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $sample,$journal -Force -ErrorAction SilentlyContinue
    }
}
if ($Mode -in @('DiagnosticsSetup','DiagnosticsCheck')) {
    try {
        Invoke-DiagnosticsCheck ($Mode -eq 'DiagnosticsSetup')
        exit 0
    } catch {
        Write-Warning ('DIAGNOSTICS CHECK FAIL: '+$_.Exception.Message)
        exit 1
    }
}

try {
    $LogWriter=[IO.StreamWriter]::new($FullLog,$false,[Text.UTF8Encoding]::new($false))
    Step '1. Подготовка и синхронизация исходного main'
    if ($Mode -eq 'MainOnly' -and ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate)) { throw 'MainOnly не принимает параметры интеграции.' }
    Assert-Tools ($Mode -ne 'MainOnly')
    # Standard build must not inherit an opt-in profiling build flag.
    Remove-Item Env:VITE_GPU_PROFILE -ErrorAction SilentlyContinue
    $Root=Resolve-Project
    Set-Location -LiteralPath $Root
    Log "Репозиторий: $Root"
    $Revision=Sync-Main
    $BaseSha=$Revision
    Log "Исходный main: $BaseSha"
    $node=Capture 'node.exe' @('--version'); Log ('Node: '+$node.Text+' (CI использует Node 22)')
    $pr=$null
    if ($Mode -ne 'MainOnly') { Step '2. Поиск интеграционного PR'; $pr=Find-Candidate }
    $route='MainOnly'
    if ($pr) {
        $SelectedPR=[int]$pr.number
        $PinnedSha=[string]$pr.head.sha
        if ($PinnedSha -notmatch '^[0-9a-f]{40}$') { throw 'GitHub не вернул корректный SHA кандидата.' }
        if ($pr.merged -eq $true -or $pr.state -eq 'closed') {
            if ($pr.merged -ne $true -or -not (Test-Ancestor $PinnedSha $BaseSha)) { throw 'PR закрыт без подтверждённого включения его head в main.' }
            Log 'Кандидат уже в main. Повторное слияние не требуется.'
        } else {
            if ($pr.state -ne 'open' -or $pr.base.sha -ne $BaseSha) { throw 'PR не соответствует актуальному main.' }
            Run 'git.exe' @('fetch','origin',('refs/heads/'+$pr.head.ref+':refs/remotes/origin/'+$pr.head.ref))
            if ((Git-Text @('rev-parse',('refs/remotes/origin/'+$pr.head.ref))) -ne $PinnedSha) { throw 'Ветка изменилась во время получения. Повторите запуск.' }
            if (-not (Test-Ancestor $BaseSha $PinnedSha)) { throw 'Кандидат не содержит актуальный main. Сначала нужна новая интеграционная ветка.' }
            Assert-ManifestStages $SelectedManifest
            if (Test-Ancestor $PinnedSha $BaseSha) { Log 'Кандидат уже в main.' }
            else {
                Log "PR #${SelectedPR}: $($pr.html_url)"
                $route=$Mode
                if ($route -eq 'Auto') {
                    Log '1 — локальный конвейер (по умолчанию); 2 — GitHub Actions (новый запуск); 0 — отмена.'
                    $answer=Read-Host 'Выберите маршрут [1]'
                    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq '1') { $route='Local' }
                    elseif ($answer -eq '2') { $route='Online' }
                    else { $ExitCode=2; throw 'Операция отменена.' }
                }
                if ($route -eq 'Local') { Log 'Выбран локальный CI. GitHub Actions не запускается и не проверяется.' }
                else { Log 'Выбран облачный CI. После подтверждения будет запрошен один новый запуск.' }
                Confirm-Integration $route
            }
        }
    } else { Log 'Интеграционный кандидат не выбран. Сборка актуального main без слияния.' }
    $DiagnosticRoute=$route
    if ($route -eq 'Local') {
        Step '3. Локальный кандидат слияния в изолированном worktree'
        if ((Git-Text @('rev-parse',($BaseSha+':.github/workflows'))) -ne (Git-Text @('rev-parse',($PinnedSha+':.github/workflows')))) { throw 'Workflow changes require a separate reviewed integration; local push blocked.' }
        New-Worktree $BaseSha
        Run 'git.exe' @('merge','--no-ff','--no-edit',$PinnedSha)
        $Revision=Git-Text @('rev-parse','HEAD')
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'Кандидат отсутствует в локальном merge commit.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево слияния отличается от кандидата.' }
        Run-LocalCI
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
        Step '4. Отправка точного проверенного merge commit в GitHub main'
        $null=Assert-CurrentCandidate $true
        # Normal fast-forward push only. GitHub protection rules are respected.
        # Do NOT use --force, --admin, or bypass required checks.
        Run 'git.exe' @('push','origin',($Revision+':refs/heads/main'))
        $RemoteChanged=$true
        if ((Fetch-Main) -ne $Revision) { throw 'Удалённый main отличается от проверенного merge commit.' }
        Log 'Проверенный локальный merge commit находится в GitHub main.'
    } elseif ($route -eq 'Online') {
        Step '3. GitHub Actions и слияние PR'
        $fresh=Assert-CurrentCandidate
        if ($fresh.draft) { Run 'gh.exe' @('pr','ready',[string]$SelectedPR,'--repo',$Repository) }
        $fresh=Assert-CurrentCandidate $true
        Start-CloudCI $fresh
        $null=Wait-CI
        $null=Assert-CurrentCandidate $true
        Run 'gh.exe' @('pr','merge',[string]$SelectedPR,'--repo',$Repository,'--merge','--match-head-commit',$PinnedSha)
        $RemoteChanged=$true
        $Revision=Sync-Main
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'GitHub не подтвердил включение точного кандидата в main.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево main после слияния отличается от проверенного кандидата. Сборка остановлена до проверки.' }
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    } else {
        Step '3. Только синхронизация и сборка main'
        $Revision=Sync-Main
        Log 'Статус прежних CI не подтверждается этим маршрутом; выполняются сборка и release:check.'
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    }
    Install-Html $source $Revision
    $ExitCode=0
} catch {
    Add-DiagnosticEvent 'failure' (Get-DiagnosticCode ([string]$_.Exception.Message))
    Log ("FAILED [$StepName]: "+$_.Exception.Message)
    if ($RemoteChanged) { Log 'ВНИМАНИЕ: удалённый main уже изменён. Автоматический откат Git запрещён. После исправления повторите синхронизацию/сборку.' }
    else { Log 'Скрипт не подтвердил изменение удалённого main. При сетевой ошибке проверьте его фактический SHA.' }
    Log 'Предыдущий HTML не считается новым релизом.'
} finally {
    if ($TempHtml -and (Test-Path -LiteralPath $TempHtml)) { Remove-Item -LiteralPath $TempHtml -Force -ErrorAction SilentlyContinue }
    if ($WorktreeRegistered -and $Root) {
        try {
            Set-Location -LiteralPath $Root
            # Only the isolated worktree created by THIS invocation is removed.
            Run 'git.exe' @('worktree','remove','--force',$Worktree)
        } catch { Write-Warning "Не удалось убрать временный worktree: $Worktree. Основной проект не удалён." }
    }
    $env:VITE_GPU_PROFILE=$PriorGpuProfile
    try { Set-Location -LiteralPath $InitialLocation } catch {}
    if ($LogWriter) { $LogWriter.Dispose(); $LogWriter=$null }
    if ($ExitCode -eq 0 -or $ExitCode -eq 2) { Remove-Item -LiteralPath $FullLog -Force -ErrorAction SilentlyContinue }
    else {
        try {
            New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
            $local=Join-Path $LogRoot ('failure-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)+'.log')
            Move-Item -LiteralPath $FullLog -Destination $local
            Write-Host "Локальный журнал ошибки: $local" -ForegroundColor Yellow
            try {
                $journal=Save-DiagnosticJournal $local
                Write-Host "Локальная диагностическая копия: $journal"
                $null=Upload-DiagnosticJournal $journal
            } catch { Write-Warning 'Не удалось создать или отправить диагностическую копию. Оригинальный журнал сохранён.' }
            Get-ChildItem -LiteralPath $LogRoot -Filter 'failure-*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Журнал оставлен: $FullLog" }
    }
}
exit $ExitCode
; template='$1: $2 failed, $3 passed ($4 total)' }
        @{ pattern='(?i)\bTS([0-9]{4,5})\s*:'; template='TypeScript TS$1' }
        @{ pattern='(?i)\bnpm\s+(?:ERR!|error)\s+code\s+(EACCES|EPERM|ENOENT|ENOSPC|ENOMEM|ERESOLVE|EINTEGRITY|ECONNRESET|ETIMEDOUT|ENOTFOUND|E401|E403|E404|ELIFECYCLE)\b'; template='npm error code $1' }
        @{ pattern='(?i)^\s*(?:Test Files|Tests)\s+([0-9]{1,6})\s+(passed|failed)\s+\(([0-9]{1,6})\)\s*$'; template='Tests: $1 $2 ($3 total)' }
        @{ pattern='(?i)^\s*([0-9]{1,6})\s+(passed|failed|skipped)\s*(?:\([0-9.]+(?:ms|s|m)\))?\s*$'; template='Tests: $1 $2' }
        @{ pattern='(?i)\bHTTP\s+(400|401|403|404|408|409|422|429|500|502|503|504)\b'; template='HTTP $1' }
        @{ pattern='(?i)^\s*Node:\s*v([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\s+\(CI использует Node 22\)\s*$'; template='Node v$1' }
        @{ pattern='(?i)^\s*\+\s*(npm\.cmd|git\.exe|npx\.cmd|gh\.exe)\s+'; template='Command: $1 (arguments omitted)' }
        @{ pattern='(?i)\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENOSPC|ENOMEM|EACCES|EPERM|ENOENT|ERESOLVE|EINTEGRITY)\b'; template='System error: $1' }
        @{ pattern='(?i)Cannot bind argument to parameter .LiteralPath. because it is an empty string'; template='PowerShell: LiteralPath is empty' }
        @{ pattern='(?i)Cannot find path|PathNotFound|ItemNotFound'; template='PowerShell: path not found' }
        @{ pattern='(?i)JavaScript heap out of memory|out of memory|heap limit'; template='Memory exhausted' }
        @{ pattern='(?i)Permission denied|Access is denied'; template='Access denied' }
        @{ pattern='(?i)authentication failed|не авторизован'; template='Authentication failed' }
        @{ pattern='(?i)Could not resolve host|connection timed out'; template='Network resolution or timeout failure' }
        @{ pattern='(?i)non-fast-forward|fetch first'; template='Git: non-fast-forward' }
        @{ pattern='(?i)protected branch|GH006|GH013'; template='Git: branch protection rejected operation' }
        @{ pattern='(?i)merge conflict|CONFLICT \('; template='Git: merge conflict' }
        @{ pattern='(?i)AssertionError|expect\(.*\)'; template='Test assertion failed' }
        @{ pattern='(?i)CI не пройден'; template='Cloud CI failed' }
        @{ pattern='(?i)Время ожидания CI истекло'; template='Cloud CI timed out' }
        @{ pattern='(?i)Конфигурация CI кандидата отличается'; template='CI workflow differs from base' }
        @{ pattern='(?i)Кандидат не содержит актуальный main|origin/main изменился|PR или main изменился'; template='Candidate or main changed' }
        @{ pattern='(?i)Не найдена встроенная точка входа|Повреждён встроенный блок|не обнаружена ревизия сборки'; template='HTML validation failed' }
        @{ pattern='(?i)Не установлена программа'; template='Required tool not installed' }
        @{ pattern='(?i)Не найден локальный репозиторий'; template='Local project not found' }
        @{ pattern='(?i)Есть изменения отслеживаемых файлов'; template='Tracked working tree is dirty' }
)
function ConvertTo-SafeLogLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -gt 8192) { return $null }
    if ($Line -match '(?i)-----\s*(BEGIN|END)\s+[^-]*PRIVATE KEY|authorization\s*[:=]|(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|(?:token|secret|password|passwd|api[_-]?key|credential|cookie|set-cookie|client[_-]?secret)\s*["'']?\s*[:=]|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:env:|export\s+|set\s+)[A-Za-z_][A-Za-z0-9_]*\s*=|https?://[^/\s]+@') { return $null }
    foreach ($rule in $script:SafeDiagnosticRules) {
        $m=[regex]::Match($Line,$rule.pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromMilliseconds(100))
        if ($m.Success) {
            $safe=$m.Result($rule.template)
            if ($safe -match '^TypeScript TS[0-9]{4,5}$') {
                $location=[regex]::Match($Line,'\(([0-9]{1,6}),([0-9]{1,6})\)\s*:\s*(?:error\s+)?TS[0-9]{4,5}\s*:',[Text.RegularExpressions.RegexOptions]::IgnoreCase,[TimeSpan]::FromMilliseconds(100))
                if ($location.Success) { $safe += ('; line '+$location.Groups[1].Value+', column '+$location.Groups[2].Value) }
            }
            return $safe
        }
    }
    return $null
}
function Get-SafeLogExcerpt([string]$LocalLog) {
    $items=[System.Collections.Generic.Queue[object]]::new()
    $read=0
    $matched=0
    $privateBlock=$false
    if (-not (Test-Path -LiteralPath $LocalLog -PathType Leaf)) { return @{status='unavailable';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    if ((Get-Item -LiteralPath $LocalLog).Length -gt 16777216) { return @{status='size-limit';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $reader=[IO.StreamReader]::new($LocalLog,[Text.Encoding]::UTF8,$true)
    try {
        while ($null -ne ($line=$reader.ReadLine())) {
            $read++
            if ($line -match '(?i)-----\s*BEGIN\s+[^-]*PRIVATE KEY') { $privateBlock=$true }
            if ($privateBlock) {
                if ($line -match '(?i)-----\s*END\s+[^-]*PRIVATE KEY') { $privateBlock=$false }
                continue
            }
            $safe=ConvertTo-SafeLogLine $line
            if ($null -ne $safe) {
                $matched++
                if ($items.Count -ge 500) { $null=$items.Dequeue() }
                $items.Enqueue([ordered]@{log_line=$read;message=$safe})
            }
        }
    } finally { $reader.Dispose() }
    return @{status='reconstructed';lines=$items.ToArray();read_lines=$read;omitted_lines=($read-$matched);truncated_matches=($matched-$items.Count)}
}

function Save-DiagnosticJournal([string]$LocalLog,[switch]$SelfTest) {
    $journalPath=[IO.Path]::ChangeExtension($LocalLog,'.diagnostic.json')
    try { $excerpt=Get-SafeLogExcerpt $LocalLog }
    catch { $excerpt=@{status='filter-error';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $report=[ordered]@{
        schema='iscribe-build-diagnostics/v2'
        script_version='6.4'
        utc=[DateTime]::UtcNow.ToString('o')
        route=$script:DiagnosticRoute
        revision=(Get-SafeSha $script:Revision)
        candidate_sha=(Get-SafeSha $script:PinnedSha)
        base_sha=(Get-SafeSha $script:BaseSha)
        pull_request=$script:SelectedPR
        remote_changed=$script:RemoteChanged
        ci_request_id=$(if ($script:CiRequestId -cmatch '^[0-9a-f]{32}$') { $script:CiRequestId } else { $null })
        ci_run_id=$(if ($script:CiRunId -match '^[0-9]+$') { $script:CiRunId } else { $null })
        outcome=$(if ($SelfTest) { 'self-test' } else { 'failed' })
        detail='allowlisted events and reconstructed technical excerpt only; full original retained locally'
        text_excerpt=$excerpt
        events=$script:DiagnosticEvents.ToArray()
        omitted_events=$script:DiagnosticOmitted
    }
    [IO.File]::WriteAllText($journalPath,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    return $journalPath
}
function Get-VerifiedDiagnosticRepo {
    $repoInfo=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
    if ($repoInfo.ExitCode -ne 0 -or -not $repoInfo.Text) {
        Write-Warning ('Диагностический репозиторий недоступен: '+$repoInfo.Kind+'. Проверьте существование и права gh.')
        return $null
    }
    $info=$repoInfo.Text | ConvertFrom-Json
    if ($info.full_name -ne $DiagnosticsRepo -or $info.private -ne $true -or $info.visibility -ne 'private' -or $info.permissions.push -ne $true -or $info.archived -eq $true -or -not $info.default_branch) {
        Write-Warning 'Не подтверждены приватность, активность и права записи репозитория. Ничего не отправлено.'
        return $null
    }
    return $info
}
function Get-GitBlobSha([byte[]]$Bytes) {
    # GitHub contents API uses Git blob SHA-1, not SHA-1 of raw file bytes.
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $buffer=[byte[]]::new($header.Length+$Bytes.Length)
    [Buffer]::BlockCopy($header,0,$buffer,0,$header.Length)
    [Buffer]::BlockCopy($Bytes,0,$buffer,$header.Length,$Bytes.Length)
    $sha=[Security.Cryptography.SHA1]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($buffer))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-DiagnosticRemoteState([string]$Path,[string]$Branch,[string]$ExpectedSha) {
    $r=Invoke-GhApiRead ($Path+'?ref='+[uri]::EscapeDataString($Branch))
    if ($r.ExitCode -ne 0) {
        if ($r.Kind -eq 'not-found') { return 'absent' }
        return 'unknown'
    }
    try {
        $file=$r.Text | ConvertFrom-Json
        if ($file.type -ceq 'file' -and $file.sha -ceq $ExpectedSha) { return 'matched' }
        return 'conflict'
    } catch { return 'unknown' }
}
function Upload-DiagnosticJournal([string]$JournalPath) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { Write-Host 'Отправка диагностики отключена.'; return $false }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { Write-Warning 'gh.exe недоступен; диагностический журнал сохранён локально.'; return $false }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { Write-Warning 'Требуется отдельный приватный репозиторий диагностики.'; return $false }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { return $false }
    $bytes=[IO.File]::ReadAllBytes($JournalPath)
    if ($bytes.Length -gt 2097152) { Write-Warning 'Диагностический журнал превышает лимит 2 МБ; отправка отменена.'; return $false }
    $expected=Get-GitBlobSha $bytes
    $branch=[string]$info.default_branch
    # Stable filename for these exact bytes: all retries use the same path.
    $report=$null
    try { $report=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { throw 'Некорректный диагностический JSON.' }
    $utc=[DateTimeOffset]::Parse([string]$report.utc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    $prefix='failures'
    $label='failure'
    if ($report.outcome -ceq 'self-test') { $prefix='checks'; $label='check' }
    elseif ($report.outcome -cne 'failed') { throw 'Неизвестный тип диагностического отчёта.' }
    $remotePath=$prefix+'/'+$utc.ToString('yyyy-MM')+'/'+$label+'-'+$utc.ToString('yyyyMMdd-HHmmss')+'-'+$expected+'.json'
    $path='repos/'+$DiagnosticsRepo+'/contents/'+$remotePath
    $url='https://github.com/'+$DiagnosticsRepo+'/blob/'+$branch+'/'+$remotePath
    $payload=@{message='Add structured build failure diagnostic [skip ci]';content=[Convert]::ToBase64String($bytes);branch=$branch}
    $json=Join-Path $env:TEMP ('iscribe-gh-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        [IO.File]::WriteAllText($json,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        for ($attempt=1; $attempt -le 3; $attempt++) {
            # Recheck the privacy and access gate before every write.
            $current=Get-VerifiedDiagnosticRepo
            if (-not $current -or $current.default_branch -cne $branch) { Write-Warning 'Репозиторий или ветка изменились. Отправка остановлена.'; return $false }
            $before=Get-DiagnosticRemoteState $path $branch $expected
            if ($before -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (уже записан)"; return $true }
            if ($before -ne 'absent') { Write-Warning 'Не подтверждено отсутствие файла или обнаружен конфликт. Запись запрещена.'; return $false }
            # Create only: no sha field, no overwriting an existing file.
            $result=Invoke-GhApiOnce @('api','-X','PUT',$path,'--input',$json)
            # Always confirm read-back of exact contents, even if PUT reported success.
            # A timeout can mean the server already committed the file.
            # Reconcile by exact path and blob hash before allowing retry.
            $after=Get-DiagnosticRemoteState $path $branch $expected
            if ($after -eq 'matched') { Write-Host "Диагностический журнал GitHub: $url (запись подтверждена)"; return $true }
            if ($after -ne 'absent' -or $result.Kind -ne 'transient' -or $attempt -eq 3) {
                Write-Warning 'Отправка не подтверждена или повтор небезопасен. Локальная копия сохранена.'
                return $false
            }
            Add-DiagnosticEvent 'api-retry' 'upload-transient' $result.ExitCode
            Wait-ApiRetry $attempt
        }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
    return $false
}

function Invoke-DiagnosticsCheck([bool]$Provision) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { throw 'Для проверки отправки диагностика должна быть включена.' }
    if ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate) { throw 'Режим диагностики не принимает параметры интеграции.' }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { throw 'Требуется отдельный приватный репозиторий.' }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { throw 'Не установлен GitHub CLI (gh.exe).' }
    if ((Capture 'gh.exe' @('auth','status','--hostname','github.com')).ExitCode -ne 0) { throw 'GitHub CLI не авторизован. Выполните gh auth login.' }
    if ($Provision) {
        if ($DiagnosticsRepo -cne 'AlmazovAN/iScribe-diagnostics') { throw 'DiagnosticsSetup разрешён только для штатного диагностического репозитория.' }
        $probe=Invoke-GhApiRead ('repos/'+$DiagnosticsRepo)
        if ($probe.Kind -eq 'not-found') {
            # 404 may mean missing repository or insufficient access. The create
            # request is explicit, private, and never modifies an existing repo.
            Write-Host "Создание приватного репозитория $DiagnosticsRepo (одна попытка)"
            $creation=Capture 'gh.exe' @('repo','create',$DiagnosticsRepo,'--private','--add-readme')
            if ($creation.ExitCode -ne 0) { Write-Warning 'Создание не подтверждено; проверяем фактическое состояние без повторного создания.' }
        } elseif ($probe.ExitCode -ne 0) {
            throw ('Не удалось проверить существование репозитория: '+$probe.Kind)
        }
    }
    $info=Get-VerifiedDiagnosticRepo
    if (-not $info) { throw 'Приватный диагностический репозиторий с правами записи не подтверждён.' }
    $script:DiagnosticRoute='diagnostics-check'
    $script:DiagnosticStage='self-test'
    Add-DiagnosticEvent 'self-test' 'synthetic-only'
    $sample=Join-Path $env:TEMP ('iscribe-diag-check-'+[guid]::NewGuid().ToString('N')+'.log')
    $journal=[IO.Path]::ChangeExtension($sample,'.diagnostic.json')
    try {
        # Synthetic fixture only, no local source paths, personal data or real credentials.
        [IO.File]::WriteAllLines($sample,[string[]]@(
            'HTTP 404',
            'example.ts(12,3): error TS2322: synthetic message',
            'Authorization: Bearer synthetic-only-0000',
            'UNRECOGNIZED_SYNTHETIC_TEXT'
        ),[Text.UTF8Encoding]::new($false))
        $journal=Save-DiagnosticJournal $sample -SelfTest
        $data=[IO.File]::ReadAllText($journal)
        $report=$data | ConvertFrom-Json
        $messages=@($report.text_excerpt.lines | ForEach-Object { $_.message })
        if ($report.outcome -cne 'self-test' -or $report.text_excerpt.status -cne 'reconstructed' -or
            $messages.Count -ne 2 -or $messages[0] -cne 'HTTP 404' -or
            $messages[1] -cne 'TypeScript TS2322; line 12, column 3' -or
            $data.Contains('synthetic-only-0000') -or $data.Contains('UNRECOGNIZED_SYNTHETIC_TEXT') -or $data.Contains('example.ts')) {
            throw 'Проверка фильтрации не пройдена. Отправка запрещена.'
        }
        if (-not (Upload-DiagnosticJournal $journal)) { throw 'Тестовая запись или обратное чтение не подтверждены.' }
        Write-Host 'DIAGNOSTICS CHECK PASS: приватность, фильтрация, запись и SHA при обратном чтении подтверждены.' -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $sample,$journal -Force -ErrorAction SilentlyContinue
    }
}
if ($Mode -in @('DiagnosticsSetup','DiagnosticsCheck')) {
    try {
        Invoke-DiagnosticsCheck ($Mode -eq 'DiagnosticsSetup')
        exit 0
    } catch {
        Write-Warning ('DIAGNOSTICS CHECK FAIL: '+$_.Exception.Message)
        exit 1
    }
}

try {
    $LogWriter=[IO.StreamWriter]::new($FullLog,$false,[Text.UTF8Encoding]::new($false))
    Step '1. Подготовка и синхронизация исходного main'
    if ($Mode -eq 'MainOnly' -and ($PullRequest -gt 0 -or $IntegrationBranch -or $ExpectedHeadSha -or $Integrate)) { throw 'MainOnly не принимает параметры интеграции.' }
    Assert-Tools ($Mode -ne 'MainOnly')
    # Standard build must not inherit an opt-in profiling build flag.
    Remove-Item Env:VITE_GPU_PROFILE -ErrorAction SilentlyContinue
    $Root=Resolve-Project
    Set-Location -LiteralPath $Root
    Log "Репозиторий: $Root"
    $Revision=Sync-Main
    $BaseSha=$Revision
    Log "Исходный main: $BaseSha"
    $node=Capture 'node.exe' @('--version'); Log ('Node: '+$node.Text+' (CI использует Node 22)')
    $pr=$null
    if ($Mode -ne 'MainOnly') { Step '2. Поиск интеграционного PR'; $pr=Find-Candidate }
    $route='MainOnly'
    if ($pr) {
        $SelectedPR=[int]$pr.number
        $PinnedSha=[string]$pr.head.sha
        if ($PinnedSha -notmatch '^[0-9a-f]{40}$') { throw 'GitHub не вернул корректный SHA кандидата.' }
        if ($pr.merged -eq $true -or $pr.state -eq 'closed') {
            if ($pr.merged -ne $true -or -not (Test-Ancestor $PinnedSha $BaseSha)) { throw 'PR закрыт без подтверждённого включения его head в main.' }
            Log 'Кандидат уже в main. Повторное слияние не требуется.'
        } else {
            if ($pr.state -ne 'open' -or $pr.base.sha -ne $BaseSha) { throw 'PR не соответствует актуальному main.' }
            Run 'git.exe' @('fetch','origin',('refs/heads/'+$pr.head.ref+':refs/remotes/origin/'+$pr.head.ref))
            if ((Git-Text @('rev-parse',('refs/remotes/origin/'+$pr.head.ref))) -ne $PinnedSha) { throw 'Ветка изменилась во время получения. Повторите запуск.' }
            if (-not (Test-Ancestor $BaseSha $PinnedSha)) { throw 'Кандидат не содержит актуальный main. Сначала нужна новая интеграционная ветка.' }
            Assert-ManifestStages $SelectedManifest
            if (Test-Ancestor $PinnedSha $BaseSha) { Log 'Кандидат уже в main.' }
            else {
                Log "PR #${SelectedPR}: $($pr.html_url)"
                $route=$Mode
                if ($route -eq 'Auto') {
                    Log '1 — локальный конвейер (по умолчанию); 2 — GitHub Actions (новый запуск); 0 — отмена.'
                    $answer=Read-Host 'Выберите маршрут [1]'
                    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq '1') { $route='Local' }
                    elseif ($answer -eq '2') { $route='Online' }
                    else { $ExitCode=2; throw 'Операция отменена.' }
                }
                if ($route -eq 'Local') { Log 'Выбран локальный CI. GitHub Actions не запускается и не проверяется.' }
                else { Log 'Выбран облачный CI. После подтверждения будет запрошен один новый запуск.' }
                Confirm-Integration $route
            }
        }
    } else { Log 'Интеграционный кандидат не выбран. Сборка актуального main без слияния.' }
    $DiagnosticRoute=$route
    if ($route -eq 'Local') {
        Step '3. Локальный кандидат слияния в изолированном worktree'
        if ((Git-Text @('rev-parse',($BaseSha+':.github/workflows'))) -ne (Git-Text @('rev-parse',($PinnedSha+':.github/workflows')))) { throw 'Workflow changes require a separate reviewed integration; local push blocked.' }
        New-Worktree $BaseSha
        Run 'git.exe' @('merge','--no-ff','--no-edit',$PinnedSha)
        $Revision=Git-Text @('rev-parse','HEAD')
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'Кандидат отсутствует в локальном merge commit.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево слияния отличается от кандидата.' }
        Run-LocalCI
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
        Step '4. Отправка точного проверенного merge commit в GitHub main'
        $null=Assert-CurrentCandidate $true
        # Normal fast-forward push only. GitHub protection rules are respected.
        # Do NOT use --force, --admin, or bypass required checks.
        Run 'git.exe' @('push','origin',($Revision+':refs/heads/main'))
        $RemoteChanged=$true
        if ((Fetch-Main) -ne $Revision) { throw 'Удалённый main отличается от проверенного merge commit.' }
        Log 'Проверенный локальный merge commit находится в GitHub main.'
    } elseif ($route -eq 'Online') {
        Step '3. GitHub Actions и слияние PR'
        $fresh=Assert-CurrentCandidate
        if ($fresh.draft) { Run 'gh.exe' @('pr','ready',[string]$SelectedPR,'--repo',$Repository) }
        $fresh=Assert-CurrentCandidate $true
        Start-CloudCI $fresh
        $null=Wait-CI
        $null=Assert-CurrentCandidate $true
        Run 'gh.exe' @('pr','merge',[string]$SelectedPR,'--repo',$Repository,'--merge','--match-head-commit',$PinnedSha)
        $RemoteChanged=$true
        $Revision=Sync-Main
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'GitHub не подтвердил включение точного кандидата в main.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево main после слияния отличается от проверенного кандидата. Сборка остановлена до проверки.' }
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    } else {
        Step '3. Только синхронизация и сборка main'
        $Revision=Sync-Main
        Log 'Статус прежних CI не подтверждается этим маршрутом; выполняются сборка и release:check.'
        New-Worktree $Revision
        Build-Only
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
    }
    Install-Html $source $Revision
    $ExitCode=0
} catch {
    Add-DiagnosticEvent 'failure' (Get-DiagnosticCode ([string]$_.Exception.Message))
    Log ("FAILED [$StepName]: "+$_.Exception.Message)
    if ($RemoteChanged) { Log 'ВНИМАНИЕ: удалённый main уже изменён. Автоматический откат Git запрещён. После исправления повторите синхронизацию/сборку.' }
    else { Log 'Скрипт не подтвердил изменение удалённого main. При сетевой ошибке проверьте его фактический SHA.' }
    Log 'Предыдущий HTML не считается новым релизом.'
} finally {
    if ($TempHtml -and (Test-Path -LiteralPath $TempHtml)) { Remove-Item -LiteralPath $TempHtml -Force -ErrorAction SilentlyContinue }
    if ($WorktreeRegistered -and $Root) {
        try {
            Set-Location -LiteralPath $Root
            # Only the isolated worktree created by THIS invocation is removed.
            Run 'git.exe' @('worktree','remove','--force',$Worktree)
        } catch { Write-Warning "Не удалось убрать временный worktree: $Worktree. Основной проект не удалён." }
    }
    $env:VITE_GPU_PROFILE=$PriorGpuProfile
    try { Set-Location -LiteralPath $InitialLocation } catch {}
    if ($LogWriter) { $LogWriter.Dispose(); $LogWriter=$null }
    if ($ExitCode -eq 0 -or $ExitCode -eq 2) { Remove-Item -LiteralPath $FullLog -Force -ErrorAction SilentlyContinue }
    else {
        try {
            New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
            $local=Join-Path $LogRoot ('failure-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)+'.log')
            Move-Item -LiteralPath $FullLog -Destination $local
            Write-Host "Локальный журнал ошибки: $local" -ForegroundColor Yellow
            try {
                $journal=Save-DiagnosticJournal $local
                Write-Host "Локальная диагностическая копия: $journal"
                $null=Upload-DiagnosticJournal $journal
            } catch { Write-Warning 'Не удалось создать или отправить диагностическую копию. Оригинальный журнал сохранён.' }
            Get-ChildItem -LiteralPath $LogRoot -Filter 'failure-*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Журнал оставлен: $FullLog" }
    }
}
exit $ExitCode
