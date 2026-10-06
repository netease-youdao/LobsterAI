param([string]$AppPath, [string]$OutputDirectory, [switch]$SkipProbe)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'diagnostic-common.ps1')
if ($env:OS -ne 'Windows_NT') { throw 'This collector requires Windows.' }
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('lobsterai-diagnostic-' + $runId)
$reportDir = Join-Path $runRoot 'report'
$workDir = Join-Path $runRoot 'probe-work'
$errors = New-Object 'System.Collections.Generic.List[object]'
$moduleReports = New-Object 'System.Collections.Generic.List[object]'
$seenModuleProcesses = @{}
$moduleFiles = @{}
[void](New-Item -ItemType Directory -Path $reportDir, $workDir -Force)

function Record-CollectionError {
    param([string]$Stage, $Failure)
    $errors.Add(@{ stage = $Stage; error = [string]$Failure })
}

function Get-FileEvidence {
    param([string]$Path, [switch]$Hash)
    try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ path = $Path; exists = $false } }
    $file = Get-Item -LiteralPath $Path
    $evidence = @{ path = $file.FullName; exists = $true; bytes = $file.Length; modifiedUtc = $file.LastWriteTimeUtc.ToString('o') }
    if ($Hash) { $evidence.sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
    return $evidence
    } catch {
        Record-CollectionError ('file metadata:' + $Path) $_
        return @{ path = $Path; error = [string]$_ }
    }
}

function Get-ProcessModuleEvidence {
    param([int]$ProcessId, [string]$Kind)
    if ($seenModuleProcesses.ContainsKey($ProcessId)) { return }
    $seenModuleProcesses[$ProcessId] = $true
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $names = @()
        foreach ($module in $process.Modules) {
            $filePath = $module.FileName
            $names += $filePath
            if (-not $moduleFiles.ContainsKey($filePath)) {
                $moduleFiles[$filePath] = @{
                    path = $filePath; name = $module.ModuleName
                    company = $module.FileVersionInfo.CompanyName
                    version = $module.FileVersionInfo.FileVersion
                }
            }
        }
        $moduleReports.Add(@{ pid = $ProcessId; kind = $Kind; executable = $process.Path; modules = $names })
    } catch { Record-CollectionError ('modules:' + $ProcessId) $_ }
}

