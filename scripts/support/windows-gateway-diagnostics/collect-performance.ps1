param(
    [string]$AppPath,
    [string]$OutputDirectory,
    [int]$HelperTimeoutSeconds = 300,
    [int]$HelperBudgetMinutes = 15,
    [switch]$SkipHelpers
)

# Startup performance collector. Compatible with Windows PowerShell 5.1.
# Engine steps run against a temporary empty state; the user's databases are
# only measured as raw file reads. Nothing is repaired, uploaded or deleted.
# build-performance-collector.cjs embeds this file, the shared helpers and the
# probe into one .cmd, because Explorer runs a double-clicked file from inside
# a ZIP without extracting its siblings.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command Protect-DiagnosticText -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'diagnostic-common.ps1') }
if ($env:OS -ne 'Windows_NT') { throw 'This collector requires Windows.' }

$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('lobsterai-perf-diagnostic-' + $runId)
$reportDir = Join-Path $runRoot 'report'
$helperHome = Join-Path $runRoot 'helper-home'
$userData = Join-Path $env:APPDATA 'LobsterAI'
$openclawBase = Join-Path $userData 'openclaw'
$stateDir = Join-Path $openclawBase 'state'
# Written on the same volume and folder policy as the engine state; removed at the end.
$benchDataDir = Join-Path $userData ('diag-perf-' + $runId)
$errors = New-Object 'System.Collections.Generic.List[object]'
$digest = New-Object 'System.Collections.Generic.List[string]'
$summary = [ordered]@{ toolVersion = 1; kind = 'startup-performance'; runId = $runId; startedAt = (Get-Date).ToString('o') }
$script:physicalDiskCache = $null
[void](New-Item -ItemType Directory -Path $reportDir, $helperHome -Force)

function Record-CollectionError {
    param([string]$Stage, $Failure)
    $entry = [ordered]@{ stage = $Stage; error = (Protect-DiagnosticText ([string]$Failure)) }
    # Localized messages alone cannot locate a failure (2026-09-26: "参数类型不匹配").
    if ($Failure -is [System.Management.Automation.ErrorRecord]) {
        $entry.exceptionType = $Failure.Exception.GetType().FullName
        if ($Failure.InvocationInfo) {
            $entry.line = $Failure.InvocationInfo.ScriptLineNumber
            $entry.statement = Protect-DiagnosticText (([string]$Failure.InvocationInfo.Line).Trim())
        }
        $entry.scriptStackTrace = Protect-DiagnosticText ([string]$Failure.ScriptStackTrace)
    }
    $errors.Add($entry)
}

function Get-CimSafe {
    param([string]$ClassName, [string]$Namespace = 'root/cimv2', [string]$Filter)
    try {
        if ($Filter) { return @(Get-CimInstance -Namespace $Namespace -ClassName $ClassName -Filter $Filter -OperationTimeoutSec 20 -ErrorAction Stop) }
        return @(Get-CimInstance -Namespace $Namespace -ClassName $ClassName -OperationTimeoutSec 20 -ErrorAction Stop)
    } catch {
        Record-CollectionError ('cim:' + $ClassName) $_
        return @()
    }
}

function Get-Stats {
    param([double[]]$Values)
    if (-not $Values -or $Values.Count -eq 0) { return [ordered]@{ count = 0 } }
    $sorted = @($Values | Sort-Object)
    $count = $sorted.Count
    $total = ($Values | Measure-Object -Sum).Sum
    return [ordered]@{
        count = $count
        totalMs = [math]::Round($total, 1)
        meanMs = [math]::Round($total / $count, 2)
        p50Ms = [math]::Round($sorted[[int][math]::Min($count - 1, [math]::Floor(0.5 * $count))], 2)
        p90Ms = [math]::Round($sorted[[int][math]::Min($count - 1, [math]::Floor(0.9 * $count))], 2)
        maxMs = [math]::Round($sorted[$count - 1], 2)
    }
}

function Format-Seconds {
    param($Milliseconds)
    if ($null -eq $Milliseconds) { return 'n/a' }
    return ('{0:N1} 秒' -f ([double]$Milliseconds / 1000))
}

function Get-PeMachine {
    param([string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $reader = New-Object IO.BinaryReader($stream)
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset + 4
        $machine = [int]$reader.ReadUInt16()
    } finally { $stream.Dispose() }
    switch ($machine) {
        0x8664 { return 'x64' }
        0xAA64 { return 'arm64' }
        0x014C { return 'x86' }
        default { return ('0x{0:X4}' -f $machine) }
    }
}

# Walks a tree with a time budget. Reparse points are counted but never followed.
function Get-FolderStats {
    param([string]$Root, [int]$BudgetSeconds = 60, [switch]$ByTopLevel, [string]$CollectPattern)
    $result = [ordered]@{ exists = (Test-Path -LiteralPath $Root -PathType Container) }
    if (-not $result.exists) { return $result }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stack = New-Object 'System.Collections.Generic.Stack[object]'
    $stack.Push(@($Root, ''))
    $files = 0; $bytes = [int64]0; $directories = 0; $unreadable = 0; $reparsePoints = 0; $truncated = $false
    $perTop = @{}
    $collected = New-Object 'System.Collections.Generic.List[object]'
    while ($stack.Count -gt 0) {
        if ($watch.Elapsed.TotalSeconds -ge $BudgetSeconds) { $truncated = $true; break }
        $item = $stack.Pop()
        $top = [string]$item[1]
        $directories++
        try {
            foreach ($entry in (New-Object IO.DirectoryInfo([string]$item[0])).EnumerateFileSystemInfos()) {
                if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $reparsePoints++; continue }
                $entryTop = if ($top) { $top } else { $entry.Name }
                if ($entry -is [IO.DirectoryInfo]) {
                    $stack.Push(@($entry.FullName, $entryTop))
                    continue
                }
                $files++
                $bytes += $entry.Length
                if ($ByTopLevel) {
                    if (-not $perTop.ContainsKey($entryTop)) { $perTop[$entryTop] = [ordered]@{ files = 0; bytes = [int64]0 } }
                    $perTop[$entryTop].files++
                    $perTop[$entryTop].bytes += $entry.Length
                }
                if ($CollectPattern -and $entry.Name -match $CollectPattern) {
                    $collected.Add([ordered]@{
                        path = $entry.FullName.Substring($Root.Length).TrimStart('\')
                        bytes = $entry.Length
                        modifiedUtc = $entry.LastWriteTimeUtc.ToString('o')
                    })
                }
            }
        } catch { $unreadable++ }
    }
    $result.files = $files
    $result.bytes = $bytes
    $result.gb = [math]::Round($bytes / 1GB, 2)
    $result.directories = $directories
    $result.unreadableDirectories = $unreadable
    $result.reparsePointsSkipped = $reparsePoints
    $result.truncatedByTimeBudget = $truncated
    $result.walkSeconds = [math]::Round($watch.Elapsed.TotalSeconds, 1)
    if ($ByTopLevel) {
        $result.topLevel = @($perTop.GetEnumerator() | Sort-Object { $_.Value.bytes } -Descending | ForEach-Object {
            [ordered]@{ name = $_.Key; files = $_.Value.files; mb = [math]::Round($_.Value.bytes / 1MB, 1) }
        })
    }
    if ($CollectPattern) { $result.matchedFiles = @($collected | Sort-Object { $_.bytes } -Descending) }
    return $result
}

function Get-SampleFiles {
    param([string]$Root, [int]$Limit = 600, [int]$BudgetSeconds = 45)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $all = New-Object 'System.Collections.Generic.List[string]'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($Root)
    while ($stack.Count -gt 0 -and $watch.Elapsed.TotalSeconds -lt $BudgetSeconds) {
        $directory = $stack.Pop()
        try {
            foreach ($entry in (New-Object IO.DirectoryInfo($directory)).EnumerateFileSystemInfos()) {
                if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                if ($entry -is [IO.DirectoryInfo]) { $stack.Push($entry.FullName); continue }
                if ($entry.Extension -match '^\.(?:js|mjs|cjs|json)$' -and $entry.Length -gt 0 -and $entry.Length -le 1MB) { $all.Add($entry.FullName) }
            }
        } catch { }
    }
    $sorted = @($all | Sort-Object)
    if ($sorted.Count -le $Limit) { return $sorted }
    $step = $sorted.Count / $Limit
    $picked = New-Object 'System.Collections.Generic.List[string]'
    for ($index = 0; $index -lt $Limit; $index++) { $picked.Add($sorted[[int][math]::Floor($index * $step)]) }
    return $picked.ToArray()
}

function Get-PathEvidence {
    param([string]$Label, [string]$Path)
    $evidence = [ordered]@{ label = $Label; path = $Path; exists = $false }
    if (-not $Path) { return $evidence }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $evidence.exists = $true
        $evidence.attributes = [string]$item.Attributes
        if ($item.LinkType) { $evidence.linkType = [string]$item.LinkType; $evidence.target = (@($item.Target) -join ';') }
    } catch { }
    $evidence.isUnc = $Path.StartsWith('\\')
    $root = [IO.Path]::GetPathRoot($Path)
    if ($root -match '^([A-Za-z]):\\$') {
        $letter = $Matches[1]
        $disk = Get-CimSafe Win32_LogicalDisk -Filter ("DeviceID = '" + $letter + ":'") | Select-Object -First 1
        if ($disk) {
            $evidence.driveType = [int]$disk.DriveType
            $evidence.fileSystem = $disk.FileSystem
            $evidence.sizeGB = [math]::Round($disk.Size / 1GB, 1)
            $evidence.freeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
            if ($disk.ProviderName) { $evidence.networkProvider = $disk.ProviderName }
        }
        try {
            $partition = Get-Partition -DriveLetter $letter -ErrorAction Stop | Select-Object -First 1
            if ($null -eq $script:physicalDiskCache) { $script:physicalDiskCache = @(Get-PhysicalDisk -ErrorAction Stop) }
            $physical = @($script:physicalDiskCache | Where-Object { [string]$_.DeviceId -eq [string]$partition.DiskNumber }) | Select-Object -First 1
            if ($physical) {
                $evidence.mediaType = [string]$physical.MediaType
                $evidence.busType = [string]$physical.BusType
                $evidence.diskModel = [string]$physical.FriendlyName
                $evidence.diskHealth = [string]$physical.HealthStatus
            }
        } catch { $evidence.physicalDiskError = (Protect-DiagnosticText ([string]$_)) }
    }
    return $evidence
}

