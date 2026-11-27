# iScribe Update & Build v6.2 — Windows PowerShell 5.1 / PowerShell 7
# Auto: offer local CI by default; cloud CI only after explicit selection.
# Local: test exact merge commit, then normal push; no Actions dispatch.
# Online: dispatch CI once for the pinned candidate, wait, then ordinary PR merge.
# MainOnly: sync and build only.
# No force-push, hard reset, arbitrary PR merge, or publishing to Pages.
[CmdletBinding()]
param(
    [string]$ProjectDirectory = '',
    [ValidateSet('Auto','Local','Online','MainOnly')][string]$Mode = 'Auto',
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
function Gh-Json([string[]]$CliArgs) {
    $r = Capture 'gh.exe' $CliArgs
    if ($r.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($r.Text)) {
        throw ('GitHub CLI: ' + ($CliArgs -join ' ') + '. Проверьте gh auth status и доступ.')
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
function Find-Candidate {
    if ($PullRequest -gt 0) { $p=Get-PR $PullRequest; Assert-PRIdentity $p; return $p }
    $all = @(Gh-Json @('api',('repos/' + $Repository + '/pulls?state=open&base=main&per_page=100')) | Where-Object { $_ -ne $null })
    if ($all.Count -ge 100) { throw 'Слишком много открытых PR для безопасного автовыбора. Укажите -PullRequest.' }
    $matches = @($all | Where-Object {
        $_.head.repo.full_name -eq $Repository -and $(if ($IntegrationBranch) { $_.head.ref -eq $IntegrationBranch } else { $_.head.ref -match '^codex/.+-release-candidate$' })
    })
    if ($matches.Count -gt 1) { Log ('Кандидаты: ' + (($matches | ForEach-Object { '#'+$_.number+' '+$_.head.ref }) -join '; ')); throw 'Несколько кандидатов. Укажите -PullRequest.' }
    if ($matches.Count -eq 0) {
        if ($IntegrationBranch -or $ExpectedHeadSha -or $Mode -in @('Local','Online')) { throw 'Открытый интеграционный PR не найден. Укажите -PullRequest или используйте -Mode MainOnly.' }
        if ($all.Count -gt 0) { Log 'Другие открытые PR не являются обозначенными release-candidate и автоматически не объединяются.' }
        return $null
    }
    $p=$matches[0]; Assert-PRIdentity $p; return $p
}
function Assert-CurrentCandidate([bool]$RequireReady=$false) {
    $p=Get-PR $script:SelectedPR
    Assert-PRIdentity $p
    if ($p.state -ne 'open' -or $p.head.sha -ne $script:PinnedSha -or $p.base.sha -ne $script:BaseSha) { throw 'PR или main изменился. Повторите запуск с новой ревизией.' }
    if ($RequireReady -and $p.draft) { throw 'PR всё ещё является Draft.' }
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

function Save-DiagnosticJournal([string]$LocalLog) {
    $journalPath=[IO.Path]::ChangeExtension($LocalLog,'.diagnostic.json')
    try { $excerpt=Get-SafeLogExcerpt $LocalLog }
    catch { $excerpt=@{status='filter-error';lines=@();read_lines=0;omitted_lines=0;truncated_matches=0} }
    $report=[ordered]@{
        schema='iscribe-build-diagnostics/v2'
        script_version='6.2'
        utc=[DateTime]::UtcNow.ToString('o')
        route=$script:DiagnosticRoute
        revision=(Get-SafeSha $script:Revision)
        candidate_sha=(Get-SafeSha $script:PinnedSha)
        base_sha=(Get-SafeSha $script:BaseSha)
        pull_request=$script:SelectedPR
        remote_changed=$script:RemoteChanged
        ci_request_id=$(if ($script:CiRequestId -cmatch '^[0-9a-f]{32}$') { $script:CiRequestId } else { $null })
        ci_run_id=$(if ($script:CiRunId -match '^[0-9]+$') { $script:CiRunId } else { $null })
        outcome='failed'
        detail='allowlisted events and reconstructed technical excerpt only; full original retained locally'
        text_excerpt=$excerpt
        events=$script:DiagnosticEvents.ToArray()
        omitted_events=$script:DiagnosticOmitted
    }
    [IO.File]::WriteAllText($journalPath,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    return $journalPath
}
function Upload-DiagnosticJournal([string]$JournalPath) {
    if ($NoUploadDiagnostics -or -not $UploadDiagnostics) { Write-Host 'Отправка диагностики отключена.'; return }
    if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) { Write-Warning 'gh.exe недоступен; диагностический журнал сохранён локально.'; return }
    if ($DiagnosticsRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $DiagnosticsRepo -eq $Repository) { Write-Warning 'Требуется отдельный приватный репозиторий диагностики.'; return }
    $repoInfo=Capture 'gh.exe' @('api',('repos/'+$DiagnosticsRepo))
    if ($repoInfo.ExitCode -ne 0 -or -not $repoInfo.Text) {
        Write-Warning 'Диагностический репозиторий недоступен. Проверьте существование и права gh. Журнал оставлен локально.'
        return
    }
    $info=$repoInfo.Text | ConvertFrom-Json
    if ($info.full_name -ne $DiagnosticsRepo -or $info.private -ne $true -or $info.visibility -ne 'private' -or $info.permissions.push -ne $true -or $info.archived -eq $true -or -not $info.default_branch) {
        Write-Warning 'Не подтверждены приватность, активность и права записи репозитория. Ничего не отправлено.'
        return
    }
    # Unique file per failed invocation, never overwrite a previous report.
    $name='failure-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N')+'.json'
    $remotePath='failures/'+[DateTime]::UtcNow.ToString('yyyy-MM')+'/'+$name
    $path='repos/'+$DiagnosticsRepo+'/contents/'+$remotePath
    $bytes=[IO.File]::ReadAllBytes($JournalPath)
    if ($bytes.Length -gt 2097152) { Write-Warning 'Диагностический журнал превышает лимит 2 МБ; отправка отменена.'; return }
    $payload=@{message='Add structured build failure diagnostic [skip ci]';content=[Convert]::ToBase64String($bytes);branch=[string]$info.default_branch}
    $json=Join-Path $env:TEMP ('iscribe-gh-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        [IO.File]::WriteAllText($json,($payload|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        $result=Capture 'gh.exe' @('api','-X','PUT',$path,'--input',$json)
        if ($result.ExitCode -ne 0) { Write-Warning 'Отправка журнала не подтверждена; локальная копия сохранена. Автоматического повтора пока нет.'; return }
        $receipt=$result.Text | ConvertFrom-Json
        if ($receipt.content.path -cne $remotePath -or $receipt.content.sha -notmatch '^[0-9a-f]{40}$') { Write-Warning 'GitHub не подтвердил точный файл диагностики; локальная копия сохранена.'; return }
        Write-Host "Диагностический журнал GitHub: https://github.com/$DiagnosticsRepo/blob/$($info.default_branch)/$remotePath"
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
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
        New-Worktree $BaseSha
        Run 'git.exe' @('merge','--no-ff','--no-edit',$PinnedSha)
        $Revision=Git-Text @('rev-parse','HEAD')
        if (-not (Test-Ancestor $PinnedSha $Revision)) { throw 'Кандидат отсутствует в локальном merge commit.' }
        if ((Git-Text @('rev-parse',($Revision+'^{tree}'))) -ne (Git-Text @('rev-parse',($PinnedSha+'^{tree}')))) { throw 'Дерево слияния отличается от кандидата.' }
        Run-LocalCI
        $source=Join-Path $Worktree 'dist\iScribe.html'
        Assert-Html $source $Revision
        Step '4. Отправка точного проверенного merge commit в GitHub main'
        $null=Assert-CurrentCandidate
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
                Upload-DiagnosticJournal $journal
            } catch { Write-Warning 'Не удалось создать или отправить диагностическую копию. Оригинальный журнал сохранён.' }
            Get-ChildItem -LiteralPath $LogRoot -Filter 'failure-*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Журнал оставлен: $FullLog" }
    }
}
exit $ExitCode