function Add-FilteredLog {
    param([string]$Path, [string]$Name)
    try {
        $filtered = Select-DiagnosticLogText (Read-DiagnosticTail $Path)
        [IO.File]::WriteAllText((Join-Path $reportDir ('logs\' + $Name)), $filtered, (New-Object Text.UTF8Encoding($false)))
        return @{ source = $Path; output = ('logs/' + $Name); tailLimitBytes = 2097152; filtered = $true }
    } catch { Record-CollectionError ('log:' + $Path) $_ }
}

Write-Host 'LobsterAI 网关诊断' -ForegroundColor Cyan
Write-Host '正在收集信息。不会修复或删除用户数据，也不会自动上传。'
Write-Host '通常需要 1 到 3 分钟，请保持此窗口打开。'
$summary = @{ toolVersion = 2; runId = $runId; startedAt = (Get-Date).ToString('o'); mode = 'read-only collection plus synthetic SQLite probe' }
try {
    Write-Host '[1/5] 系统和应用版本'
    try {
        $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 5
        Write-DiagnosticJson (Join-Path $reportDir 'system.json') @{
            caption = $os.Caption; version = $os.Version; build = $os.BuildNumber
            architecture = $os.OSArchitecture; lastBoot = ([datetime]$os.LastBootUpTime).ToString('o')
            powershellVersion = $PSVersionTable.PSVersion.ToString(); is64BitProcess = [Environment]::Is64BitProcess
            timezone = [TimeZoneInfo]::Local.Id; collectedAt = (Get-Date).ToString('o')
        }
    } catch { Record-CollectionError 'system' $_ }
    $processes = @()
    try { $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'LobsterAI.exe'" -OperationTimeoutSec 5) }
    catch { Record-CollectionError 'process inventory' $_ }
    # Command lines can contain gateway tokens, so only identity fields are exported.
    Write-DiagnosticJson (Join-Path $reportDir 'processes.json') @($processes | Select-Object ProcessId, ParentProcessId, ExecutablePath, CreationDate)
    $installed = @()
    foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        $installed += @(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName })
    }
    $appRecords = @($installed | Where-Object { $_.DisplayName -match 'LobsterAI' })
    Write-DiagnosticJson (Join-Path $reportDir 'installations.json') @($appRecords | Select-Object DisplayName, DisplayVersion, InstallLocation, InstallDate, Publisher)
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    foreach ($process in $processes) { if ($process.ExecutablePath) { $candidates.Add($process.ExecutablePath) } }
    foreach ($record in $appRecords) {
        if ($record.InstallLocation) { $candidates.Add((Join-Path $record.InstallLocation 'LobsterAI.exe')) }
        if ($record.DisplayIcon) { $candidates.Add(($record.DisplayIcon -replace ',\d+$', '').Trim('"')) }
    }
    foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) {
            $candidates.Add((Join-Path $base 'LobsterAI\LobsterAI.exe'))
            $candidates.Add((Join-Path $base 'Programs\LobsterAI\LobsterAI.exe'))
        }
    }
    $validCandidates = @($candidates | Select-Object -Unique | Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and ([IO.Path]::GetFileName($_) -ieq 'LobsterAI.exe') })
    $activePaths = @($processes | ForEach-Object { $_.ExecutablePath } | Where-Object { $_ } | Select-Object -Unique)
    if (-not $AppPath -and $activePaths.Count -eq 1) { $AppPath = $activePaths[0] }
    if (-not $AppPath -and $validCandidates.Count -eq 1) { $AppPath = $validCandidates[0] }
    if (-not $AppPath -and -not $SkipProbe) {
        Write-Host '未能唯一确定当前安装，请在弹出的窗口中选择正在使用的 LobsterAI.exe。'
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object Windows.Forms.OpenFileDialog
        $dialog.Title = '请选择当前使用的 LobsterAI.exe（取消则只收集日志）'
        $dialog.Filter = 'LobsterAI.exe|LobsterAI.exe'
        try { if ($dialog.ShowDialog() -eq 'OK') { $AppPath = $dialog.FileName } } finally { $dialog.Dispose() }
    }
    if ($AppPath -and (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
        $AppPath = (Get-Item -LiteralPath $AppPath).FullName
        $runtimeRoot = Join-Path (Split-Path $AppPath) 'resources\cfmind'
        $summary.application = @{ path = $AppPath; version = [Diagnostics.FileVersionInfo]::GetVersionInfo($AppPath).ProductVersion; runtimeRoot = $runtimeRoot }
        try { $summary.application.openclawVersion = (Get-Content -LiteralPath (Join-Path $runtimeRoot 'package.json') -Raw | ConvertFrom-Json).version }
        catch { Record-CollectionError 'runtime version' $_ }
        $files = @((Get-FileEvidence $AppPath -Hash))
        foreach ($name in @('package.json', 'gateway-launcher.cjs', 'gateway-bundle.mjs', 'sqlite-readonly-location.worker.mjs', 'dist\infra\sqlite-readonly-location.worker.js')) {
            $files += Get-FileEvidence (Join-Path $runtimeRoot $name) -Hash
        }
        Write-DiagnosticJson (Join-Path $reportDir 'runtime-files.json') $files
    } else { Record-CollectionError 'application selection' 'No installed LobsterAI executable selected; probes will be skipped.' }

    Write-Host '[2/5] 安全软件和进程模块'
    $security = @{ registeredAntivirus = @(); matchingInstalledProducts = @() }
    try { $security.registeredAntivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -OperationTimeoutSec 5 | Select-Object displayName, productState, pathToSignedProductExe) }
    catch { Record-CollectionError 'security center' $_ }
    $securityPattern = '(?i)McAfee|Trellix|Symantec|CrowdStrike|SentinelOne|Sophos|Kaspersky|ESET|Trend Micro|Bitdefender|Endpoint|Antivirus|Defender|奇安信|天擎|深信服|火绒|瑞星|卡巴斯基|赛门铁克|迈克菲|防泄漏|终端安全|杀毒|360安全'
    $security.matchingInstalledProducts = @($installed | Where-Object { $_.DisplayName -match $securityPattern } | Select-Object DisplayName, DisplayVersion, Publisher)
    Write-DiagnosticJson (Join-Path $reportDir 'security-products.json') $security
    foreach ($process in ($processes | Select-Object -First 6)) { Get-ProcessModuleEvidence ([int]$process.ProcessId) 'existing LobsterAI process' }

    Write-Host '[3/5] 筛选启动及修复日志'
    [void](New-Item -ItemType Directory -Path (Join-Path $reportDir 'logs'))
    $userData = Join-Path $env:APPDATA 'LobsterAI'
    $logRoots = @($userData, (Join-Path $userData 'logs'), (Join-Path $userData 'openclaw\logs'), (Join-Path $env:TEMP 'openclaw'))
    if ($AppPath) { $logRoots += Join-Path ([IO.Path]::GetPathRoot($AppPath)) 'tmp\openclaw' }
    $logIndex = @()
    $logNumber = 0
    foreach ($logRoot in ($logRoots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $logRoot -PathType Container)) { continue }
        foreach ($logFile in (Get-ChildItem -LiteralPath $logRoot -File | Where-Object { $_.Name -match '^(?:main-|gateway-|openclaw-).*\.log$|^install-timing\.log$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 4)) {
            $logNumber++
            $logIndex += Add-FilteredLog $logFile.FullName ($logNumber.ToString('00') + '-' + $logFile.Name)
        }
    }
    $repairRoot = Join-Path $userData 'openclaw\repair-backups'
    if (Test-Path -LiteralPath $repairRoot -PathType Container) {
        foreach ($repair in (Get-ChildItem -LiteralPath $repairRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
            $doctor = Join-Path $repair.FullName 'doctor.log'
            if (Test-Path -LiteralPath $doctor) { $logIndex += Add-FilteredLog $doctor ($repair.Name + '-doctor.log') }
            $doctorResult = Join-Path $repair.FullName 'doctor-result.json'
            if (Test-Path -LiteralPath $doctorResult) {
                try { Write-DiagnosticJson (Join-Path $reportDir ('logs\' + $repair.Name + '-doctor-result.json')) (Get-Content -LiteralPath $doctorResult -Raw | ConvertFrom-Json) }
                catch { Record-CollectionError 'doctor result' $_ }
            }
        }
    }
    Write-DiagnosticJson (Join-Path $reportDir 'log-index.json') $logIndex
    $summary.logFilesCollected = @($logIndex | Where-Object { $_ }).Count
    $database = Join-Path $userData 'openclaw\state\state\openclaw.sqlite'
    Write-DiagnosticJson (Join-Path $reportDir 'state-file-metadata.json') @((Get-FileEvidence $database), (Get-FileEvidence ($database + '-wal')), (Get-FileEvidence ($database + '-shm')))

    Write-Host '[4/5] 临时数据库 worker 探测'
    if (-not $SkipProbe -and $AppPath -and (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
        $probeDir = Join-Path $reportDir 'probe'
        [void](New-Item -ItemType Directory -Path $probeDir)
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $AppPath
        $startInfo.Arguments = (@((Join-Path $PSScriptRoot 'worker-probe.cjs'), $runtimeRoot, $workDir, $probeDir) | ForEach-Object { ConvertTo-DiagnosticArgument $_ }) -join ' '
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
        $startInfo.WorkingDirectory = $workDir
        $discardedEnvironmentKeys = @()
        foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
            if ($key -match '^(OPENCLAW_|LOBSTER_|LOBSTERAI_)|^(NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|NODE_DISABLE_COMPILE_CACHE)$') {
                $discardedEnvironmentKeys += $key
                $startInfo.EnvironmentVariables.Remove($key)
            }
        }
        $summary.probeEnvironment = @{ discardedVariableNames = $discardedEnvironmentKeys; valuesCollected = $false; temporaryState = $true }
        $startInfo.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
        $startInfo.EnvironmentVariables['OPENCLAW_HOME'] = $workDir
        $startInfo.EnvironmentVariables['OPENCLAW_STATE_DIR'] = (Join-Path $workDir 'state')
        $startInfo.EnvironmentVariables['OPENCLAW_CONFIG_PATH'] = (Join-Path $workDir 'state\openclaw.json')
        $diagnosticProcess = New-Object Diagnostics.Process
        $diagnosticProcess.StartInfo = $startInfo
        [void]$diagnosticProcess.Start()
        $stdoutTask = $diagnosticProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $diagnosticProcess.StandardError.ReadToEndAsync()
        $deadline = (Get-Date).AddSeconds(150)
        while (-not $diagnosticProcess.WaitForExit(500)) {
            Get-ProcessModuleEvidence $diagnosticProcess.Id 'diagnostic supervisor'
            $activeProbe = Join-Path $probeDir 'active-probe.json'
            if (Test-Path -LiteralPath $activeProbe) {
                try {
                    $active = Get-Content -LiteralPath $activeProbe -Raw | ConvertFrom-Json
                    if ($active.parentPid -eq $diagnosticProcess.Id) {
                        $childInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$active.pid) -OperationTimeoutSec 3
                        if ($childInfo -and $childInfo.ParentProcessId -eq $diagnosticProcess.Id) { Get-ProcessModuleEvidence ([int]$active.pid) 'diagnostic child' }
                    }
                } catch { Record-CollectionError 'probe module sampling' $_ }
            }
            if ((Get-Date) -gt $deadline) {
                # Only terminate the process tree created by this collector, never the running app.
                & "$env:SystemRoot\System32\taskkill.exe" /PID $diagnosticProcess.Id /T /F 2>&1 | Out-Null
                Record-CollectionError 'probe timeout' 'The diagnostic process exceeded 150 seconds and was stopped.'
                break
            }
        }
        if ($diagnosticProcess.WaitForExit(5000)) {
            [IO.File]::WriteAllText((Join-Path $probeDir 'supervisor-stdout.txt'), (Protect-DiagnosticText $stdoutTask.Result))
            [IO.File]::WriteAllText((Join-Path $probeDir 'supervisor-stderr.txt'), (Protect-DiagnosticText $stderrTask.Result))
            $summary.probeExitCode = $diagnosticProcess.ExitCode
        }
        $diagnosticProcess.Dispose()
        foreach ($file in (Get-ChildItem -LiteralPath $probeDir -File)) {
            $text = [IO.File]::ReadAllText($file.FullName)
            [IO.File]::WriteAllText($file.FullName, (Protect-DiagnosticText $text), (New-Object Text.UTF8Encoding($false)))
        }
    } else { $summary.probeSkipped = $true }
} catch {
    Record-CollectionError 'collector' $_
    Write-Host '部分项目未能读取，将把已收集的信息和错误一起打包。' -ForegroundColor Yellow
} finally {
    Write-Host '[5/5] 生成诊断 ZIP'
    # Signature checks are deduplicated and bounded; no executable contents are exported.
    $signatureCount = 0
    foreach ($entry in $moduleFiles.Values) {
        if ($signatureCount -lt 30 -and $entry.company -notmatch '^Microsoft') {
            try {
                $signature = Get-AuthenticodeSignature -LiteralPath $entry.path
                $entry.signatureStatus = [string]$signature.Status
                if ($signature.SignerCertificate) { $entry.signer = $signature.SignerCertificate.Subject }
            } catch { $entry.signatureError = [string]$_ }
            $signatureCount++
        }
    }
    Write-DiagnosticJson (Join-Path $reportDir 'modules.json') @{ processes = @($moduleReports.ToArray()); files = @($moduleFiles.Values) }
    Write-DiagnosticJson (Join-Path $reportDir 'collection-errors.json') @($errors.ToArray())
    $summary.finishedAt = (Get-Date).ToString('o')
    $summary.partial = $errors.Count -gt 0
    Write-DiagnosticJson (Join-Path $reportDir 'summary.json') $summary
    [IO.File]::WriteAllText((Join-Path $reportDir 'READ-ME.txt'), @'
LobsterAI Gateway diagnostic report
Read summary.json and collection-errors.json first.
probe/worker-probe.json contains the synthetic worker's captured stdout/stderr/exit codes and result-file protocol evidence.
User-profile paths are replaced during export. stdoutSha256 records the capture before export redaction.
These isolated probes do not certify Gateway health or prove which security product caused an error.
Logs are filtered startup excerpts, limited to the last 2 MiB of each selected file, with named credentials redacted.
No chat databases, conversation transcripts, configuration files, credentials, or memory documents are copied.
State files are inspected for file metadata only. The probe uses a temporary synthetic database.
No network upload, repair, uninstall, production process termination, or security setting change is performed.
Some process/module/security information may be unavailable without additional privileges; missing items are recorded.
'@, (New-Object Text.UTF8Encoding($false)))
    if (-not $OutputDirectory) { $OutputDirectory = [Environment]::GetFolderPath('Desktop') }
    if (-not $OutputDirectory) { $OutputDirectory = $PSScriptRoot }
    [void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
    $zipPath = Join-Path $OutputDirectory ('LobsterAI-Gateway-Diagnostics-' + $runId + '.zip')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($reportDir, $zipPath)
    # The cleanup boundary is the private GUID directory created at the start of this run.
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '诊断完成，请把下面的 ZIP 文件发给技术支持：' -ForegroundColor Green
    Write-Host $zipPath -ForegroundColor Cyan
    if ($errors.Count -gt 0) { Write-Host '部分信息不可读取，详情已经记录在 ZIP 中。' -ForegroundColor Yellow }
    Start-Process explorer.exe -ArgumentList ('/select,"' + $zipPath + '"') -ErrorAction SilentlyContinue
}