function Invoke-TimedProcess {
    param(
        [string]$FilePath, [string[]]$Arguments, [hashtable]$Environment,
        [string]$WorkingDirectory, [int]$TimeoutSeconds, [string]$Label
    )
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-DiagnosticArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
    # Loaders and app credentials from the shell must not change what is measured.
    foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
        if ($key -match '^(OPENCLAW_|LOBSTER_|LOBSTERAI_|ELECTRON_)|^(NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|NODE_DISABLE_COMPILE_CACHE)$') {
            $startInfo.EnvironmentVariables.Remove($key)
        }
    }
    if ($Environment) { foreach ($key in $Environment.Keys) { $startInfo.EnvironmentVariables[$key] = [string]$Environment[$key] } }
    $result = [ordered]@{ label = $Label; timeoutSeconds = $TimeoutSeconds }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        [void]$process.Start()
    } catch {
        $result.launchError = Protect-DiagnosticText ([string]$_)
        Write-Host ('    ' + $Label + '：无法启动') -ForegroundColor Yellow
        return $result
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    while (-not $process.WaitForExit(1000)) {
        Write-Host -NoNewline ("`r    {0}：已用 {1} 秒   " -f $Label, [int]$watch.Elapsed.TotalSeconds)
        if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            $timedOut = $true
            # Only the process tree started by this collector is stopped.
            try { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null } catch { }
            try { if (-not $process.HasExited) { $process.Kill() } } catch { }
            break
        }
    }
    [void]$process.WaitForExit(15000)
    $watch.Stop()
    $result.elapsedMs = [int]$watch.Elapsed.TotalMilliseconds
    $result.timedOut = $timedOut
    try { if ($process.HasExited) { $result.exitCode = $process.ExitCode } } catch { }
    # Main-process CPU only. Wall time far above CPU time means waiting on I/O or scanners.
    try { $result.cpuMs = [int]$process.TotalProcessorTime.TotalMilliseconds } catch { }
    try { $result.peakWorkingSetMB = [math]::Round($process.PeakWorkingSet64 / 1MB) } catch { }
    $stdout = ''; $stderr = ''
    if ($stdoutTask.Wait(10000)) { $stdout = $stdoutTask.Result }
    if ($stderrTask.Wait(10000)) { $stderr = $stderrTask.Result }
    $result.stdoutTail = Protect-DiagnosticText ($stdout.Substring([math]::Max(0, $stdout.Length - 3000)))
    $result.stderrTail = Protect-DiagnosticText ($stderr.Substring([math]::Max(0, $stderr.Length - 3000)))
    $result.powershellProgressInStderr = $stderr.Contains('#< CLIXML')
    $process.Dispose()
    $state = if ($timedOut) { '超时，已停止' } else { '完成' }
    Write-Host ("`r    {0}：{1}，用时 {2}      " -f $Label, $state, (Format-Seconds $result.elapsedMs))
    return $result
}

function Get-EventExcerpt {
    param([hashtable]$Filter, [string]$Pattern, [int]$MaxEvents = 400, [int]$Keep = 30)
    try {
        $events = @(Get-WinEvent -FilterHashtable $Filter -MaxEvents $MaxEvents -ErrorAction Stop)
    } catch {
        # No matching events is reported as an error by Get-WinEvent.
        return [ordered]@{ note = (Protect-DiagnosticText ([string]$_)); events = @() }
    }
    $matched = @($events | Where-Object { $_.Message -and $_.Message -match $Pattern } | Select-Object -First $Keep)
    return [ordered]@{
        scanned = $events.Count
        countsById = @($events | Group-Object Id | ForEach-Object { [ordered]@{ id = $_.Name; count = $_.Count } })
        events = @($matched | ForEach-Object {
            [ordered]@{
                time = $_.TimeCreated.ToString('o'); id = $_.Id; provider = $_.ProviderName
                message = (Protect-DiagnosticText ($_.Message.Substring(0, [math]::Min(800, $_.Message.Length))))
            }
        })
    }
}

