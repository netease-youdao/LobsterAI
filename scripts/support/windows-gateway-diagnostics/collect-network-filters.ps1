param(
    [string]$OutputDirectory,
    [switch]$NoElevation
)

# Network filter collector. Compatible with Windows PowerShell 5.1.
# For machines where connections to listening 127.0.0.1 ports are dropped
# (LobsterAI starts its engine but never reaches it). It checks that once, then,
# after a UAC prompt, runs network-filter-probe.ps1 elevated to read Windows
# Filtering Platform rules and drop records and name the filters responsible.
# Nothing is changed, removed or uploaded.
# build-network-filter-collector.cjs embeds this file, the shared helpers and
# the elevated probe into one .cmd, like the other collectors.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command Protect-DiagnosticText -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'diagnostic-common.ps1') }
if ($env:OS -ne 'Windows_NT') { throw 'This collector requires Windows.' }

$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('lobsterai-filter-diagnostic-' + $runId)
$reportDir = Join-Path $runRoot 'report'
$wfpDir = Join-Path $reportDir 'wfp'
$lines = New-Object 'System.Collections.Generic.List[string]'
$summary = [ordered]@{ toolVersion = 1; kind = 'network-filters'; runId = $runId; startedAt = (Get-Date).ToString('o') }
[void](New-Item -ItemType Directory -Path $reportDir -Force)

# Listens on 127.0.0.1 (port 0 picks a free one), connects and exchanges bytes.
function Test-LoopbackSelf {
    param([int]$Port = 0, [int]$TimeoutMs = 5000)
    $result = [ordered]@{ requestedPort = $Port; ok = $false; phase = 'listen'; code = $null }
    $listener = $null; $client = $null; $accepted = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $result.port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $result.phase = 'connect'
        $client = New-Object Net.Sockets.TcpClient
        if (-not $client.ConnectAsync('127.0.0.1', $result.port).Wait($TimeoutMs)) { $result.code = 'Timeout'; return $result }
        $result.phase = 'accept'
        $acceptTask = $listener.AcceptTcpClientAsync()
        if (-not $acceptTask.Wait($TimeoutMs)) { $result.code = 'Timeout'; return $result }
        $accepted = $acceptTask.Result
        $result.phase = 'exchange'
        $payload = [Text.Encoding]::ASCII.GetBytes('lobsterai-loopback-check')
        $client.GetStream().Write($payload, 0, $payload.Length)
        $stream = $accepted.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $buffer = New-Object byte[] 64
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $result.ok = ([Text.Encoding]::ASCII.GetString($buffer, 0, [Math]::Max(0, $read)) -eq 'lobsterai-loopback-check')
        if ($result.ok) { $result.code = 'Exchanged' } else { $result.code = 'Mismatch' }
    } catch {
        $result.ok = $false
        $current = $_.Exception
        while ($current -and -not ($current -is [Net.Sockets.SocketException])) { $current = $current.InnerException }
        if ($current) { $result.code = [string]$current.SocketErrorCode } else { $result.code = $_.Exception.GetType().Name }
    } finally {
        $watch.Stop()
        $result.elapsedMs = [int]$watch.Elapsed.TotalMilliseconds
        if ($accepted) { $accepted.Close() }
        if ($client) { $client.Close() }
        if ($listener) { $listener.Stop() }
    }
    return $result
}

# Adds files one by one, so one unreadable file (for example one left with the
# elevated process's ACL) costs that file instead of the whole package.
function New-DiagnosticZip {
    param([string]$SourceDir, [string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $skipped = New-Object 'System.Collections.Generic.List[string]'
    $root = (Get-Item -LiteralPath $SourceDir).FullName.TrimEnd('\', '/')
    $zip = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File)) {
            $entryName = $file.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
            try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName) }
            catch { $skipped.Add(($entryName + ': ' + $_.Exception.Message)) }
        }
        if ($skipped.Count) {
            $writer = New-Object IO.StreamWriter(($zip.CreateEntry('zip-skipped.txt')).Open(), (New-Object Text.UTF8Encoding($true)))
            try { $writer.Write(($skipped.ToArray() -join "`r`n")) } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    # Plain output: callers wrap it in @(), and a comma here would nest the array.
    return $skipped.ToArray()
}

function Format-LoopbackResult {
    param($Result)
    if ($Result.ok) { return '正常' }
    return ('被拦截（{0}，阶段 {1}，{2} ms）' -f $Result.code, $Result.phase, $Result.elapsedMs)
}

Write-Host 'LobsterAI 网络过滤诊断' -ForegroundColor Cyan
Write-Host '检查本机程序之间的连接是否被拦截，并读取 Windows 的网络过滤规则，找出是哪条规则拦截的。'
Write-Host '中途会弹出“你要允许此应用对你的设备进行更改吗”，请点“是”：读取过滤规则需要管理员权限。'
Write-Host '只读取，不修改或删除任何设置，也不会自动上传。通常需要 1～3 分钟。'
Write-Host ''

try {
    Write-Host '[1/3] 本机连接测试'
    try {
        $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10 -ErrorAction Stop
        $summary.os = [ordered]@{ caption = $os.Caption; build = $os.BuildNumber; lastBoot = ([datetime]$os.LastBootUpTime).ToString('o') }
        $lines.Add(('系统：{0}（build {1}），本次开机 {2}' -f $os.Caption, $os.BuildNumber, ([datetime]$os.LastBootUpTime).ToString('yyyy-MM-dd HH:mm')))
    } catch { $summary.osError = [string]$_ }
    $before = Test-LoopbackSelf 0 5000
    $summary.loopback = $before
    $lines.Add(('本机连接测试：' + (Format-LoopbackResult $before)))
    if ($before.ok) { Write-Host '    本机连接正常。' -ForegroundColor Green }
    else { Write-Host ('    本机连接' + (Format-LoopbackResult $before)) -ForegroundColor Red }

    Write-Host '[2/3] 读取网络过滤规则（需要管理员权限，请在弹窗中点“是”）'
    if ($NoElevation) {
        $lines.Add('已按参数跳过管理员采集。')
    } else {
        $probePath = Join-Path $runRoot 'network-filter-probe.ps1'
        # Windows PowerShell reads a script without a BOM in the ANSI code page; the probe prints Chinese.
        if ($script:EmbeddedFilterProbe) { [IO.File]::WriteAllText($probePath, $script:EmbeddedFilterProbe, (New-Object Text.UTF8Encoding($true))) }
        else { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'network-filter-probe.ps1') -Destination $probePath }
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $probePath + '" -OutDir "' + $wfpDir + '"'
        try {
            $elevated = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -Wait -PassThru
            $summary.elevatedExitCode = $elevated.ExitCode
        } catch {
            $summary.elevationError = Protect-DiagnosticText ([string]$_)
            Write-Host '    没有获得管理员权限（可能点了“否”），只能收集上面的测试结果。' -ForegroundColor Yellow
            $lines.Add('没有获得管理员权限，未能读取网络过滤规则。请重新运行并在弹窗中点“是”。')
        }
        $wfpSummary = Join-Path $wfpDir 'wfp-summary.txt'
        if (Test-Path -LiteralPath $wfpSummary) {
            foreach ($line in ([IO.File]::ReadAllText($wfpSummary, [Text.Encoding]::UTF8) -split '\r?\n')) { if ($line) { $lines.Add($line) } }
        } elseif (-not $summary.elevationError) {
            $lines.Add(('管理员采集没有产出结果（退出码 {0}）。' -f $summary.elevatedExitCode))
        }
    }

    # A second test shows whether the result changed while the rules were read.
    $after = Test-LoopbackSelf 0 5000
    $summary.loopbackAfter = $after
    $lines.Add(('采集结束时再测一次本机连接：' + (Format-LoopbackResult $after)))
} catch {
    $summary.error = Protect-DiagnosticText ([string]$_)
    $lines.Add(('采集中断：' + $summary.error))
    Write-Host '部分项目未能完成，将把已收集的信息一起打包。' -ForegroundColor Yellow
} finally {
    Write-Host '[3/3] 生成诊断包'
    $summary.finishedAt = (Get-Date).ToString('o')
    $summary.lines = $lines.ToArray()
    try {
        Write-DiagnosticJson (Join-Path $reportDir 'summary.json') $summary
        $header = @('LobsterAI 网络过滤诊断摘要', ('采集时间：' + $summary.startedAt + ' ~ ' + $summary.finishedAt), '')
        [IO.File]::WriteAllText((Join-Path $reportDir 'summary.txt'), (($header + $lines.ToArray()) -join "`r`n"), (New-Object Text.UTF8Encoding($true)))
    } catch { Write-Host ('写入摘要失败：' + $_) -ForegroundColor Yellow }
    if (-not $OutputDirectory) { $OutputDirectory = [Environment]::GetFolderPath('Desktop') }
    if (-not $OutputDirectory) { $OutputDirectory = [IO.Path]::GetTempPath() }
    [void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
    $zipPath = Join-Path $OutputDirectory ('LobsterAI-Network-Filter-Diagnostics-' + $runId + '.zip')
    $skippedFiles = @(New-DiagnosticZip $reportDir $zipPath)
    if ($skippedFiles.Count) { Write-Host ('有 {0} 个文件无法读取，未放进诊断包（清单见包内 zip-skipped.txt）。' -f $skippedFiles.Count) -ForegroundColor Yellow }
    # The cleanup boundary is the private directory created at the start of this run.
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ''
    foreach ($line in $lines) {
        if ($line -match '^\s*★') { Write-Host $line -ForegroundColor Yellow } else { Write-Host $line }
    }
    Write-Host ''
    Write-Host '诊断完成，请把下面的 ZIP 文件发给技术支持：' -ForegroundColor Green
    Write-Host $zipPath -ForegroundColor Cyan
    # The path is already on screen; failing to open Explorer is not an error.
    try { Start-Process explorer.exe -ArgumentList ('/select,"' + $zipPath + '"') } catch { }
}