function Copy-LogTail {
    param([string]$Source, [string]$Name, [int]$Limit)
    try {
        $target = Join-Path $reportDir ('logs\' + $Name)
        [IO.File]::WriteAllText($target, (Protect-DiagnosticText (Read-DiagnosticTail $Source $Limit)), (New-Object Text.UTF8Encoding($false)))
        return [ordered]@{ source = $Source; output = ('logs/' + $Name); tailLimitBytes = $Limit }
    } catch { Record-CollectionError ('log:' + $Source) $_ }
}

Write-Host 'LobsterAI 启动性能诊断' -ForegroundColor Cyan
Write-Host '会测量这台电脑读写文件、启动进程和运行引擎启动步骤的速度。'
Write-Host '引擎步骤使用临时的空数据运行，不会修改或删除您的聊天记录、配置和数据库，也不会自动上传。'
Write-Host '通常需要 5～15 分钟，电脑很慢时最长约 30 分钟。请保持此窗口打开。'
Write-Host '如需提前结束，可按 Ctrl+C，已收集的信息仍会打包。'
Write-Host ''

try {
    # ------------------------------------------------------------------ 1
    Write-Host '[1/7] 系统、硬件与虚拟化'
    $environment = [ordered]@{}
    $os = $null; $computer = $null; $bios = $null; $board = $null; $cpuList = @()
    $nativeArchitecture = $null; $exeMachine = $null; $runtimeRoot = $null
    try {
        $os = Get-CimSafe Win32_OperatingSystem | Select-Object -First 1
        $computer = Get-CimSafe Win32_ComputerSystem | Select-Object -First 1
        $bios = Get-CimSafe Win32_BIOS | Select-Object -First 1
        $board = Get-CimSafe Win32_BaseBoard | Select-Object -First 1
        $cpuList = @(Get-CimSafe Win32_Processor)
        try {
            $nativeArchitecture = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE
        } catch { Record-CollectionError 'native architecture' $_ }
        $environment.os = [ordered]@{
            caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture
            lastBoot = ([string]$os.LastBootUpTime); locale = (Get-Culture).Name; uiCulture = (Get-UICulture).Name
            totalMemoryGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
            freeMemoryGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
            totalVirtualGB = [math]::Round($os.TotalVirtualMemorySize / 1MB, 1)
            freeVirtualGB = [math]::Round($os.FreeVirtualMemory / 1MB, 1)
        }
        $environment.computer = [ordered]@{
            manufacturer = $computer.Manufacturer; model = $computer.Model; systemFamily = $computer.SystemFamily
            hypervisorPresent = $computer.HypervisorPresent; logicalProcessors = $computer.NumberOfLogicalProcessors
            biosManufacturer = $bios.Manufacturer; biosVersion = $bios.SMBIOSBIOSVersion
            boardManufacturer = $board.Manufacturer; boardProduct = $board.Product
        }
        $environment.processors = @($cpuList | ForEach-Object {
            [ordered]@{
                name = $_.Name; manufacturer = $_.Manufacturer; architectureCode = $_.Architecture
                cores = $_.NumberOfCores; logicalProcessors = $_.NumberOfLogicalProcessors
                maxClockMHz = $_.MaxClockSpeed; currentClockMHz = $_.CurrentClockSpeed; loadPercent = $_.LoadPercentage
            }
        })
        $environment.architecture = [ordered]@{
            nativeFromRegistry = $nativeArchitecture
            powershellProcess = $env:PROCESSOR_ARCHITECTURE
            powershellProcessWow = $env:PROCESSOR_ARCHITEW6432
            is64BitProcess = [Environment]::Is64BitProcess
        }
        $environment.pageFiles = @(Get-CimSafe Win32_PageFileUsage | ForEach-Object {
            [ordered]@{ name = $_.Name; allocatedMB = $_.AllocatedBaseSize; currentUsageMB = $_.CurrentUsage; peakUsageMB = $_.PeakUsage }
        })
        $environment.battery = @(Get-CimSafe Win32_Battery | ForEach-Object { [ordered]@{ status = $_.BatteryStatus; chargePercent = $_.EstimatedChargeRemaining } })
        try { $environment.powerScheme = ((& "$env:SystemRoot\System32\powercfg.exe" /getactivescheme 2>&1) | Out-String).Trim() }
        catch { Record-CollectionError 'power scheme' $_ }
        $environmentNames = @('NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', '__COMPAT_LAYER', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
        $environment.variables = [ordered]@{}
        foreach ($name in $environmentNames) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ($value) { $environment.variables[$name] = [regex]::Replace($value, '//[^/@\s]+@', '//<USERINFO>@') }
        }
        $environment.variables.psModulePathEntries = @(($env:PSModulePath -split ';') | Where-Object { $_ })
        $vendorText = @($computer.Manufacturer, $computer.Model, $bios.Manufacturer, $bios.SMBIOSBIOSVersion, $board.Manufacturer, $board.Product) -join ' '
        $virtualization = @()
        if ($vendorText -match '(?i)parallels') { $virtualization += 'Parallels' }
        if ($vendorText -match '(?i)vmware') { $virtualization += 'VMware' }
        if ($vendorText -match '(?i)virtualbox|innotek') { $virtualization += 'VirtualBox' }
        if ($vendorText -match '(?i)qemu|kvm|bochs|utm') { $virtualization += 'QEMU/UTM' }
        if ($computer.Manufacturer -match '(?i)microsoft' -and $computer.Model -match '(?i)virtual') { $virtualization += 'Hyper-V' }
        if ($vendorText -match '(?i)apple') { $virtualization += 'Apple hardware' }
        $environment.virtualizationHints = $virtualization
        $cpuName = if ($cpuList.Count -gt 0) { $cpuList[0].Name } else { 'unknown' }
        $digest.Add(('机器：{0} {1}；虚拟化迹象：{2}；系统原生架构：{3}' -f $computer.Manufacturer, $computer.Model, $(if ($virtualization.Count) { $virtualization -join ',' } else { '无' }), $nativeArchitecture))
        $digest.Add(('系统：{0}（build {1}）；CPU：{2}，{3} 核 / {4} 线程；内存 {5} GB，可用 {6} GB' -f $os.Caption, $os.BuildNumber, $cpuName, ($cpuList | Measure-Object NumberOfCores -Sum).Sum, $computer.NumberOfLogicalProcessors, $environment.os.totalMemoryGB, $environment.os.freeMemoryGB))
    } catch { Record-CollectionError 'environment' $_ }

    # Locate the installation the same way as the gateway collector, plus recent main-log paths.
    try {
        $processes = @(Get-CimSafe Win32_Process -Filter "Name = 'LobsterAI.exe'")
        $installed = @()
        foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
            $installed += @(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName })
        }
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        foreach ($process in $processes) { if ($process.ExecutablePath) { $candidates.Add($process.ExecutablePath) } }
        foreach ($record in @($installed | Where-Object { $_.DisplayName -match 'LobsterAI' })) {
            if ($record.InstallLocation) { $candidates.Add((Join-Path $record.InstallLocation 'LobsterAI.exe')) }
            if ($record.DisplayIcon) { $candidates.Add(($record.DisplayIcon -replace ',\d+$', '').Trim('"')) }
        }
        foreach ($log in @(Get-ChildItem -LiteralPath (Join-Path $userData 'logs') -Filter 'main-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2)) {
            $match = [regex]::Match((Read-DiagnosticTail $log.FullName 1048576), '([A-Za-z]:\\[^\r\n"'']*?)\\resources\\app\.asar')
            if ($match.Success) { $candidates.Add((Join-Path $match.Groups[1].Value 'LobsterAI.exe')) }
        }
        foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if ($base) { $candidates.Add((Join-Path $base 'Programs\LobsterAI\LobsterAI.exe')); $candidates.Add((Join-Path $base 'LobsterAI\LobsterAI.exe')) }
        }
        $valid = @($candidates | Select-Object -Unique | Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and ([IO.Path]::GetFileName($_) -ieq 'LobsterAI.exe') })
        if (-not $AppPath -and $valid.Count -ge 1) { $AppPath = $valid[0] }
        if (-not $AppPath) {
            Write-Host '未找到 LobsterAI 安装位置，请在弹出的窗口中选择 LobsterAI.exe。'
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = New-Object Windows.Forms.OpenFileDialog
            $dialog.Title = '请选择正在使用的 LobsterAI.exe'
            $dialog.Filter = 'LobsterAI.exe|LobsterAI.exe'
            try { if ($dialog.ShowDialog() -eq 'OK') { $AppPath = $dialog.FileName } } finally { $dialog.Dispose() }
        }
        $summary.installCandidates = @($valid)
        # Command lines can carry gateway tokens; only a coarse role is exported.
        $summary.runningLobsterAI = @($processes | ForEach-Object {
            $commandLine = [string]$_.CommandLine
            $role = 'main'
            if ($commandLine -match 'gateway-launcher') { $role = 'gateway' }
            elseif ($commandLine -match 'openclaw-startup|openclaw-gateway-repair') { $role = 'startup-helper' }
            elseif ($commandLine -match 'openclaw\.mjs') { $role = 'openclaw-cli' }
            elseif ($commandLine -match '--type=([a-z-]+)') { $role = $Matches[1] }
            [ordered]@{
                pid = $_.ProcessId; parentPid = $_.ParentProcessId; role = $role; created = [string]$_.CreationDate
                workingSetMB = [math]::Round($_.WorkingSetSize / 1MB); cpuSeconds = [math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7, 1)
            }
        })
        $busyRoles = @($summary.runningLobsterAI | Where-Object { $_.role -in @('gateway', 'startup-helper', 'openclaw-cli') })
        if ($busyRoles.Count -gt 0) {
            $digest.Add('注意：采集时 LobsterAI 正在运行引擎进程，测得的速度可能偏慢。')
            Write-Host '注意：LobsterAI 正在启动引擎，结果可能偏慢。建议先从托盘退出 LobsterAI 再运行本工具。' -ForegroundColor Yellow
        }
        if ($AppPath -and (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
            $AppPath = (Get-Item -LiteralPath $AppPath).FullName
            $runtimeRoot = Join-Path (Split-Path $AppPath) 'resources\cfmind'
            $exeMachine = Get-PeMachine $AppPath
            $application = [ordered]@{
                path = $AppPath; version = [Diagnostics.FileVersionInfo]::GetVersionInfo($AppPath).ProductVersion
                exeMachine = $exeMachine; runtimeRoot = $runtimeRoot
                x64Emulated = ($nativeArchitecture -match 'ARM64') -and ($exeMachine -eq 'x64')
            }
            try { $application.openclawVersion = (Get-Content -LiteralPath (Join-Path $runtimeRoot 'package.json') -Raw | ConvertFrom-Json).version } catch { Record-CollectionError 'runtime version' $_ }
            try {
                $signature = Get-AuthenticodeSignature -LiteralPath $AppPath
                $application.signatureStatus = [string]$signature.Status
                if ($signature.SignerCertificate) { $application.signer = $signature.SignerCertificate.Subject }
            } catch { Record-CollectionError 'signature' $_ }
            try {
                $zone = Get-Content -LiteralPath $AppPath -Stream Zone.Identifier -ErrorAction Stop
                $application.markOfTheWeb = ($zone -join ' ')
            } catch { $application.markOfTheWeb = $null }
            try {
                $koffi = Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'node_modules\koffi') -Filter 'koffi.node' -Recurse -File -ErrorAction Stop | Where-Object { $_.FullName -match 'win32_x64' } | Select-Object -First 1
                if ($koffi) { $application.koffiSignatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $koffi.FullName).Status }
            } catch { }
            $compat = @()
            foreach ($layers in @('HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers', 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers')) {
                try {
                    $properties = Get-ItemProperty -LiteralPath $layers -ErrorAction Stop
                    foreach ($property in $properties.PSObject.Properties) { if ($property.Name -match '(?i)LobsterAI') { $compat += ($property.Name + ' = ' + $property.Value) } }
                } catch { }
            }
            $application.compatibilityLayers = $compat
            $summary.application = $application
            $digest.Add(('LobsterAI {0}（OpenClaw {1}），可执行文件架构 {2}，x64 转译运行：{3}，签名：{4}' -f $application.version, $application.openclawVersion, $exeMachine, $(if ($application.x64Emulated) { '是' } else { '否' }), $application.signatureStatus))
        } else {
            Record-CollectionError 'application selection' 'LobsterAI.exe was not found; engine timings are skipped.'
            $digest.Add('未找到 LobsterAI.exe，已跳过引擎相关测速。')
        }
    } catch { Record-CollectionError 'application' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'environment.json') $environment

    # ------------------------------------------------------------------ 2
    Write-Host '[2/7] 安全软件与当前系统负载'
    $security = [ordered]@{}
    try {
        $security.antivirus = @(Get-CimSafe -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct | ForEach-Object {
            $hex = '{0:X6}' -f [int]$_.productState
            [ordered]@{
                displayName = $_.displayName; productStateHex = $hex
                enabled = @('10', '11') -contains $hex.Substring(2, 2); upToDate = ($hex.Substring(4, 2) -eq '00')
                path = $_.pathToSignedProductExe
            }
        })
        $security.firewall = @(Get-CimSafe -Namespace 'root/SecurityCenter2' -ClassName FirewallProduct | ForEach-Object { [ordered]@{ displayName = $_.displayName; productStateHex = ('{0:X6}' -f [int]$_.productState) } })
        try {
            $mp = Get-MpComputerStatus -ErrorAction Stop
            $security.defender = [ordered]@{
                runningMode = [string]$mp.AMRunningMode; serviceEnabled = $mp.AMServiceEnabled; antivirusEnabled = $mp.AntivirusEnabled
                realTimeProtection = $mp.RealTimeProtectionEnabled; behaviorMonitor = $mp.BehaviorMonitorEnabled
                onAccessProtection = $mp.OnAccessProtectionEnabled; ioavProtection = $mp.IoavProtectionEnabled
                tamperProtected = $mp.IsTamperProtected; signatureUpdated = [string]$mp.AntivirusSignatureLastUpdated
                quickScanEnd = [string]$mp.QuickScanEndTime; fullScanEnd = [string]$mp.FullScanEndTime
            }
        } catch { Record-CollectionError 'defender status' $_ }
        try {
            $preference = Get-MpPreference -ErrorAction Stop
            # Exclusion lists are not read: non-admins cannot see them, and scanners treat enumeration as suspicious.
            $security.defenderPreference = [ordered]@{
                disableRealtimeMonitoring = $preference.DisableRealtimeMonitoring
                controlledFolderAccess = $preference.EnableControlledFolderAccess; cloudBlockLevel = $preference.CloudBlockLevel
            }
        } catch { Record-CollectionError 'defender preference' $_ }
        try { $security.smartAppControlState = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState }
        catch { $security.smartAppControlState = 'unavailable' }
        $deviceGuard = Get-CimSafe -Namespace 'root/Microsoft/Windows/DeviceGuard' -ClassName Win32_DeviceGuard | Select-Object -First 1
        if ($deviceGuard) {
            $security.deviceGuard = [ordered]@{ vbsStatus = $deviceGuard.VirtualizationBasedSecurityStatus; servicesRunning = @($deviceGuard.SecurityServicesRunning) }
        }
        $productPattern = '(?i)360|火绒|Huorong|腾讯|Tencent|电脑管家|金山|Kingsoft|毒霸|瑞星|Rising|江民|奇安信|天擎|深信服|Sangfor|亚信|McAfee|Trellix|Symantec|Norton|CrowdStrike|SentinelOne|Sophos|Kaspersky|卡巴斯基|ESET|Trend Micro|Bitdefender|Avast|AVG|Avira|Endpoint|Antivirus|杀毒|终端安全|防泄漏|Parallels|VMware|VirtualBox'
        $security.matchingInstalledProducts = @($installed | Where-Object { $_.DisplayName -match $productPattern } | Select-Object DisplayName, DisplayVersion, Publisher)
        $antivirusNames = @($security.antivirus | ForEach-Object { $_.displayName + $(if ($_.enabled) { '(开)' } else { '(关)' }) })
        $digest.Add(('安全软件（系统登记）：{0}；Defender 实时防护：{1}；智能应用控制：{2}' -f $(if ($antivirusNames.Count) { $antivirusNames -join '、' } else { '无记录' }), $security.defender.realTimeProtection, $security.smartAppControlState))
        $installedNames = @($security.matchingInstalledProducts | ForEach-Object { $_.DisplayName })
        if ($installedNames.Count) { $digest.Add(('已安装的安全/虚拟化相关软件：{0}' -f ($installedNames -join '、'))) }
    } catch { Record-CollectionError 'security' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'security.json') $security

    $load = [ordered]@{ samples = @() }
    try {
        $before = @{}
        foreach ($process in @(Get-Process)) { try { $before[$process.Id] = $process.TotalProcessorTime.TotalMilliseconds } catch { } }
        for ($sample = 0; $sample -lt 3; $sample++) {
            $cpuTotal = Get-CimSafe Win32_PerfFormattedData_PerfOS_Processor -Filter "Name = '_Total'" | Select-Object -First 1
            $diskTotal = Get-CimSafe Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name = '_Total'" | Select-Object -First 1
            $memory = Get-CimSafe Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1
            $load.samples += [ordered]@{
                at = (Get-Date).ToString('o'); cpuPercent = $cpuTotal.PercentProcessorTime
                diskBusyPercent = $diskTotal.PercentDiskTime; diskIdlePercent = $diskTotal.PercentIdleTime; diskQueue = $diskTotal.CurrentDiskQueueLength
                diskReadMBps = [math]::Round($diskTotal.DiskReadBytesPersec / 1MB, 1); diskWriteMBps = [math]::Round($diskTotal.DiskWriteBytesPersec / 1MB, 1)
                availableMB = $memory.AvailableMBytes; pagesPerSec = $memory.PagesPersec; commitPercent = $memory.PercentCommittedBytesInUse
            }
            Start-Sleep -Seconds 1
        }
        $processes = @(Get-Process)
        $cpuDelta = @()
        foreach ($process in $processes) {
            try { if ($before.ContainsKey($process.Id)) { $cpuDelta += [ordered]@{ name = $process.ProcessName; cpuMs = [int]($process.TotalProcessorTime.TotalMilliseconds - $before[$process.Id]) } } } catch { }
        }
        $load.topCpuDuringSampling = @($cpuDelta | Sort-Object { $_.cpuMs } -Descending | Select-Object -First 12)
        $load.topMemory = @($processes | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 | ForEach-Object { [ordered]@{ name = $_.ProcessName; workingSetMB = [math]::Round($_.WorkingSet64 / 1MB) } })
        # Names and publishers identify security and virtualization software; paths and command lines are not exported.
        $load.processNames = @($processes | Group-Object ProcessName | Sort-Object Name | ForEach-Object {
            $group = $_
            $company = $null
            try { $company = ($group.Group | Select-Object -First 1).Company } catch { }
            [ordered]@{ name = $group.Name; count = $group.Count; company = $company }
        })
        $vmProcesses = @($load.processNames | Where-Object { $_.name -match '(?i)^(prl_|vmtoolsd|vm3dservice|VBoxService|VBoxTray|qemu-ga)' } | ForEach-Object { $_.name })
        if ($vmProcesses.Count) { $digest.Add(('虚拟机工具进程：{0}' -f ($vmProcesses -join '、'))) }
        $cpuAverage = ($load.samples | ForEach-Object { [double]$_.cpuPercent } | Measure-Object -Average).Average
        $diskAverage = ($load.samples | ForEach-Object { [double]$_.diskBusyPercent } | Measure-Object -Average).Average
        $digest.Add(('采集开始时负载：CPU {0:N0}%，磁盘忙 {1:N0}%，可用内存 {2} MB；CPU 占用最高：{3}' -f $cpuAverage, $diskAverage, $load.samples[-1].availableMB, ((@($load.topCpuDuringSampling | Select-Object -First 5 | ForEach-Object { $_.name + ' ' + $_.cpuMs + 'ms' })) -join '、')))
    } catch { Record-CollectionError 'load' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'load.json') $load

    # ------------------------------------------------------------------ 3
    Write-Host '[3/7] 安装目录、数据目录与磁盘'
    $storage = [ordered]@{}
    try {
        $storage.logicalDisks = @(Get-CimSafe Win32_LogicalDisk | ForEach-Object {
            [ordered]@{ drive = $_.DeviceID; driveType = $_.DriveType; fileSystem = $_.FileSystem; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1); networkProvider = $_.ProviderName }
        })
        try {
            if ($null -eq $script:physicalDiskCache) { $script:physicalDiskCache = @(Get-PhysicalDisk -ErrorAction Stop) }
            $storage.physicalDisks = @($script:physicalDiskCache | ForEach-Object {
                [ordered]@{ id = [string]$_.DeviceId; model = $_.FriendlyName; mediaType = [string]$_.MediaType; busType = [string]$_.BusType; sizeGB = [math]::Round($_.Size / 1GB, 1); health = [string]$_.HealthStatus }
            })
        } catch { Record-CollectionError 'physical disks' $_ }
        $installDir = if ($AppPath) { Split-Path $AppPath } else { $null }
        $storage.paths = @(
            (Get-PathEvidence 'install' $installDir),
            (Get-PathEvidence 'runtime' $runtimeRoot),
            (Get-PathEvidence 'userData' $userData),
            (Get-PathEvidence 'state' $stateDir),
            (Get-PathEvidence 'temp' ([IO.Path]::GetTempPath()))
        )
        foreach ($entry in $storage.paths) {
            if ($entry.path -and $entry.label -in @('install', 'userData', 'temp')) {
                $digest.Add(('{0} 目录：盘 {1}，类型 {2}/{3}，{4}，剩余 {5} GB{6}{7}' -f $entry.label, ([IO.Path]::GetPathRoot([string]$entry.path)), $entry.mediaType, $entry.busType, $entry.fileSystem, $entry.freeGB, $(if ($entry.networkProvider) { '，网络/共享盘 ' + $entry.networkProvider } else { '' }), $(if ($entry.linkType) { '，链接到 ' + $entry.target } else { '' })))
            }
        }
        if ($runtimeRoot) {
            Write-Host '    统计引擎文件数量…'
            $storage.runtime = Get-FolderStats $runtimeRoot -BudgetSeconds 45 -ByTopLevel
        }
        Write-Host '    统计引擎数据大小（只统计大小，不读取内容）…'
        $storage.state = Get-FolderStats $stateDir -BudgetSeconds 60 -ByTopLevel -CollectPattern '\.sqlite(?:-wal|-shm|-journal)?$'
        $storage.lobsteraiDatabase = @(Get-ChildItem -LiteralPath $userData -Filter 'lobsterai.sqlite*' -File -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ name = $_.Name; mb = [math]::Round($_.Length / 1MB, 1) } })
        $repairRoot = Join-Path $openclawBase 'repair-backups'
        $storage.repairBackups = @()
        if (Test-Path -LiteralPath $repairRoot -PathType Container) {
            $repairBudget = [Diagnostics.Stopwatch]::StartNew()
            foreach ($run in @(Get-ChildItem -LiteralPath $repairRoot -Directory | Sort-Object Name -Descending)) {
                $remaining = 60 - [int]$repairBudget.Elapsed.TotalSeconds
                if ($remaining -le 2) { $storage.repairBackups += [ordered]@{ name = $run.Name; skipped = 'time budget' }; continue }
                $stats = Get-FolderStats $run.FullName -BudgetSeconds ([math]::Min(20, $remaining))
                $storage.repairBackups += [ordered]@{ name = $run.Name; files = $stats.files; gb = $stats.gb; truncated = $stats.truncatedByTimeBudget; topLevelFiles = @(Get-ChildItem -LiteralPath $run.FullName -File | ForEach-Object { $_.Name }) }
            }
        }
        if ($storage.runtime) { $digest.Add(('引擎安装文件：{0} 个，{1} GB（统计用时 {2} 秒{3}）' -f $storage.runtime.files, $storage.runtime.gb, $storage.runtime.walkSeconds, $(if ($storage.runtime.truncatedByTimeBudget) { '，未统计完' } else { '' }))) }
        $largestDatabases = @($storage.state.matchedFiles | Where-Object { $_.path -match '\.sqlite$' } | Select-Object -First 3 | ForEach-Object { $_.path + ' ' + [math]::Round($_.bytes / 1MB, 1) + 'MB' })
        $sidecars = @($storage.state.matchedFiles | Where-Object { $_.path -match '-(?:wal|journal)$' -and $_.bytes -gt 0 } | ForEach-Object { $_.path + ' ' + [math]::Round($_.bytes / 1MB, 1) + 'MB' })
        $digest.Add(('引擎数据：{0} GB，{1} 个文件（{2}）；最大数据库：{3}' -f $storage.state.gb, $storage.state.files, $(if ($storage.state.truncatedByTimeBudget) { '未统计完' } else { '已统计完' }), ($largestDatabases -join '、')))
        if ($sidecars.Count) { $digest.Add(('未合并的 WAL/日志文件：{0}' -f ($sidecars -join '、'))) }
        $repairTotal = ($storage.repairBackups | ForEach-Object { [double]$_.gb } | Measure-Object -Sum).Sum
        $digest.Add(('一键修复备份：{0} 份，共约 {1:N1} GB' -f $storage.repairBackups.Count, $repairTotal))
    } catch { Record-CollectionError 'storage' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'storage.json') $storage

    # ------------------------------------------------------------------ 4
    Write-Host '[4/7] 文件读写与进程启动测速'
    $performance = [ordered]@{}
    if ($AppPath -and $runtimeRoot -and (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
        $setA = New-Object 'System.Collections.Generic.List[string]'
        $setB = New-Object 'System.Collections.Generic.List[string]'
        try {
            # Plugin payloads are not loaded until the gateway starts, so after an update they are unread.
            $sample = @(Get-SampleFiles (Join-Path $runtimeRoot 'third-party-extensions'))
            if ($sample.Count -lt 40) { $sample = @(Get-SampleFiles (Join-Path $runtimeRoot 'dist')) }
            for ($index = 0; $index -lt $sample.Count; $index++) { if ($index % 2 -eq 0) { $setA.Add($sample[$index]) } else { $setB.Add($sample[$index]) } }
            Write-Host ('    PowerShell 首次读取 {0} 个引擎文件…' -f $setB.Count)
            $psLatencies = New-Object 'System.Collections.Generic.List[double]'
            $psFailures = 0
            foreach ($file in $setB) {
                $watch = [Diagnostics.Stopwatch]::StartNew()
                try { [void][IO.File]::ReadAllBytes($file) } catch { $psFailures++; continue }
                $watch.Stop()
                $psLatencies.Add($watch.Elapsed.TotalMilliseconds)
            }
            $performance.powershellColdRead = Get-Stats $psLatencies.ToArray()
            $performance.powershellColdRead.failures = $psFailures
        } catch { Record-CollectionError 'performance-powershell-read' $_ }
        try {
            # Windows PowerShell 5.1 throws "Argument types do not match" for @($list) on a
            # List[object] variable, so lists cross into the request through ToArray() only.
            # The probe picks database, disk-latency and Defender comparison targets itself.
            $request = [ordered]@{
                installRoot = (Split-Path $AppPath)
                runtimeRoot = $runtimeRoot
                stateDir = $stateDir
                userDataDir = $userData
                reportPath = (Join-Path $reportDir 'performance-probe.json')
                coldFiles = $setA.ToArray()
                crossFiles = $setB.ToArray()
                writeDirs = @(
                    [ordered]@{ label = 'userData'; path = (Join-Path $benchDataDir 'files'); count = 100 },
                    [ordered]@{ label = 'temp'; path = (Join-Path $runRoot 'bench-temp'); count = 50 }
                )
                sqliteDir = (Join-Path $benchDataDir 'sqlite')
                spawn = $true
            }
            $requestPath = Join-Path $runRoot 'performance-request.json'
            [IO.File]::WriteAllText($requestPath, (ConvertTo-Json -InputObject $request -Depth 6), (New-Object Text.UTF8Encoding($false)))
            # Embedded builds have no script directory; write the probe into this run's private folder.
            if ($script:EmbeddedPerformanceProbe) {
                $probeScript = Join-Path $runRoot 'performance-probe.cjs'
                [IO.File]::WriteAllText($probeScript, $script:EmbeddedPerformanceProbe, (New-Object Text.UTF8Encoding($false)))
            } else {
                $probeScript = Join-Path $PSScriptRoot 'performance-probe.cjs'
            }
            $performance.probeProcess = Invoke-TimedProcess -FilePath $AppPath -Arguments @($probeScript, $requestPath) -Environment @{ ELECTRON_RUN_AS_NODE = '1' } -WorkingDirectory $runRoot -TimeoutSeconds 1200 -Label '读写与进程测速'
            $probePath = Join-Path $reportDir 'performance-probe.json'
            if (Test-Path -LiteralPath $probePath) {
                $probe = Get-Content -LiteralPath $probePath -Raw -Encoding UTF8 | ConvertFrom-Json
                [IO.File]::WriteAllText($probePath, (Protect-DiagnosticText (Get-Content -LiteralPath $probePath -Raw -Encoding UTF8)), (New-Object Text.UTF8Encoding($false)))
                $sections = $probe.sections
                $digest.Add(('LobsterAI.exe 作为 Node 启动到执行第一行：{0} ms；本机进程启动：LobsterAI -e 0 = {1} ms，cmd = {2} ms，powershell = {3} ms（出现「准备模块」进度：{4}）' -f $probe.runtime.bootstrapMs, ((@($sections.spawn.electronNode | ForEach-Object { [int]$_.ms })) -join '/'), ((@($sections.spawn.cmd | ForEach-Object { [int]$_.ms })) -join '/'), ((@($sections.spawn.powershell | ForEach-Object { [int]$_.ms })) -join '/'), (@($sections.spawn.powershell | Where-Object { $_.powershellProgress }).Count -gt 0)))
                $digest.Add(('OpenClaw 用的 PowerShell 进程查询：{0} ms（OpenClaw 只等 5000 ms）；wmic：{1} ms，退出码 {2}' -f [int]$sections.spawn.powershellProcessStartQuery.ms, [int]$sections.spawn.wmicProcessStartQuery.ms, $sections.spawn.wmicProcessStartQuery.status))
                $digest.Add(('首次读取引擎文件（每个）：LobsterAI p50 {0} ms / p90 {1} ms / 最慢 {2} ms，共 {3} 个用 {4}；PowerShell p50 {5} ms / p90 {6} ms' -f $sections.coldRead.p50Ms, $sections.coldRead.p90Ms, $sections.coldRead.maxMs, $sections.coldRead.count, (Format-Seconds $sections.coldRead.wallMs), $performance.powershellColdRead.p50Ms, $performance.powershellColdRead.p90Ms))
                $digest.Add(('重复读取：LobsterAI 再读同一批 p50 {0} ms；LobsterAI 读 PowerShell 读过的 p50 {1} ms（CPU {2} ms / 墙钟 {3} ms）' -f $sections.repeatRead.p50Ms, $sections.crossProcessRead.p50Ms, $sections.coldRead.cpuMs, $sections.coldRead.wallMs))
                foreach ($location in @($sections.writes.locations)) {
                    $digest.Add(('写入 {0}：4KB 文件创建+落盘 p50 {1} ms / p90 {2} ms；16MB 落盘 {3} MB/s' -f $location.label, $location.smallCreateWriteFsync.p50Ms, $location.smallCreateWriteFsync.p90Ms, $location.largeWriteMBps))
                }
                $digest.Add(('SQLite 单次提交（WAL+FULL）p50 {0} ms / p90 {1} ms；回滚日志模式 p50 {2} ms' -f $sections.sqlite.walFull.commit.p50Ms, $sections.sqlite.walFull.commit.p90Ms, $sections.sqlite.rollbackFull.commit.p50Ms))
                foreach ($group in @($sections.locationGroups.groups)) {
                    $digest.Add(('首次读取 {0}（每个）：p50 {1} ms / p90 {2} ms，共 {3} 个' -f $group.label, $group.p50Ms, $group.p90Ms, $group.count))
                }
                foreach ($file in @($sections.randomReads.files | Where-Object { $_.read })) {
                    $digest.Add(('磁盘随机读 4KB（{0}）：p50 {1} ms / p90 {2} ms，打开文件 {3} ms' -f $file.label, $file.read.p50Ms, $file.read.p90Ms, $file.openMs))
                }
                foreach ($file in @($sections.largeFiles.files | Where-Object { $_.exists })) {
                    $digest.Add(('读取 {0}（{1} MB）：打开 {2} ms，首块 {3} ms，{4} MB/s' -f $file.label, [math]::Round($file.sizeBytes / 1MB, 1), $file.openMs, $file.firstChunkMs, $file.mbPerSec))
                }
            } else { $digest.Add('读写测速没有产出结果，请查看 performance.json 中的 probeProcess。') }
        } catch { Record-CollectionError 'performance' $_ }
    }
    Write-DiagnosticJson (Join-Path $reportDir 'performance.json') $performance

    # ------------------------------------------------------------------ 5
    Write-Host '[5/7] 引擎启动步骤实测（临时空数据）'
    $helpers = [ordered]@{}
    if ($SkipHelpers) { $helpers.skipped = 'SkipHelpers' }
    elseif ($AppPath -and $runtimeRoot -and (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
        try {
            $helperState = Join-Path $helperHome 'state'
            $helperTemp = Join-Path $helperHome 'temp'
            [void](New-Item -ItemType Directory -Path $helperState, $helperTemp -Force)
            [IO.File]::WriteAllText((Join-Path $helperState 'openclaw.json'), "{}`n", (New-Object Text.UTF8Encoding($false)))
            # Same variables the app passes to its startup helpers, pointed at an empty private state.
            $helperEnvironment = @{
                ELECTRON_RUN_AS_NODE = '1'
                OPENCLAW_HOME = $helperHome
                OPENCLAW_STATE_DIR = $helperState
                OPENCLAW_CONFIG_PATH = (Join-Path $helperState 'openclaw.json')
                OPENCLAW_SERVICE_REPAIR_POLICY = 'external'
                NODE_COMPILE_CACHE = (Join-Path $helperHome 'compile-cache')
                TEMP = $helperTemp; TMP = $helperTemp; TMPDIR = $helperTemp
                LOCALAPPDATA = (Join-Path $helperHome 'local-app-data')
                XDG_CACHE_HOME = (Join-Path $helperHome 'cache')
            }
            $runs = @(
                @{ key = 'prepareStartupFirst'; label = '启动准备（第一次）'; arguments = @((Join-Path $runtimeRoot 'openclaw-startup-compat.mjs'), 'prepare-startup'); marker = 'LOBSTERAI_STARTUP_COMPATIBILITY_RESULT ' },
                @{ key = 'prepareStartupSecond'; label = '启动准备（第二次）'; arguments = @((Join-Path $runtimeRoot 'openclaw-startup-compat.mjs'), 'prepare-startup'); marker = 'LOBSTERAI_STARTUP_COMPATIBILITY_RESULT ' },
                @{ key = 'configValidate'; label = '配置校验'; arguments = @((Join-Path $runtimeRoot 'openclaw.mjs'), 'config', 'validate', '--json'); marker = $null },
                @{ key = 'stateMigration'; label = '状态迁移检查'; arguments = @((Join-Path $runtimeRoot 'openclaw-startup-state-migration.mjs')); marker = 'LOBSTERAI_STARTUP_MIGRATION_RESULT ' }
            )
            $budget = [Diagnostics.Stopwatch]::StartNew()
            foreach ($run in $runs) {
                $remaining = $HelperBudgetMinutes * 60 - [int]$budget.Elapsed.TotalSeconds
                if ($remaining -lt 30) { $helpers[$run.key] = [ordered]@{ skipped = 'time budget exhausted' }; continue }
                if ($run.key -eq 'prepareStartupSecond' -and $helpers['prepareStartupFirst'].timedOut) { $helpers[$run.key] = [ordered]@{ skipped = 'first run timed out' }; continue }
                if (-not (Test-Path -LiteralPath $run.arguments[0] -PathType Leaf)) { $helpers[$run.key] = [ordered]@{ skipped = 'entry missing' }; continue }
                $outcome = Invoke-TimedProcess -FilePath $AppPath -Arguments $run.arguments -Environment $helperEnvironment -WorkingDirectory $runtimeRoot -TimeoutSeconds ([math]::Min($HelperTimeoutSeconds, $remaining)) -Label $run.label
                $line = $null
                if ($run.marker) {
                    $line = @(($outcome.stdoutTail -split '\r?\n') | Where-Object { $_.StartsWith($run.marker) }) | Select-Object -Last 1
                    if ($line) { try { $outcome.result = ConvertFrom-Json $line.Substring($run.marker.Length) } catch { } }
                } else {
                    try { $validation = ConvertFrom-Json $outcome.stdoutTail; $outcome.result = [ordered]@{ valid = $validation.valid; warnings = @($validation.warnings).Count } } catch { }
                }
                $helpers[$run.key] = $outcome
            }
            $parts = @()
            foreach ($run in $runs) {
                $outcome = $helpers[$run.key]
                if ($outcome.skipped) { $parts += ($run.label + ' 跳过(' + $outcome.skipped + ')'); continue }
                $parts += ('{0} {1}{2}（进程 CPU {3}）' -f $run.label, (Format-Seconds $outcome.elapsedMs), $(if ($outcome.timedOut) { ' 超时' } elseif ($outcome.exitCode -ne 0) { ' 退出码 ' + $outcome.exitCode } else { '' }), (Format-Seconds $outcome.cpuMs))
            }
            $digest.Add(('引擎启动步骤（空数据）：' + ($parts -join '；') + '。应用里对应的超时：启动准备/状态迁移 180 秒，修复里的配置校验 60 秒。'))
        } catch { Record-CollectionError 'helpers' $_ }
    } else { $helpers.skipped = 'LobsterAI runtime not found' }
    Write-DiagnosticJson (Join-Path $reportDir 'helper-timings.json') $helpers

    # ------------------------------------------------------------------ 6
    Write-Host '[6/7] 收集日志和系统事件'
    [void](New-Item -ItemType Directory -Path (Join-Path $reportDir 'logs') -Force)
    $logIndex = @()
    try {
        $dailyRoots = @((Join-Path $env:TEMP 'openclaw'))
        if ($AppPath) { $dailyRoots += Join-Path ([IO.Path]::GetPathRoot($AppPath)) 'tmp\openclaw' }
        $number = 0
        foreach ($root in ($dailyRoots | Select-Object -Unique)) {
            foreach ($log in @(Get-ChildItem -LiteralPath $root -Filter 'openclaw-*.log' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-3) } | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
                $number++
                $logIndex += Copy-LogTail $log.FullName ('openclaw-' + $number + '-' + $log.Name) 8388608
            }
        }
        foreach ($log in @(Get-ChildItem -LiteralPath (Join-Path $userData 'logs') -Filter 'main-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2)) {
            $logIndex += Copy-LogTail $log.FullName $log.Name 8388608
        }
        foreach ($log in @(Get-ChildItem -LiteralPath (Join-Path $openclawBase 'logs') -Filter 'gateway-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2)) {
            $logIndex += Copy-LogTail $log.FullName $log.Name 4194304
        }
        $installTiming = Join-Path $userData 'install-timing.log'
        if (Test-Path -LiteralPath $installTiming) { $logIndex += Copy-LogTail $installTiming 'install-timing.log' 1048576 }
        # Per-machine installs write later phases, including the Defender exclusion result, here.
        $machineInstallTiming = Join-Path $env:ProgramData 'LobsterAI\install-timing.log'
        if (Test-Path -LiteralPath $machineInstallTiming) { $logIndex += Copy-LogTail $machineInstallTiming 'install-timing-programdata.log' 1048576 }
        $repairRoot = Join-Path $openclawBase 'repair-backups'
        if (Test-Path -LiteralPath $repairRoot -PathType Container) {
            foreach ($run in @(Get-ChildItem -LiteralPath $repairRoot -Directory | Sort-Object Name -Descending | Select-Object -First 5)) {
                # Only repair diagnostics; never the snapshot copy or a configuration backup.
                foreach ($file in @(Get-ChildItem -LiteralPath $run.FullName -File | Where-Object { $_.Name -match '^(?:doctor\.log|doctor-result\.json|snapshot-manifest\.json|[a-z-]+-request\.json)$' })) {
                    $logIndex += Copy-LogTail $file.FullName ('repair-' + $run.Name + '-' + $file.Name) 2097152
                }
            }
        }
    } catch { Record-CollectionError 'logs' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'log-index.json') @($logIndex | Where-Object { $_ })
    $events = [ordered]@{}
    try {
        $since = (Get-Date).AddDays(-7)
        $events.application = Get-EventExcerpt @{ LogName = 'Application'; StartTime = $since; Id = 1000, 1001, 1002 } '(?i)LobsterAI'
        $events.defender = Get-EventExcerpt @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $since; Id = 1006, 1015, 1116, 1117, 1123, 1124, 5007 } '(?i)LobsterAI|cfmind' 800
        $events.codeIntegrity = Get-EventExcerpt @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = $since } '(?i)LobsterAI|cfmind|koffi' 800
    } catch { Record-CollectionError 'events' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'events.json') $events
    $summary.logFilesCollected = @($logIndex | Where-Object { $_ }).Count
} catch {
    Record-CollectionError 'collector' $_
    Write-Host '部分项目未能完成，将把已收集的信息一起打包。' -ForegroundColor Yellow
} finally {
    Write-Host '[7/7] 生成诊断包'
    # Remove only the benchmark files this run created under the user data folder.
    Remove-Item -LiteralPath $benchDataDir -Recurse -Force -ErrorAction SilentlyContinue
    $summary.finishedAt = (Get-Date).ToString('o')
    $summary.partial = $errors.Count -gt 0
    try {
        Write-DiagnosticJson (Join-Path $reportDir 'collection-errors.json') @($errors.ToArray())
        Write-DiagnosticJson (Join-Path $reportDir 'summary.json') $summary
        $header = @(
            'LobsterAI 启动性能诊断摘要',
            ('采集时间：' + $summary.startedAt + ' ~ ' + $summary.finishedAt),
            '详细数据见同目录 JSON 文件；引擎步骤在临时空数据上运行，未修改用户数据。',
            ''
        )
        [IO.File]::WriteAllText((Join-Path $reportDir 'summary.txt'), (Protect-DiagnosticText (($header + $digest.ToArray() + @('', ('收集过程中的错误：' + $errors.Count + ' 项，见 collection-errors.json'))) -join "`r`n")), (New-Object Text.UTF8Encoding($true)))
    } catch { Write-Host ('写入摘要失败：' + $_) -ForegroundColor Yellow }
    if (-not $OutputDirectory) { $OutputDirectory = [Environment]::GetFolderPath('Desktop') }
    if (-not $OutputDirectory) { $OutputDirectory = [IO.Path]::GetTempPath() }
    [void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
    $zipPath = Join-Path $OutputDirectory ('LobsterAI-Performance-Diagnostics-' + $runId + '.zip')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($reportDir, $zipPath)
    # The cleanup boundary is the private directory created at the start of this run.
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '诊断完成，请把下面的 ZIP 文件发给技术支持：' -ForegroundColor Green
    Write-Host $zipPath -ForegroundColor Cyan
    Start-Process explorer.exe -ArgumentList ('/select,"' + $zipPath + '"') -ErrorAction SilentlyContinue
}
