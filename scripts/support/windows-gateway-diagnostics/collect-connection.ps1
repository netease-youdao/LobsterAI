param(
    [string]$AppPath,
    [string]$OutputDirectory,
    [int]$GatewayWaitSeconds = 150,
    [switch]$NoLaunch
)

# Engine connection collector. Compatible with Windows PowerShell 5.1.
# For an app that opens but never reaches its own engine gateway, for example
# one that works once after a fresh install and fails after every reboot.
# While the failure is happening it records who listens on the gateway port,
# whether PowerShell, curl and LobsterAI's own runtime can connect to it,
# loopback self-tests, proxy/port/Winsock settings, security and network
# software, boot events and the recent app and engine logs.
# Nothing is repaired, uninstalled, uploaded or reconfigured. The one thing it
# may do is start LobsterAI when it is not running (the user can decline),
# because the failure only shows while the app is up.
# build-connection-collector.cjs embeds this file, the shared helpers and the
# probe into one .cmd, like the performance collector.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command Protect-DiagnosticText -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'diagnostic-common.ps1') }
if ($env:OS -ne 'Windows_NT') { throw 'This collector requires Windows.' }

# DEFAULT_GATEWAY_PORT in openclawEngineManager.ts.
$DefaultGatewayPort = 18789
# Software that can filter, proxy or redirect local connections, and other OpenClaw-based products.
$SecurityPattern = '(?i)360|ZhuDongFangYu|火绒|Huorong|HipsDaemon|HipsTray|usysdiag|电脑管家|QQPCMgr|QQPCRTP|QQPCTray|金山|Kingsoft|毒霸|kxetray|kxescore|瑞星|Rising|RavMon|江民|奇安信|天擎|深信服|Sangfor|亚信|McAfee|Trellix|Symantec|Norton|CrowdStrike|SentinelOne|Sophos|Kaspersky|卡巴斯基|ESET|Trend Micro|Bitdefender|Avast|AVG|Avira|Endpoint|Antivirus|杀毒|终端安全|防泄漏'
$NetworkPattern = '(?i)claw|Clash|mihomo|v2ray|xray|sing-?box|shadowsocks|trojan|Proxifier|SocksCap|Netch|nekoray|WireGuard|OpenVPN|Tailscale|ZeroTier|Wintun|TAP-Windows|WinDivert|Npcap|WinPcap|EasyConnect|aTrust|iNode|AnyConnect|FortiClient|GlobalProtect|加速|accelerat|leigod|雷神|xunyou|迅游|qiyou|奇游|KMS|激活|VPN|代理|proxy'
# Winsock providers that ship with Windows; anything else is a third-party LSP/NSP.
$StandardWinsockProviders = @('mswsock.dll', 'napinsp.dll', 'pnrpnsp.dll', 'nlansp_c.dll', 'nlasvc.dll', 'wshbth.dll', 'winrnr.dll', 'wshqos.dll', 'vsocklib.dll', 'wshhyperv.dll', 'rsvpsp.dll', 'wshtcpip.dll', 'wship6.dll', 'msafd.dll')

$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('lobsterai-connection-diagnostic-' + $runId)
$reportDir = Join-Path $runRoot 'report'
$workDir = Join-Path $runRoot 'probe-work'
$userData = Join-Path $env:APPDATA 'LobsterAI'
$openclawBase = Join-Path $userData 'openclaw'
$stateDir = Join-Path $openclawBase 'state'
$errors = New-Object 'System.Collections.Generic.List[object]'
$digest = New-Object 'System.Collections.Generic.List[string]'
$facts = @{ appRunning = $false; launchedByCollector = $false; gatewayProcess = $false; gatewayPort = $DefaultGatewayPort; listeners = @(); psTcp = @(); envProxy = @() }
$summary = [ordered]@{ toolVersion = 1; kind = 'engine-connection'; runId = $runId; startedAt = (Get-Date).ToString('o') }
$script:companyCache = @{}
$script:cimFailures = @{}
[void](New-Item -ItemType Directory -Path $reportDir, $workDir, (Join-Path $reportDir 'logs') -Force)

function Record-CollectionError {
    param([string]$Stage, $Failure)
    $entry = [ordered]@{ stage = $Stage; error = (Protect-DiagnosticText ([string]$Failure)) }
    if ($Failure -is [System.Management.Automation.ErrorRecord]) {
        $entry.exceptionType = $Failure.Exception.GetType().FullName
        if ($Failure.InvocationInfo) {
            $entry.line = $Failure.InvocationInfo.ScriptLineNumber
            $entry.statement = Protect-DiagnosticText (([string]$Failure.InvocationInfo.Line).Trim())
        }
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
        $script:cimFailures[$ClassName] = $true
        return @()
    }
}

# An empty result and a failed query read the same; the digest must say which.
function Format-CimCount {
    param([string]$ClassName, $Items, [scriptblock]$Describe)
    if ($script:cimFailures.ContainsKey($ClassName)) { return '读取失败（WMI 查询超时或出错）' }
    $list = @($Items)
    return ('{0} 个：{1}' -f $list.Count, (Join-OrNone @($list | Select-Object -First 40 | ForEach-Object $Describe)))
}

function Write-ReportText {
    param([string]$Name, [AllowEmptyString()][string]$Text)
    # A BOM lets Notepad on the customer's machine show Chinese correctly.
    [IO.File]::WriteAllText((Join-Path $reportDir $Name), (Protect-DiagnosticText $Text), (New-Object Text.UTF8Encoding($true)))
}

function Hide-UserInfo {
    param([AllowEmptyString()][string]$Value)
    if (-not $Value) { return $Value }
    return [regex]::Replace($Value, '//[^/@\s]+@', '//<USERINFO>@')
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($Value -match '^[A-Za-z0-9_\-=./:%{}*\\]+$') { return $Value }
    return (ConvertTo-DiagnosticArgument $Value)
}

function ConvertFrom-ConsoleBytes {
    param([byte[]]$Bytes)
    if (-not $Bytes -or $Bytes.Length -eq 0) { return '' }
    try { return (New-Object Text.UTF8Encoding($false, $true)).GetString($Bytes) }
    catch { return [Console]::OutputEncoding.GetString($Bytes) }
}

# Runs a program and returns its exit code and output without waiting forever.
# Output is captured as bytes: LobsterAI's runtime writes UTF-8, and console
# tools write UTF-8 on some Windows 11 builds and the console code page on others.
function Invoke-CapturedProcess {
    param(
        [string]$FilePath, [string[]]$Arguments = @(), [int]$TimeoutSeconds = 30,
        [hashtable]$Environment, [string]$RemoveEnvironmentPattern, [string]$WorkingDirectory
    )
    $result = [ordered]@{ program = [IO.Path]::GetFileName($FilePath); arguments = (@($Arguments) -join ' '); timedOut = $false; stdout = ''; stderr = '' }
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { $result.missing = $true; return $result }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
    if ($RemoveEnvironmentPattern) {
        foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
            if ($key -match $RemoveEnvironmentPattern) { $startInfo.EnvironmentVariables.Remove($key) }
        }
    }
    if ($Environment) { foreach ($key in $Environment.Keys) { $startInfo.EnvironmentVariables[$key] = [string]$Environment[$key] } }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try { [void]$process.Start() } catch { $result.launchError = Protect-DiagnosticText ([string]$_); return $result }
    $stdoutBytes = New-Object IO.MemoryStream
    $stderrBytes = New-Object IO.MemoryStream
    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutBytes)
    $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrBytes)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $result.timedOut = $true
        # Only the process tree this collector started is stopped.
        try { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null } catch { }
        [void]$process.WaitForExit(5000)
    }
    $watch.Stop()
    $result.elapsedMs = [int]$watch.Elapsed.TotalMilliseconds
    try { if ($process.HasExited) { $result.exitCode = $process.ExitCode } } catch { }
    [void]$stdoutTask.Wait(5000)
    [void]$stderrTask.Wait(5000)
    $result.stdout = ConvertFrom-ConsoleBytes $stdoutBytes.ToArray()
    $result.stderr = ConvertFrom-ConsoleBytes $stderrBytes.ToArray()
    $process.Dispose()
    return $result
}

function Get-FileCompany {
    param([string]$Path)
    if (-not $Path) { return $null }
    if ($script:companyCache.ContainsKey($Path)) { return $script:companyCache[$Path] }
    $company = $null
    try { if (Test-Path -LiteralPath $Path -PathType Leaf) { $company = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).CompanyName } } catch { }
    $script:companyCache[$Path] = $company
    return $company
}

function Resolve-SystemPath {
    param([string]$Path)
    if (-not $Path) { return $null }
    $resolved = $Path.Trim().Trim('"')
    $resolved = $resolved -replace '^\\\?\?\\', ''
    $resolved = $resolved -replace '^\\SystemRoot\\', ($env:SystemRoot + '\')
    $resolved = $resolved -replace '^%SystemRoot%\\', ($env:SystemRoot + '\')
    $resolved = $resolved -replace '^%windir%\\', ($env:SystemRoot + '\')
    # Windows path rules spelled out, so the helper behaves the same under pwsh on other systems.
    if ($resolved -notmatch '^(?:[A-Za-z]:\\|\\\\)') { $resolved = $env:SystemRoot.TrimEnd('\') + '\' + $resolved.TrimStart('\') }
    return $resolved
}

function Get-ExecutableFromCommandLine {
    param([string]$CommandLine)
    if (-not $CommandLine) { return $null }
    $text = $CommandLine.Trim()
    if ($text.StartsWith('"')) {
        $end = $text.IndexOf('"', 1)
        if ($end -gt 1) { return (Resolve-SystemPath $text.Substring(1, $end - 1)) }
    }
    $match = [regex]::Match($text, '^(.+?\.(?:exe|sys|dll))(?:\s|$)', 'IgnoreCase')
    if ($match.Success) { return (Resolve-SystemPath $match.Groups[1].Value) }
    return (Resolve-SystemPath (($text -split '\s+')[0]))
}

# Command lines can carry gateway tokens; they are only classified, never exported.
function Get-LobsterProcessRole {
    param([AllowEmptyString()][string]$CommandLine)
    # The gateway runs through gateway-launcher.cjs or, without the bundle, openclaw.mjs gateway --port.
    if ($CommandLine -match 'gateway-launcher') { return 'gateway' }
    if ($CommandLine -match '(?:^|[\s"''])gateway(?:[\s"'']|$)' -and $CommandLine -match '--port') { return 'gateway' }
    if ($CommandLine -match 'openclaw-startup|openclaw-gateway-repair') { return 'startup-helper' }
    if ($CommandLine -match 'openclaw\.mjs') { return 'openclaw-cli' }
    if ($CommandLine -match '--type=([a-z-]+)') { return $Matches[1] }
    if ($CommandLine -match '\.(?:c|m)?js["'']?(?:\s|$)') { return 'node-helper' }
    return 'main'
}

function Get-GatewayPortFromCommandLine {
    param([AllowEmptyString()][string]$CommandLine)
    if ($CommandLine -match '--port["'']?\s+["'']?(\d{2,5})') { return [int]$Matches[1] }
    return $null
}

function Get-LobsterProcesses {
    $items = @()
    foreach ($process in @(Get-CimSafe Win32_Process -Filter "Name = 'LobsterAI.exe'")) {
        $commandLine = [string]$process.CommandLine
        $items += [pscustomobject]@{
            pid = [int]$process.ProcessId; parentPid = [int]$process.ParentProcessId
            role = (Get-LobsterProcessRole $commandLine); gatewayPort = (Get-GatewayPortFromCommandLine $commandLine)
            path = [string]$process.ExecutablePath; created = [string]$process.CreationDate
        }
    }
    return $items
}

function ConvertTo-TcpState {
    param([string]$State)
    switch ($State) {
        'LISTENING' { return 'Listen' }
        'ESTABLISHED' { return 'Established' }
        'SYN_SENT' { return 'SynSent' }
        'SYN_RECEIVED' { return 'SynReceived' }
        'TIME_WAIT' { return 'TimeWait' }
        'CLOSE_WAIT' { return 'CloseWait' }
        'FIN_WAIT_1' { return 'FinWait1' }
        'FIN_WAIT_2' { return 'FinWait2' }
        'LAST_ACK' { return 'LastAck' }
    }
    return $State
}

# Get-NetTCPConnection needs the NetTCPIP module; netstat is the fallback on trimmed systems.
function Get-TcpTable {
    param([switch]$ListenOnly)
    try {
        if ($ListenOnly) { $rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) } else { $rows = @(Get-NetTCPConnection -ErrorAction Stop) }
        return @($rows | ForEach-Object {
            [pscustomobject]@{ localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; remoteAddress = [string]$_.RemoteAddress; remotePort = [int]$_.RemotePort; state = [string]$_.State; pid = [int]$_.OwningProcess }
        })
    } catch {
        # "No matching connections" is an error too; a missing command must still fall back.
        if ([string]$_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return @() }
        if (-not $script:tcpTableFallbackRecorded) { Record-CollectionError 'Get-NetTCPConnection' $_; $script:tcpTableFallbackRecorded = $true }
    }
    $netstat = Invoke-CapturedProcess -FilePath (Join-Path $env:SystemRoot 'System32\NETSTAT.EXE') -Arguments @('-ano') -TimeoutSeconds 30
    $rows = @()
    foreach ($line in ($netstat.stdout -split '\r?\n')) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+|\*)\s+(\S+)\s+(\d+)\s*$') {
            $state = ConvertTo-TcpState $Matches[5]
            if ($ListenOnly -and $state -ne 'Listen') { continue }
            $rows += [pscustomobject]@{ localAddress = $Matches[1].Trim('[', ']'); localPort = [int]$Matches[2]; remoteAddress = $Matches[3].Trim('[', ']'); remotePort = $(if ($Matches[4] -eq '*') { 0 } else { [int]$Matches[4] }); state = $state; pid = [int]$Matches[6] }
        }
    }
    return $rows
}

function Test-KeyPressed {
    try {
        if ([Console]::IsInputRedirected) { return $false }
        if ([Console]::KeyAvailable) { [void][Console]::ReadKey($true); return $true }
    } catch { }
    return $false
}

function Read-LaunchChoice {
    param([int]$Seconds = 15)
    try { if ([Console]::IsInputRedirected) { return $true } } catch { return $true }
    for ($left = $Seconds; $left -gt 0; $left--) {
        Write-Host -NoNewline ("`r    {0} 秒后自动打开 LobsterAI（按 N 跳过，按其他键立即打开）   " -f $left)
        $until = (Get-Date).AddSeconds(1)
        while ((Get-Date) -lt $until) {
            try {
                if ([Console]::KeyAvailable) {
                    $key = [Console]::ReadKey($true)
                    Write-Host ''
                    return ($key.Key -ne [ConsoleKey]::N)
                }
            } catch { }
            Start-Sleep -Milliseconds 100
        }
    }
    Write-Host ''
    return $true
}

function Wait-ForGateway {
    param([int]$TimeoutSeconds)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $state = [ordered]@{ found = $false; skipped = $false; waitedSeconds = 0 }
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $lobster = @(Get-LobsterProcesses)
        $gateway = @($lobster | Where-Object { $_.role -eq 'gateway' }) | Select-Object -First 1
        if ($gateway -and $gateway.gatewayPort) {
            $listening = @(Get-TcpTable -ListenOnly | Where-Object { $_.localPort -eq $gateway.gatewayPort -and $_.pid -eq $gateway.pid })
            if ($listening.Count -gt 0) { $state.found = $true; break }
        }
        if ($lobster.Count -eq 0) { $phase = '等待 LobsterAI 启动' } elseif (-not $gateway) { $phase = '等待引擎进程出现' } else { $phase = '等待引擎开始监听' }
        Write-Host -NoNewline ("`r    {0}：已等待 {1} 秒（按任意键跳过等待）   " -f $phase, [int]$watch.Elapsed.TotalSeconds)
        if (Test-KeyPressed) { $state.skipped = $true; break }
        Start-Sleep -Seconds 2
    }
    Write-Host ''
    $state.waitedSeconds = [int]$watch.Elapsed.TotalSeconds
    return $state
}

function Get-SocketException {
    param($Exception)
    $current = $Exception
    while ($current) {
        if ($current -is [Net.Sockets.SocketException]) { return $current }
        $current = $current.InnerException
    }
    return $null
}

function Set-SocketFailure {
    param($Result, $Exception)
    $Result.ok = $false
    $socketError = Get-SocketException $Exception
    if ($socketError) {
        $Result.code = [string]$socketError.SocketErrorCode
        $Result.nativeErrorCode = $socketError.NativeErrorCode
    } else {
        $innermost = $Exception
        while ($innermost.InnerException) { $innermost = $innermost.InnerException }
        $Result.code = $innermost.GetType().Name
    }
    $Result.message = [string]$Exception.Message
}

function Test-TcpConnect {
    param([int]$Port, [int]$TimeoutMs = 5000)
    $result = [ordered]@{ port = $Port; ok = $false; code = $null }
    $client = New-Object Net.Sockets.TcpClient
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($client.ConnectAsync('127.0.0.1', $Port).Wait($TimeoutMs)) { $result.ok = $true; $result.code = 'Connected' }
        else { $result.code = 'Timeout' }
    } catch {
        Set-SocketFailure $result $_.Exception
    } finally {
        $watch.Stop()
        $result.elapsedMs = [int]$watch.Elapsed.TotalMilliseconds
        $client.Close()
    }
    return $result
}

function Test-RawHttpGet {
    param([int]$Port, [string]$Path = '/startupz', [int]$TimeoutMs = 5000)
    $result = [ordered]@{ port = $Port; path = $Path; ok = $false; code = $null }
    $client = New-Object Net.Sockets.TcpClient
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $client.ConnectAsync('127.0.0.1', $Port).Wait($TimeoutMs)) { $result.code = 'Timeout'; return $result }
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $request = [Text.Encoding]::ASCII.GetBytes("GET $Path HTTP/1.1`r`nHost: 127.0.0.1:$Port`r`nConnection: close`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        $buffer = New-Object byte[] 4096
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { $result.code = 'ClosedWithoutResponse'; return $result }
        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        $result.ok = $true
        $result.code = 'Response'
        $result.statusLine = ($text -split "`r?`n")[0]
        $bodyIndex = $text.IndexOf("`r`n`r`n")
        if ($bodyIndex -ge 0) { $result.bodyPreview = $text.Substring($bodyIndex + 4, [Math]::Min(200, $text.Length - $bodyIndex - 4)) }
    } catch {
        Set-SocketFailure $result $_.Exception
    } finally {
        $watch.Stop()
        $result.elapsedMs = [int]$watch.Elapsed.TotalMilliseconds
        $client.Close()
    }
    return $result
}

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
        Set-SocketFailure $result $_.Exception
    } finally {
        $watch.Stop()
        $result.elapsedMs = [int]$watch.Elapsed.TotalMilliseconds
        if ($accepted) { $accepted.Close() }
        if ($client) { $client.Close() }
        if ($listener) { $listener.Stop() }
    }
    return $result
}

function Get-CurlMeaning {
    param($ExitCode)
    switch ([string]$ExitCode) {
        '0' { return '成功' }
        '7' { return '无法连接（被拒绝或被拦截）' }
        '28' { return '超时' }
        '52' { return '连接后没有收到任何响应' }
        '56' { return '接收失败（连接被重置）' }
        '' { return '没有运行' }
    }
    return ('退出码 ' + $ExitCode)
}

function Invoke-CurlProbe {
    param([int]$Port)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    # --noproxy keeps curl's own proxy variables out of a pure loopback test.
    $run = Invoke-CapturedProcess -FilePath $curl -Arguments @('-sS', '--noproxy', '*', '-m', '5', '-o', 'NUL', '-w', 'HTTP_CODE=%{http_code}', ('http://127.0.0.1:' + $Port + '/startupz')) -TimeoutSeconds 20
    $result = [ordered]@{ port = $Port; available = (-not $run.missing); exitCode = $run.exitCode; meaning = (Get-CurlMeaning $run.exitCode); output = ($run.stdout + ' ' + $run.stderr).Trim(); elapsedMs = $run.elapsedMs }
    $result.ok = ($run.exitCode -eq 0)
    return $result
}

function Get-PortRanges {
    param([AllowEmptyString()][string]$Text)
    $ranges = @()
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^\s*(\d{1,5})\s+(\d{1,5})\s*(\*)?\s*$') {
            $ranges += [pscustomobject]@{ start = [int]$Matches[1]; end = [int]$Matches[2]; administered = [bool]$Matches[3] }
        }
    }
    return $ranges
}

function Test-PortInRanges {
    param([int]$Port, $Ranges)
    foreach ($range in @($Ranges)) { if ($range -and $Port -ge $range.start -and $Port -le $range.end) { return $true } }
    return $false
}

function Get-DynamicPortRange {
    param([AllowEmptyString()][string]$Text)
    $numbers = @([regex]::Matches($Text, '[:：]\s*(\d+)') | ForEach-Object { [int]$_.Groups[1].Value })
    if ($numbers.Count -ge 2) { return [pscustomobject]@{ start = $numbers[0]; count = $numbers[1]; end = $numbers[0] + $numbers[1] - 1 } }
    return $null
}

function Get-WinsockProviderPaths {
    param([AllowEmptyString()][string]$Text)
    return @([regex]::Matches($Text, '(?i)(?:[A-Za-z]:\\|%[A-Za-z_]+%\\)[^\r\n]*?\.dll') | ForEach-Object { $_.Value.Trim() } | Select-Object -Unique)
}

function Get-ThirdPartyWinsockProviders {
    param($Paths)
    return @(@($Paths) | Where-Object { $_ -and ($StandardWinsockProviders -notcontains (($_ -split '[\\/]')[-1]).ToLowerInvariant()) })
}

function Join-OrNone {
    param($Items, [string]$Separator = '、')
    $list = @(@($Items) | Where-Object { $null -ne $_ -and [string]$_ -ne '' })
    if ($list.Count -eq 0) { return '无' }
    return ($list -join $Separator)
}

function Format-Known {
    param($Value)
    if ($null -eq $Value -or [string]$Value -eq '') { return '未知' }
    return [string]$Value
}

function Get-ProbeDetailKind {
    param([string]$Detail)
    if ($Detail -match 'fetch failed') { return 'fetch failed' }
    if ($Detail -match '(?i)aborted') { return 'timeout' }
    if ($Detail -match 'HTTP (\d{3})') { return ('HTTP ' + $Matches[1]) }
    return 'other'
}

# The app's own view of its newest startup, from main-log text.
function Get-GatewayStartupTimeline {
    param([AllowEmptyString()][string]$Text)
    $lines = @($Text -split '\r?\n')
    $startIndex = 0
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        if ($lines[$index] -match 'LobsterAI started \(') { $startIndex = $index; break }
    }
    $timeline = [ordered]@{
        startedAt = $null; gatewaySpawns = 0; gatewaySelfReady = 0; readyConfirmed = 0; waitTimeouts = 0
        healthFailures = 0; probeNotReady = 0; probeDetails = [ordered]@{}; firstSelfReadyAt = $null; lastTimeoutAt = $null
    }
    for ($index = $startIndex; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        $time = $null
        if ($line -match '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') { $time = $Matches[1] }
        if ($line -match 'LobsterAI started \(') { $timeline.startedAt = $time; continue }
        if ($line -match '\[OpenClaw\] gateway process spawned') { $timeline.gatewaySpawns++ }
        elseif ($line -match 'startup milestone .*\[gateway\] ready\s*$') {
            $timeline.gatewaySelfReady++
            if (-not $timeline.firstSelfReadyAt) { $timeline.firstSelfReadyAt = $time }
        }
        elseif ($line -match 'waitForGatewayReady: gateway startup complete') { $timeline.readyConfirmed++ }
        elseif ($line -match 'waitForGatewayReady: timed out') { $timeline.waitTimeouts++; $timeline.lastTimeoutAt = $time }
        elseif ($line -match 'failed to become healthy') { $timeline.healthFailures++ }
        elseif ($line -match 'startup probe details: (.+?)\s*$') {
            $timeline.probeNotReady++
            $kind = Get-ProbeDetailKind $Matches[1]
            if ($timeline.probeDetails.Contains($kind)) { $timeline.probeDetails[$kind]++ } else { $timeline.probeDetails[$kind] = 1 }
        }
    }
    return $timeline
}

function Format-Counts {
    param($Counts)
    $parts = @()
    if ($Counts) { foreach ($key in @($Counts.Keys)) { $parts += ($key + '×' + $Counts[$key]) } }
    if ($parts.Count -eq 0) { return '无' }
    return ($parts -join '、')
}

function Format-ErrorCodes {
    param($Codes)
    $list = @(@($Codes) | Where-Object { $_ } | Select-Object -Unique)
    if ($list.Count -eq 0) { return '无错误码' }
    return ($list -join '、')
}

# Pure function over the collected facts; the first line is the main conclusion.
function Get-ConnectionVerdict {
    param([hashtable]$Facts)
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $port = $Facts.gatewayPort
    $listeners = @($Facts.listeners | Where-Object { $_ })
    $gatewayListeners = @($listeners | Where-Object { $_.isGateway })
    $psOk = @($Facts.psTcp | Where-Object { $_ -and $_.ok }).Count -gt 0
    $psCodes = @($Facts.psTcp | Where-Object { $_ -and -not $_.ok } | ForEach-Object { $_.code })
    $node = $Facts.nodeGateway
    $nodeTcpOk = $false; $nodeFetchOk = $false; $nodeCodes = @()
    if ($node) { $nodeTcpOk = [int]$node.tcpOk -gt 0; $nodeFetchOk = [int]$node.fetchOk -gt 0; $nodeCodes = @($node.errorCodes) }
    if (-not $Facts.appRunning) {
        $lines.Add('采集时 LobsterAI 没有运行，无法检测引擎连接。请在问题出现时（LobsterAI 已打开、引擎一直启动中或启动失败）再运行一次本工具。')
    } elseif ($listeners.Count -eq 0) {
        if ($Facts.gatewayProcess) { $lines.Add(('引擎进程在运行，但端口 {0} 上没有程序监听：引擎可能还在启动，或绑定端口失败（见网关日志）。' -f $port)) }
        else { $lines.Add('没有找到正在运行的引擎进程（可能已因启动超时被 LobsterAI 停止）。请在 LobsterAI 显示“引擎启动中”时运行本工具，或查看日志里的失败原因。') }
    } elseif ($gatewayListeners.Count -eq 0) {
        $owner = $listeners[0]
        $lines.Add(('端口 {0} 被其他程序占用：{1}（PID {2}，监听地址 {3}）。' -f $port, $owner.name, $owner.pid, $owner.address))
    } elseif (-not $node) {
        if ($psOk) { $lines.Add(('引擎在监听端口 {0}，PowerShell 可以连上；LobsterAI 运行时测试没有完成，见 connection-probe 结果。' -f $port)) }
        else { $lines.Add(('引擎在监听端口 {0}，但 PowerShell 连不上（{1}）；LobsterAI 运行时测试没有完成。' -f $port, (Format-ErrorCodes $psCodes))) }
    } elseif ($psOk -and $nodeTcpOk -and $nodeFetchOk) {
        $text = '采集时引擎可以正常连接（{0}），问题没有复现。' -f $node.startupStatus
        if ($Facts.timeline -and [int]$Facts.timeline.probeNotReady -gt 0 -and [int]$Facts.timeline.readyConfirmed -eq 0) { $text += '但应用日志显示本次启动一直没探测成功，请在故障出现时再运行一次。' }
        $lines.Add($text)
    } elseif ((-not $psOk) -and (-not $nodeTcpOk)) {
        $lines.Add(('引擎在监听端口 {0}，但 PowerShell（{1}）和 LobsterAI（{2}）都连不上：本机回环连接在系统层被拦截。常见原因是安全软件的网络防护、网络过滤驱动（WFP/LSP）、VPN 或加速器。' -f $port, (Format-ErrorCodes $psCodes), (Format-ErrorCodes $nodeCodes)))
    } elseif ($psOk -and (-not $nodeTcpOk)) {
        $lines.Add(('只有 LobsterAI 自己连不上引擎（PowerShell 能连上，LobsterAI 报 {0}）：多半是安全软件针对 LobsterAI.exe 的网络规则。' -f (Format-ErrorCodes $nodeCodes)))
    } elseif ($nodeTcpOk -and (-not $nodeFetchOk)) {
        $lines.Add(('LobsterAI 能建立 TCP 连接，但 HTTP 请求失败（{0}）：检查代理相关环境变量，或引擎是否拒绝了请求。' -f (Format-ErrorCodes $nodeCodes)))
    } else {
        if ($psOk) { $psText = 'PowerShell 能连上' } else { $psText = ('PowerShell 连不上（' + (Format-ErrorCodes $psCodes) + '）') }
        $lines.Add(('连接结果不一致：{0}；LobsterAI TCP {1}/{2} 次成功，HTTP {3}/{4} 次成功（{5}）。' -f $psText, $node.tcpOk, $node.tcpTotal, $node.fetchOk, $node.fetchTotal, (Format-ErrorCodes $nodeCodes)))
    }
    if ($Facts.gatewayLostDuringTests) { $lines.Add('注意：测试期间引擎进程退出或停止了监听（LobsterAI 的启动等待超时后会停止引擎），上面的连接结果可能不准确，请重新打开 LobsterAI 后尽快再运行一次。') }
    if ($Facts.psSelf -and -not $Facts.psSelf.ok) { $lines.Add(('PowerShell 回环自测失败（{0}）：随机端口的本机连接也不通，系统回环整体异常。' -f $Facts.psSelf.code)) }
    if ($Facts.nodeSelf -and -not $Facts.nodeSelf.ok) { $lines.Add(('LobsterAI 运行时同进程回环自测失败（{0}）。' -f (Format-ErrorCodes $Facts.nodeSelf.codes))) }
    if ($Facts.nodeCross -and -not $Facts.nodeCross.ok) { $lines.Add(('LobsterAI 跨进程回环自测失败（{0}）：和主进程连接引擎是同一种情形。' -f (Format-ErrorCodes $Facts.nodeCross.codes))) }
    if ($Facts.fixedPort) {
        if (-not $Facts.fixedPort.listenOk) { $lines.Add(('端口 {0} 无法新建监听（{1}），可能被占用或被系统保留。' -f $port, $Facts.fixedPort.code)) }
        elseif (-not $Facts.fixedPort.connectOk) { $lines.Add(('在端口 {0} 新建监听后同样连不上（{1}）：拦截只针对这个端口。' -f $port, $Facts.fixedPort.code)) }
    }
    if ($Facts.excludedRangeHit) { $lines.Add(('端口 {0} 位于系统保留端口范围内（通常由 Hyper-V、WSL 或 Docker 保留）。' -f $port)) }
    if ($Facts.portProxyHit) { $lines.Add(('存在涉及端口 {0} 的 netsh portproxy 端口转发规则。' -f $port)) }
    if (@($Facts.envProxy).Count -gt 0) { $lines.Add(('检测到代理或 Node 相关环境变量：{0}。' -f (@($Facts.envProxy) -join '、'))) }
    return $lines.ToArray()
}

function ConvertTo-RedactedObject {
    param($Value, [int]$Depth = 0)
    if ($null -eq $Value -or $Depth -gt 8) { return $Value }
    if ($Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IEnumerable] -and -not ($Value -is [Collections.IDictionary]) -and -not ($Value -is [pscustomobject])) {
        return @($Value | ForEach-Object { ConvertTo-RedactedObject $_ ($Depth + 1) })
    }
    $copy = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
        # Authentication material in openclaw.json is never exported.
        if ($property.Name -match '(?i)auth|token|password|secret|key') { $copy[$property.Name] = '<REDACTED>'; continue }
        $copy[$property.Name] = ConvertTo-RedactedObject $property.Value ($Depth + 1)
    }
    return $copy
}

function Copy-LogTail {
    param([string]$Source, [string]$Name, [int]$Limit)
    try {
        $target = Join-Path $reportDir ('logs\' + $Name)
        [IO.File]::WriteAllText($target, (Protect-DiagnosticText (Read-DiagnosticTail $Source $Limit)), (New-Object Text.UTF8Encoding($false)))
        return [ordered]@{ source = $Source; output = ('logs/' + $Name); tailLimitBytes = $Limit }
    } catch { Record-CollectionError ('log:' + $Source) $_ }
}

function Get-EventExcerpt {
    param([hashtable]$Filter, [string]$Pattern = '.', [int]$MaxEvents = 200, [int]$Keep = 60)
    try {
        $events = @(Get-WinEvent -FilterHashtable $Filter -MaxEvents $MaxEvents -ErrorAction Stop)
    } catch {
        # Get-WinEvent reports "no matching events" as an error.
        return [ordered]@{ note = (Protect-DiagnosticText ([string]$_)); events = @() }
    }
    $matched = @($events | Where-Object { $_.Message -and $_.Message -match $Pattern } | Select-Object -First $Keep)
    return [ordered]@{
        scanned = $events.Count
        events = @($matched | ForEach-Object {
            [ordered]@{ time = $_.TimeCreated.ToString('o'); id = $_.Id; provider = $_.ProviderName; message = (Protect-DiagnosticText ($_.Message.Substring(0, [Math]::Min(400, $_.Message.Length)))) }
        })
    }
}

function Get-ThirdPartyModules {
    param([int]$ProcessId, [string]$InstallDir)
    $modules = @()
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    foreach ($module in @($process.Modules)) {
        $path = [string]$module.FileName
        if (-not $path) { continue }
        if ($InstallDir -and $path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $company = [string]$module.FileVersionInfo.CompanyName
        if ($company -match '(?i)^Microsoft') { continue }
        $modules += [ordered]@{ path = $path; company = $company; version = [string]$module.FileVersionInfo.FileVersion; description = [string]$module.FileVersionInfo.FileDescription }
    }
    return $modules
}

Write-Host 'LobsterAI 引擎连接诊断' -ForegroundColor Cyan
Write-Host '会检测 LobsterAI 和它的 AI 引擎之间的本机连接，并收集日志和相关系统信息。'
Write-Host '不会修改或删除任何数据和设置，也不会自动上传。通常需要 2～4 分钟，请保持此窗口打开。'
Write-Host ''

$installed = @()
$processTable = @{}
try {
    # ------------------------------------------------------------------ 1
    Write-Host '[1/7] 系统与 LobsterAI 安装'
    $system = [ordered]@{}
    try {
        $os = Get-CimSafe Win32_OperatingSystem | Select-Object -First 1
        $windowsKey = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
        $oem = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\OEMInformation' -ErrorAction SilentlyContinue
        $policies = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue
        $power = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction SilentlyContinue
        $lastBoot = [datetime]$os.LastBootUpTime
        $installDate = [datetime]$os.InstallDate
        $system.os = [ordered]@{
            caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; ubr = $windowsKey.UBR
            displayVersion = $windowsKey.DisplayVersion; edition = $windowsKey.EditionID; architecture = $os.OSArchitecture
            installDate = $installDate.ToString('o'); lastBoot = $lastBoot.ToString('o')
            uptimeMinutes = [int]((Get-Date) - $lastBoot).TotalMinutes; fastStartup = $power.HiberbootEnabled
            locale = (Get-Culture).Name; timezone = [TimeZoneInfo]::Local.Id; powershell = $PSVersionTable.PSVersion.ToString()
        }
        # Third-party Windows images often leave their name in these fields.
        $system.image = [ordered]@{
            computerName = $env:COMPUTERNAME; registeredOwner = $windowsKey.RegisteredOwner; registeredOrganization = $windowsKey.RegisteredOrganization
            oemManufacturer = $oem.Manufacturer; oemModel = $oem.Model; oemSupportUrl = $oem.SupportURL; oemSupportPhone = $oem.SupportPhone
        }
        $digest.Add(('系统：{0} {1}（build {2}.{3}），{4}；安装于 {5}，本次开机 {6}（已运行 {7} 分钟），快速启动：{8}' -f $os.Caption, $windowsKey.DisplayVersion, $os.BuildNumber, $windowsKey.UBR, $os.OSArchitecture, $installDate.ToString('yyyy-MM-dd HH:mm'), $lastBoot.ToString('yyyy-MM-dd HH:mm'), $system.os.uptimeMinutes, (Format-Known $power.HiberbootEnabled)))
        $digest.Add(('系统镜像线索：计算机名 {0}；注册所有者 {1}；注册组织 {2}；OEM 信息 {3}' -f $env:COMPUTERNAME, (Format-Known $windowsKey.RegisteredOwner), (Format-Known $windowsKey.RegisteredOrganization), (Join-OrNone @($oem.Manufacturer, $oem.Model, $oem.SupportURL) ' ')))
    } catch { Record-CollectionError 'system' $_ }
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        $system.account = [ordered]@{
            builtinAdministrator = ($identity.User.Value -match '-500$'); elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            enableLua = $policies.EnableLUA; consentPromptBehaviorAdmin = $policies.ConsentPromptBehaviorAdmin
        }
        $digest.Add(('账户：内置 Administrator：{0}；已提权：{1}；UAC（EnableLUA）：{2}' -f $system.account.builtinAdministrator, $system.account.elevated, (Format-Known $policies.EnableLUA)))
    } catch { Record-CollectionError 'account' $_ }

    try {
        foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
            $installed += @(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName })
        }
        $lobster = @(Get-LobsterProcesses)
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        foreach ($process in $lobster) { if ($process.path) { $candidates.Add($process.path) } }
        $appRecords = @($installed | Where-Object { $_.DisplayName -match 'LobsterAI' })
        foreach ($record in $appRecords) {
            if ($record.InstallLocation) { $candidates.Add((Join-Path $record.InstallLocation 'LobsterAI.exe')) }
            if ($record.DisplayIcon) { $candidates.Add(($record.DisplayIcon -replace ',\d+$', '').Trim('"')) }
        }
        foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if ($base) { $candidates.Add((Join-Path $base 'Programs\LobsterAI\LobsterAI.exe')); $candidates.Add((Join-Path $base 'LobsterAI\LobsterAI.exe')) }
        }
        $valid = @($candidates | Select-Object -Unique | Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and ([IO.Path]::GetFileName($_) -ieq 'LobsterAI.exe') })
        if (-not $AppPath -and $valid.Count -ge 1) { $AppPath = $valid[0] }
        if (-not $AppPath) {
            Write-Host '    未找到 LobsterAI 安装位置，请在弹出的窗口中选择 LobsterAI.exe（取消则只收集系统信息）。'
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = New-Object Windows.Forms.OpenFileDialog
            $dialog.Title = '请选择正在使用的 LobsterAI.exe'
            $dialog.Filter = 'LobsterAI.exe|LobsterAI.exe'
            try { if ($dialog.ShowDialog() -eq 'OK') { $AppPath = $dialog.FileName } } finally { $dialog.Dispose() }
        }
        $summary.installRecords = @($appRecords | ForEach-Object { [ordered]@{ name = $_.DisplayName; version = $_.DisplayVersion; location = $_.InstallLocation; hive = ([string]$_.PSPath -replace '^.*::', '' -replace '\\Software\\.*$', '') } })
        if ($AppPath -and (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
            $AppPath = (Get-Item -LiteralPath $AppPath).FullName
            $runtimeRoot = Join-Path (Split-Path $AppPath) 'resources\cfmind'
            $application = [ordered]@{ path = $AppPath; version = [Diagnostics.FileVersionInfo]::GetVersionInfo($AppPath).ProductVersion }
            try { $application.openclawVersion = (Get-Content -LiteralPath (Join-Path $runtimeRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { Record-CollectionError 'runtime version' $_ }
            try {
                $signature = Get-AuthenticodeSignature -LiteralPath $AppPath
                $application.signatureStatus = [string]$signature.Status
                if ($signature.SignerCertificate) { $application.signer = $signature.SignerCertificate.Subject }
            } catch { Record-CollectionError 'signature' $_ }
            $summary.application = $application
            $digest.Add(('LobsterAI {0}（OpenClaw {1}），位置 {2}，签名 {3}' -f $application.version, $application.openclawVersion, $AppPath, $application.signatureStatus))
        } else {
            $AppPath = $null
            Record-CollectionError 'application selection' 'LobsterAI.exe was not found; runtime tests are skipped.'
            $digest.Add('未找到 LobsterAI.exe，已跳过 LobsterAI 运行时测试。')
        }
    } catch { Record-CollectionError 'application' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'system.json') $system

    # ------------------------------------------------------------------ 2
    Write-Host '[2/7] LobsterAI 运行状态'
    $wait = $null
    try {
        $lobster = @(Get-LobsterProcesses)
        $facts.appRunning = $lobster.Count -gt 0
        $gateway = @($lobster | Where-Object { $_.role -eq 'gateway' }) | Select-Object -First 1
        $gatewayListening = $false
        if ($gateway -and $gateway.gatewayPort) {
            $gatewayListening = @(Get-TcpTable -ListenOnly | Where-Object { $_.localPort -eq $gateway.gatewayPort -and $_.pid -eq $gateway.pid }).Count -gt 0
        }
        if (-not $facts.appRunning) {
            if ($AppPath -and -not $NoLaunch) {
                Write-Host '    LobsterAI 没有在运行。要在它打开时才能检测引擎连接。'
                if (Read-LaunchChoice 15) {
                    Start-Process -FilePath $AppPath -WorkingDirectory (Split-Path $AppPath)
                    $facts.launchedByCollector = $true
                    $wait = Wait-ForGateway $GatewayWaitSeconds
                } else { $digest.Add('用户选择不打开 LobsterAI，只收集了日志和系统信息。') }
            }
        } elseif (-not $gatewayListening) {
            if (-not $gateway) { Write-Host '    没有发现引擎进程。如果 LobsterAI 显示启动失败，请在 LobsterAI 里重试，或从托盘退出后重新打开 LobsterAI。' -ForegroundColor Yellow }
            $wait = Wait-ForGateway $GatewayWaitSeconds
        }
        if ($wait -and $wait.found) {
            Write-Host '    引擎已开始监听，再等 10 秒，让 LobsterAI 完成几轮连接检测…'
            Start-Sleep -Seconds 10
        }
        $summary.wait = $wait
        $lobster = @(Get-LobsterProcesses)
        $facts.appRunning = $lobster.Count -gt 0
        $summary.lobsterProcesses = @($lobster | ForEach-Object { [ordered]@{ pid = $_.pid; parentPid = $_.parentPid; role = $_.role; gatewayPort = $_.gatewayPort; created = $_.created } })
        $roles = @($lobster | Group-Object role | ForEach-Object { $_.Name + '×' + $_.Count })
        $state = '未运行'
        if ($facts.appRunning) { $state = '运行中（' + ($roles -join '、') + '）' }
        if ($facts.launchedByCollector) { $state += '，由本工具打开' }
        if ($wait) { $state += ('；等待引擎 {0} 秒，{1}' -f $wait.waitedSeconds, $(if ($wait.found) { '引擎已监听' } elseif ($wait.skipped) { '用户跳过' } else { '超时' })) }
        $digest.Add('LobsterAI 状态：' + $state)
    } catch { Record-CollectionError 'app state' $_ }

    # ------------------------------------------------------------------ 3
    Write-Host '[3/7] 引擎端口与连接测试'
    $connection = [ordered]@{}
    try {
        foreach ($process in @(Get-CimSafe Win32_Process)) {
            $processTable[[int]$process.ProcessId] = [pscustomobject]@{ pid = [int]$process.ProcessId; name = [string]$process.Name; path = [string]$process.ExecutablePath }
        }
        $lobster = @(Get-LobsterProcesses)
        $gateway = @($lobster | Where-Object { $_.role -eq 'gateway' }) | Select-Object -First 1
        $facts.gatewayProcess = [bool]$gateway
        $persistedPort = $null
        $portFile = Join-Path $stateDir 'gateway-port.json'
        try { if (Test-Path -LiteralPath $portFile) { $persistedPort = [int](Get-Content -LiteralPath $portFile -Raw -Encoding UTF8 | ConvertFrom-Json).port } } catch { Record-CollectionError 'gateway-port.json' $_ }
        $candidatePorts = @(@($gateway.gatewayPort, $persistedPort, $DefaultGatewayPort) | Where-Object { $_ } | ForEach-Object { [int]$_ } | Select-Object -Unique)
        $port = $candidatePorts[0]
        $facts.gatewayPort = $port
        $connection.gatewayPort = $port
        $connection.candidatePorts = $candidatePorts
        $connection.persistedPort = $persistedPort

        $allListeners = @(Get-TcpTable -ListenOnly | ForEach-Object {
            $owner = $processTable[[int]$_.pid]
            $ownerPath = $null; $ownerName = $null
            if ($owner) { $ownerPath = $owner.path; $ownerName = $owner.name }
            [pscustomobject]@{ address = $_.localAddress; port = $_.localPort; pid = $_.pid; name = $ownerName; path = $ownerPath; company = (Get-FileCompany $ownerPath) }
        })
        $connection.listeners = @($allListeners | Sort-Object port)
        $facts.listeners = @($allListeners | Where-Object { $_.port -eq $port } | ForEach-Object {
            @{ pid = $_.pid; name = $_.name; address = $_.address; isGateway = [bool]($gateway -and $_.pid -eq $gateway.pid); isLobster = ($_.name -ieq 'LobsterAI.exe') }
        })
        foreach ($candidate in $candidatePorts) {
            $owners = @($allListeners | Where-Object { $_.port -eq $candidate } | ForEach-Object {
                $label = Format-Known $_.name
                if ($gateway -and $_.pid -eq $gateway.pid) { $label += '（引擎）' }
                ('{0} PID {1} {2}' -f $label, $_.pid, $_.address)
            })
            if ($owners.Count -eq 0) { $owners = @('无人监听') }
            $digest.Add(('端口 {0} 监听者：{1}' -f $candidate, ($owners -join '；')))
        }
        $related = @($allListeners | Where-Object { ($_.name -match $NetworkPattern -or $_.name -ieq 'node.exe' -or ($_.port -ge $DefaultGatewayPort -and $_.port -le $DefaultGatewayPort + 80)) -and $_.name -ine 'LobsterAI.exe' })
        if ($related.Count -gt 0) { $digest.Add(('可能冲突的其他监听：' + ((@($related | ForEach-Object { '{0}:{1}（{2} PID {3}）' -f $_.address, $_.port, $_.name, $_.pid })) -join '；'))) }

        # The main process polls every 600 ms; SynSent rows mean its SYNs go unanswered.
        $snapshots = @()
        for ($round = 0; $round -lt 5; $round++) {
            $rows = @(Get-TcpTable | Where-Object { ($_.localPort -eq $port -or $_.remotePort -eq $port) -and $_.state -ne 'Listen' } | ForEach-Object {
                $owner = $processTable[[int]$_.pid]
                $ownerName = $null
                if ($owner) { $ownerName = $owner.name }
                [ordered]@{ local = ($_.localAddress + ':' + $_.localPort); remote = ($_.remoteAddress + ':' + $_.remotePort); state = $_.state; pid = $_.pid; name = $ownerName }
            })
            $snapshots += [ordered]@{ at = (Get-Date).ToString('o'); connections = $rows }
            Start-Sleep -Milliseconds 600
        }
        $connection.portConnectionSnapshots = $snapshots
        $stateCounts = [ordered]@{}
        foreach ($snapshot in $snapshots) { foreach ($row in $snapshot.connections) { $key = $row.state + '/' + $row.name; if ($stateCounts.Contains($key)) { $stateCounts[$key]++ } else { $stateCounts[$key] = 1 } } }
        $digest.Add(('端口 {0} 上的连接（采样 5 次）：{1}' -f $port, (Format-Counts $stateCounts)))

        Write-Host '    PowerShell 连接测试…'
        $psTcp = @()
        for ($attempt = 0; $attempt -lt 3; $attempt++) { $psTcp += Test-TcpConnect $port 5000; Start-Sleep -Milliseconds 300 }
        $facts.psTcp = $psTcp
        $connection.powershellTcp = $psTcp
        $connection.powershellHttp = Test-RawHttpGet $port '/startupz' 5000
        $connection.curl = Invoke-CurlProbe $port
        $connection.powershellSelfTest = Test-LoopbackSelf 0 5000
        $facts.psSelf = $connection.powershellSelfTest
        $digest.Add(('PowerShell 连接 127.0.0.1:{0}：{1}' -f $port, ((@($psTcp | ForEach-Object { '{0}（{1} ms）' -f $_.code, $_.elapsedMs })) -join '、')))
        $httpText = $connection.powershellHttp.code
        if ($connection.powershellHttp.statusLine) { $httpText = $connection.powershellHttp.statusLine + ' ' + ([string]$connection.powershellHttp.bodyPreview -replace '\s+', ' ') }
        $digest.Add(('PowerShell 请求 /startupz：{0}；curl：{1} {2}' -f $httpText, $connection.curl.meaning, $connection.curl.output))
        $digest.Add(('PowerShell 回环自测（随机端口）：{0}' -f $connection.powershellSelfTest.code))
        if (-not $facts.appRunning) {
            # Only while LobsterAI is closed: it would need this port for its own gateway.
            $connection.powershellFixedPortTest = Test-LoopbackSelf $port 5000
            $digest.Add(('PowerShell 在端口 {0} 新建监听并连接：{1}（阶段 {2}）' -f $port, $connection.powershellFixedPortTest.code, $connection.powershellFixedPortTest.phase))
        }

        if ($AppPath) {
            Write-Host '    LobsterAI 运行时连接测试（约 10～60 秒）…'
            $request = [ordered]@{
                reportPath = (Join-Path $reportDir 'connection-probe.json'); workDir = $workDir
                ports = @($candidatePorts | Select-Object -First 2); allowFixedPortTest = (-not $facts.appRunning); budgetMs = 75000
            }
            $requestPath = Join-Path $runRoot 'connection-request.json'
            [IO.File]::WriteAllText($requestPath, (ConvertTo-Json -InputObject $request -Depth 4), (New-Object Text.UTF8Encoding($false)))
            # Embedded builds have no script directory; write the probe into this run's private folder.
            if ($script:EmbeddedConnectionProbe) {
                $probeScript = Join-Path $runRoot 'connection-probe.cjs'
                [IO.File]::WriteAllText($probeScript, $script:EmbeddedConnectionProbe, (New-Object Text.UTF8Encoding($false)))
            } else {
                $probeScript = Join-Path $PSScriptRoot 'connection-probe.cjs'
            }
            # Keep NODE_OPTIONS and proxy variables: the app's main process sees them too.
            $probeRun = Invoke-CapturedProcess -FilePath $AppPath -Arguments @($probeScript, $requestPath) -Environment @{ ELECTRON_RUN_AS_NODE = '1' } -RemoveEnvironmentPattern '^(OPENCLAW_|LOBSTER_|LOBSTERAI_|ELECTRON_)' -WorkingDirectory $workDir -TimeoutSeconds 120
            $connection.probeProcess = [ordered]@{ exitCode = $probeRun.exitCode; timedOut = $probeRun.timedOut; elapsedMs = $probeRun.elapsedMs; launchError = $probeRun.launchError; stdoutTail = (Protect-DiagnosticText ($probeRun.stdout.Substring([Math]::Max(0, $probeRun.stdout.Length - 2000)))); stderrTail = (Protect-DiagnosticText ($probeRun.stderr.Substring([Math]::Max(0, $probeRun.stderr.Length - 2000)))) }
            $probePath = Join-Path $reportDir 'connection-probe.json'
            if (Test-Path -LiteralPath $probePath) {
                $probeText = [IO.File]::ReadAllText($probePath, [Text.Encoding]::UTF8)
                [IO.File]::WriteAllText($probePath, (Protect-DiagnosticText $probeText), (New-Object Text.UTF8Encoding($false)))
                $probe = $probeText | ConvertFrom-Json
                $entry = @($probe.gateway | Where-Object { $_ -and $_.port -eq $port }) | Select-Object -First 1
                if ($entry -and $entry.summary) {
                    $facts.nodeGateway = @{ tcpOk = $entry.summary.tcpOk; tcpTotal = $entry.summary.tcpTotal; fetchOk = $entry.summary.fetchOk; fetchTotal = $entry.summary.fetchTotal; errorCodes = @($entry.summary.errorCodes); startupStatus = $entry.summary.startupStatus }
                    $startupText = $entry.summary.startupStatus
                    if (-not $startupText) { $startupText = '无响应' }
                    $digest.Add(('LobsterAI 运行时（Node {0} / Electron {1}）连接 127.0.0.1:{2}：TCP {3}/{4} 次成功，fetch {5}/{6} 次成功；/startupz {7}；错误码 {8}' -f $probe.runtime.node, $probe.runtime.electron, $port, $entry.summary.tcpOk, $entry.summary.tcpTotal, $entry.summary.fetchOk, $entry.summary.fetchTotal, $startupText, (Format-ErrorCodes $entry.summary.errorCodes)))
                }
                if ($probe.selfTest) {
                    $facts.nodeSelf = @{ ok = [bool]$probe.selfTest.ok; codes = @($probe.selfTest.tcpEcho.code, $probe.selfTest.fetch.code) }
                }
                if ($probe.crossProcess) {
                    $facts.nodeCross = @{ ok = [bool]$probe.crossProcess.ok; codes = @($probe.crossProcess.listen.code, $probe.crossProcess.tcp.code, $probe.crossProcess.fetch.code) }
                }
                $digest.Add(('LobsterAI 运行时回环自测：同进程 {0}，跨进程 {1}；localhost 解析为 {2}' -f $(if ($probe.selfTest.ok) { '通过' } else { '失败' }), $(if ($probe.crossProcess.ok) { '通过' } else { '失败' }), (@($probe.dns.addresses) -join ', ')))
                $fixed = @($probe.fixedPort | Where-Object { $_ -and $_.requestedPort -eq $port }) | Select-Object -First 1
                if ($fixed) {
                    $fixedCode = $fixed.listen.code
                    if ($fixed.listen.listening) { $fixedCode = (@($fixed.tcp.code, $fixed.fetch.code) | Where-Object { $_ } | Select-Object -First 1) }
                    $facts.fixedPort = @{ listenOk = [bool]$fixed.listen.listening; connectOk = [bool]$fixed.ok; code = $fixedCode }
                    $digest.Add(('LobsterAI 运行时在端口 {0} 新建监听并连接：{1}' -f $port, $(if ($fixed.ok) { '通过' } else { '失败 ' + $fixedCode })))
                }
                $proxyNames = @($probe.runtime.proxyEnvironment.PSObject.Properties | ForEach-Object { $_.Name })
                if ($proxyNames.Count -gt 0) { $digest.Add(('LobsterAI 运行时看到的代理/Node 变量：' + (@($probe.runtime.proxyEnvironment.PSObject.Properties | ForEach-Object { $_.Name + '=' + $_.Value }) -join '；'))) }
            } else {
                $digest.Add(('LobsterAI 运行时测试没有产出结果（退出码 {0}，超时 {1}），见 connection.json 的 probeProcess。' -f $probeRun.exitCode, $probeRun.timedOut))
            }
        }
        # The app stops the gateway when its own startup wait runs out; results after that are not comparable.
        if ($gateway) {
            $stillListening = @(Get-TcpTable -ListenOnly | Where-Object { $_.localPort -eq $port -and $_.pid -eq $gateway.pid }).Count -gt 0
            $facts.gatewayLostDuringTests = -not $stillListening
            $connection.gatewayStillListeningAfterTests = $stillListening
        }
    } catch { Record-CollectionError 'connection' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'connection.json') $connection

    # ------------------------------------------------------------------ 4
    Write-Host '[4/7] 代理、端口保留与网络组件'
    $network = [ordered]@{}
    try {
        $names = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE')
        $network.environment = [ordered]@{}
        $setNames = @()
        foreach ($scope in @('Process', 'User', 'Machine')) {
            $values = [ordered]@{}
            foreach ($name in $names) {
                $value = [Environment]::GetEnvironmentVariable($name, $scope)
                if ($value) { $values[$name] = Hide-UserInfo $value; if ($name -ne 'NO_PROXY') { $setNames += ($name + '(' + $scope + ')') } }
            }
            $network.environment[$scope] = $values
        }
        $facts.envProxy = $setNames
        try {
            $internet = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
            $network.wininet = [ordered]@{ proxyEnable = $internet.ProxyEnable; proxyServer = (Hide-UserInfo ([string]$internet.ProxyServer)); proxyOverride = [string]$internet.ProxyOverride; autoConfigUrl = [string]$internet.AutoConfigURL }
            $digest.Add(('系统代理（WinINet）：启用={0} 服务器={1} PAC={2}' -f $internet.ProxyEnable, $network.wininet.proxyServer, $network.wininet.autoConfigUrl))
        } catch { Record-CollectionError 'wininet proxy' $_ }

        $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
        $commands = [ordered]@{
            'winhttp-proxy' = @('winhttp', 'show', 'proxy')
            'portproxy' = @('interface', 'portproxy', 'show', 'all')
            'excluded-ports-ipv4' = @('int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp')
            'excluded-ports-ipv6' = @('int', 'ipv6', 'show', 'excludedportrange', 'protocol=tcp')
            'dynamic-ports-ipv4' = @('int', 'ipv4', 'show', 'dynamicport', 'tcp')
            'winsock-catalog' = @('winsock', 'show', 'catalog')
        }
        $outputs = @{}
        foreach ($key in $commands.Keys) {
            $run = Invoke-CapturedProcess -FilePath $netsh -Arguments $commands[$key] -TimeoutSeconds 30
            $outputs[$key] = $run.stdout + $run.stderr
            Write-ReportText ('netsh-' + $key + '.txt') $outputs[$key]
        }
        $excluded = @(Get-PortRanges $outputs['excluded-ports-ipv4'])
        $network.excludedPortRanges = $excluded
        $facts.excludedRangeHit = Test-PortInRanges $facts.gatewayPort $excluded
        $dynamic = Get-DynamicPortRange $outputs['dynamic-ports-ipv4']
        $network.dynamicPortRange = $dynamic
        $portProxyLines = @(($outputs['portproxy'] -split '\r?\n') | Where-Object { $_ -match '\d+\.\d+\.\d+\.\d+|\*' -and $_ -match '\s\d{2,5}\s' })
        $facts.portProxyHit = @($portProxyLines | Where-Object { $_ -match ('\b' + $facts.gatewayPort + '\b') }).Count -gt 0
        $digest.Add(('端口设置：保留范围 {0} 段，引擎端口在保留范围内：{1}；动态端口 {2}-{3}；portproxy 规则 {4} 条' -f $excluded.Count, $facts.excludedRangeHit, $dynamic.start, $dynamic.end, $portProxyLines.Count))
        $winsockPaths = @(Get-WinsockProviderPaths $outputs['winsock-catalog'])
        $network.winsockProviders = $winsockPaths
        $thirdPartyWinsock = @(Get-ThirdPartyWinsockProviders $winsockPaths)
        $network.thirdPartyWinsockProviders = $thirdPartyWinsock
        $digest.Add(('Winsock 提供程序 {0} 个，第三方：{1}' -f $winsockPaths.Count, (Join-OrNone $thirdPartyWinsock '；')))
        $digest.Add(('WinHTTP 代理：' + (($outputs['winhttp-proxy'] -split '\r?\n' | Where-Object { $_ -match '\S' } | Select-Object -Last 2) -join ' ').Trim()))

        try {
            $network.adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | ForEach-Object { [ordered]@{ name = $_.Name; description = $_.InterfaceDescription; status = [string]$_.Status; hidden = [bool]$_.Hidden; driverProvider = $_.DriverProvider } })
            $virtualAdapters = @($network.adapters | Where-Object { $_.status -eq 'Up' -and (($_.description + ' ' + $_.driverProvider) -match $NetworkPattern -or $_.description -match '(?i)TAP|TUN|Virtual') })
            if ($virtualAdapters.Count) { $digest.Add(('已启用的虚拟/VPN 网卡：' + ((@($virtualAdapters | ForEach-Object { $_.name + '（' + $_.description + '）' })) -join '；'))) }
        } catch { Record-CollectionError 'adapters' $_ }
        try {
            # Network filter drivers bound to adapters (NDIS LWF from VPN or security products).
            $network.thirdPartyBindings = @(Get-NetAdapterBinding -IncludeHidden -AllBindings -ErrorAction Stop | Where-Object { $_.Enabled -and $_.ComponentID -notmatch '^ms_' } | ForEach-Object { [ordered]@{ adapter = $_.Name; component = $_.ComponentID; displayName = $_.DisplayName } })
            $bindingNames = @($network.thirdPartyBindings | ForEach-Object { $_.displayName } | Select-Object -Unique)
            if ($bindingNames.Count) { $digest.Add(('第三方网络过滤组件：' + ($bindingNames -join '；'))) }
        } catch { Record-CollectionError 'adapter bindings' $_ }
        try {
            $network.loopbackRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.DestinationPrefix -like '127.*' } | ForEach-Object { [ordered]@{ prefix = $_.DestinationPrefix; alias = $_.InterfaceAlias; nextHop = $_.NextHop; metric = $_.RouteMetric } })
            if ($network.loopbackRoutes.Count -eq 0) { $digest.Add('注意：路由表里没有 127.0.0.0/8 回环路由。') }
        } catch { Record-CollectionError 'loopback routes' $_ }
        try {
            Write-Host '    读取防火墙规则（规则多时需要几十秒）…'
            $network.firewallProfiles = @(Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object { [ordered]@{ name = $_.Name; enabled = [string]$_.Enabled; defaultInbound = [string]$_.DefaultInboundAction; defaultOutbound = [string]$_.DefaultOutboundAction } })
            $rules = @()
            foreach ($filter in @(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -match '(?i)LobsterAI' })) {
                foreach ($rule in @($filter | Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
                    $rules += [ordered]@{ name = $rule.DisplayName; direction = [string]$rule.Direction; action = [string]$rule.Action; enabled = [string]$rule.Enabled; profile = [string]$rule.Profile; program = $filter.Program }
                }
            }
            $network.lobsterFirewallRules = $rules
            $digest.Add(('Windows 防火墙：{0}；LobsterAI 相关规则 {1} 条（阻止 {2} 条）' -f ((@($network.firewallProfiles | ForEach-Object { $_.name + '=' + $_.enabled })) -join '，'), $rules.Count, @($rules | Where-Object { $_.action -eq 'Block' }).Count))
        } catch { Record-CollectionError 'firewall' $_ }
        try {
            $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
            $entries = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' } | ForEach-Object { $_.Trim() })
            # Other host names can be private; only loopback-related lines are exported.
            $network.hosts = [ordered]@{ entries = $entries.Count; loopbackRelated = @($entries | Where-Object { $_ -match '(?i)\blocalhost\b|127\.0\.0\.1|::1' } | Select-Object -First 20) }
        } catch { Record-CollectionError 'hosts' $_ }
    } catch { Record-CollectionError 'network' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'network.json') $network

    # ------------------------------------------------------------------ 5
    Write-Host '[5/7] 安全软件、驱动、服务与启动项'
    $software = [ordered]@{}
    try {
        $software.antivirus = @(Get-CimSafe -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct | ForEach-Object { [ordered]@{ name = $_.displayName; productStateHex = ('{0:X6}' -f [int]$_.productState); path = $_.pathToSignedProductExe } })
        $software.firewallProducts = @(Get-CimSafe -Namespace 'root/SecurityCenter2' -ClassName FirewallProduct | ForEach-Object { [ordered]@{ name = $_.displayName; productStateHex = ('{0:X6}' -f [int]$_.productState) } })
        try {
            $mp = Get-MpComputerStatus -ErrorAction Stop
            $software.defender = [ordered]@{ runningMode = [string]$mp.AMRunningMode; realTimeProtection = $mp.RealTimeProtectionEnabled; networkInspection = $mp.NISEnabled; antivirusEnabled = $mp.AntivirusEnabled }
        } catch { Record-CollectionError 'defender status' $_ }
        $digest.Add(('安全软件（系统登记）：{0}；防火墙产品：{1}；Defender 实时防护：{2}' -f (Join-OrNone @($software.antivirus | ForEach-Object { $_.name })), (Join-OrNone @($software.firewallProducts | ForEach-Object { $_.name })), (Format-Known $software.defender.realTimeProtection)))

        $software.installedPrograms = @($installed | Sort-Object DisplayName | ForEach-Object { [ordered]@{ name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher; installDate = $_.InstallDate } })
        $matchingPrograms = @($installed | Where-Object { $_.DisplayName -match $SecurityPattern -or $_.DisplayName -match $NetworkPattern } | ForEach-Object { $_.DisplayName } | Select-Object -Unique)
        if ($matchingPrograms.Count) { $digest.Add(('已安装的安全/网络相关软件：' + ($matchingPrograms -join '、'))) }

        # Names and publishers only; command lines can carry tokens and are not exported.
        $software.processes = @($processTable.Values | Group-Object name | Sort-Object Name | ForEach-Object {
            $first = $_.Group[0]
            [ordered]@{ name = $_.Name; count = $_.Count; company = (Get-FileCompany $first.path) }
        })
        $matchingProcesses = @($software.processes | Where-Object { $_.name -match $SecurityPattern -or $_.name -match $NetworkPattern -or $_.company -match $SecurityPattern } | ForEach-Object { $_.name })
        if ($matchingProcesses.Count) { $digest.Add(('正在运行的安全/网络相关进程：' + ($matchingProcesses -join '、'))) }

        $software.thirdPartyServices = @(Get-CimSafe Win32_Service -Filter "State = 'Running'" | ForEach-Object {
            $binary = Get-ExecutableFromCommandLine ([string]$_.PathName)
            $company = Get-FileCompany $binary
            if ($company -notmatch '(?i)^Microsoft') { [ordered]@{ name = $_.Name; displayName = $_.DisplayName; startMode = $_.StartMode; binary = $binary; company = $company } }
        })
        $software.thirdPartyDrivers = @(Get-CimSafe Win32_SystemDriver -Filter "State = 'Running'" | ForEach-Object {
            $binary = Resolve-SystemPath ([string]$_.PathName)
            $company = Get-FileCompany $binary
            if ($company -notmatch '(?i)^Microsoft') { [ordered]@{ name = $_.Name; displayName = $_.DisplayName; path = $binary; company = $company } }
        })
        $digest.Add(('第三方服务（运行中）' + (Format-CimCount 'Win32_Service' $software.thirdPartyServices { $_.name })))
        $digest.Add(('第三方驱动（运行中）' + (Format-CimCount 'Win32_SystemDriver' $software.thirdPartyDrivers { $_.name + '(' + $_.company + ')' })))

        try {
            $software.scheduledTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -notlike '\Microsoft\*' } | ForEach-Object {
                $task = $_
                $actions = @($task.Actions | ForEach-Object { ((([string]$_.Execute) + ' ' + ([string]$_.Arguments)).Trim()) })
                [ordered]@{ name = $task.TaskName; path = $task.TaskPath; state = [string]$task.State; actions = @($actions | ForEach-Object { Protect-DiagnosticText $_ }) }
            })
            $matchingTasks = @($software.scheduledTasks | Where-Object { ($_.name + ' ' + ($_.actions -join ' ')) -match $NetworkPattern -or ($_.name + ' ' + ($_.actions -join ' ')) -match $SecurityPattern } | ForEach-Object { $_.path + $_.name })
            if ($matchingTasks.Count) { $digest.Add(('相关计划任务：' + ($matchingTasks -join '、'))) }
        } catch { Record-CollectionError 'scheduled tasks' $_ }
        $autoruns = @()
        foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')) {
            try {
                $item = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
                foreach ($property in $item.PSObject.Properties) {
                    if ($property.Name -like 'PS*') { continue }
                    $autoruns += [ordered]@{ key = $key; name = $property.Name; command = (Protect-DiagnosticText ([string]$property.Value)) }
                }
            } catch { }
        }
        foreach ($folder in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
            if ($folder -and (Test-Path -LiteralPath $folder)) { foreach ($file in @(Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue)) { $autoruns += [ordered]@{ key = 'StartupFolder'; name = $file.Name; command = $null } } }
        }
        $software.autoruns = $autoruns
        $digest.Add(('开机启动项：' + (Join-OrNone @($autoruns | ForEach-Object { $_.name }))))

        # DLLs injected into LobsterAI (hooks, Winsock LSPs) show up as non-Microsoft modules outside the install folder.
        if ($AppPath) {
            $installDir = Split-Path $AppPath
            $software.lobsterModules = @()
            foreach ($process in @(Get-LobsterProcesses | Where-Object { $_.role -in @('main', 'gateway') })) {
                try {
                    $modules = @(Get-ThirdPartyModules $process.pid $installDir)
                    $software.lobsterModules += [ordered]@{ pid = $process.pid; role = $process.role; modules = $modules }
                    if ($modules.Count) { $digest.Add(('LobsterAI {0} 进程中的第三方模块：{1}' -f $process.role, ((@($modules | ForEach-Object { [IO.Path]::GetFileName($_.path) + '(' + $_.company + ')' })) -join '、'))) }
                } catch { Record-CollectionError ('modules:' + $process.pid) $_ }
            }
        }
    } catch { Record-CollectionError 'software' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'software.json') $software

    # ------------------------------------------------------------------ 6
    Write-Host '[6/7] 日志、引擎配置与系统事件'
    $logIndex = @()
    try {
        foreach ($log in @(Get-ChildItem -LiteralPath (Join-Path $userData 'logs') -Filter 'main-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
            $logIndex += Copy-LogTail $log.FullName $log.Name 8388608
        }
        $coworkLog = Join-Path $userData 'logs\cowork.log'
        if (Test-Path -LiteralPath $coworkLog) { $logIndex += Copy-LogTail $coworkLog 'cowork.log' 2097152 }
        foreach ($log in @(Get-ChildItem -LiteralPath (Join-Path $openclawBase 'logs') -Filter 'gateway-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
            $logIndex += Copy-LogTail $log.FullName $log.Name 4194304
        }
        $dailyRoots = @((Join-Path $env:TEMP 'openclaw'))
        if ($AppPath) { $dailyRoots += Join-Path ([IO.Path]::GetPathRoot($AppPath)) 'tmp\openclaw' }
        $number = 0
        foreach ($root in ($dailyRoots | Select-Object -Unique)) {
            foreach ($log in @(Get-ChildItem -LiteralPath $root -Filter 'openclaw-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
                $number++
                $logIndex += Copy-LogTail $log.FullName ('openclaw-' + $number + '-' + $log.Name) 8388608
            }
        }
        foreach ($timing in @((Join-Path $userData 'install-timing.log'), (Join-Path $env:ProgramData 'LobsterAI\install-timing.log'))) {
            if (Test-Path -LiteralPath $timing) { $logIndex += Copy-LogTail $timing ('install-timing-' + $(if ($timing.StartsWith($env:ProgramData)) { 'programdata' } else { 'user' }) + '.log') 1048576 }
        }
        $newestMain = @(Get-ChildItem -LiteralPath (Join-Path $userData 'logs') -Filter 'main-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
        if ($newestMain.Count) {
            $timeline = Get-GatewayStartupTimeline (Read-DiagnosticTail $newestMain[0].FullName 4194304)
            $facts.timeline = $timeline
            $summary.appLogTimeline = $timeline
            $digest.Add(('应用日志（最近一次启动 {0}）：引擎启动 {1} 次，引擎自报就绪 {2} 次（首次 {3}），LobsterAI 确认就绪 {4} 次，等待超时 {5} 次；未就绪探测 {6} 条：{7}' -f $timeline.startedAt, $timeline.gatewaySpawns, $timeline.gatewaySelfReady, $timeline.firstSelfReadyAt, $timeline.readyConfirmed, $timeline.waitTimeouts, $timeline.probeNotReady, (Format-Counts $timeline.probeDetails)))
        }
    } catch { Record-CollectionError 'logs' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'log-index.json') @($logIndex | Where-Object { $_ })

    $engine = [ordered]@{}
    try {
        $configPath = Join-Path $stateDir 'openclaw.json'
        $engine.config = [ordered]@{ exists = (Test-Path -LiteralPath $configPath) }
        if ($engine.config.exists) {
            $raw = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
            $engine.config.bytes = $raw.Length
            try {
                # Only the gateway section: it decides where the engine listens.
                $engine.config.gateway = ConvertTo-RedactedObject (($raw | ConvertFrom-Json).gateway)
            } catch {
                $engine.config.parseError = Protect-DiagnosticText ([string]$_)
                foreach ($name in @('bind', 'customBindHost', 'port')) { if ($raw -match ('"' + $name + '"\s*:\s*("[^"]*"|\d+)')) { $engine.config[$name] = $Matches[1] } }
            }
        }
        $portFile = Join-Path $stateDir 'gateway-port.json'
        if (Test-Path -LiteralPath $portFile) { $engine.gatewayPortFile = Protect-DiagnosticText ([IO.File]::ReadAllText($portFile)) }
        $engine.lockFiles = @(Get-ChildItem -LiteralPath (Join-Path $stateDir 'tmp') -Recurse -File -Filter 'gateway*' -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object {
            $content = $null
            if ($_.Length -le 4096 -and $_.Extension -eq '.lock') { try { $content = Protect-DiagnosticText ([IO.File]::ReadAllText($_.FullName)) } catch { $content = 'unreadable' } }
            [ordered]@{ name = $_.FullName.Substring($stateDir.Length).TrimStart('\'); bytes = $_.Length; modified = $_.LastWriteTime.ToString('o'); content = $content }
        })
        $bind = $null
        if ($engine.config.gateway) { $bind = $engine.config.gateway.bind }
        $digest.Add(('引擎配置：gateway.bind={0}；gateway-port.json={1}；锁文件 {2} 个' -f $(if ($bind) { $bind } else { '未设置（默认 loopback）' }), $persistedPort, $engine.lockFiles.Count))
    } catch { Record-CollectionError 'engine config' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'engine.json') $engine

    $events = [ordered]@{}
    try {
        $since = (Get-Date).AddDays(-14)
        # Boot, shutdown and unexpected-shutdown records line up reboots with the app logs.
        $events.bootAndShutdown = Get-EventExcerpt @{ LogName = 'System'; StartTime = $since; Id = 12, 13, 41, 109, 1074, 6005, 6006, 6008 } '.' 200 60
        $events.lobsterCrashes = Get-EventExcerpt @{ LogName = 'Application'; StartTime = $since; Id = 1000, 1001, 1002 } '(?i)LobsterAI' 300 20
        # 6005 (event log service started) marks each boot.
        $boots = @($events.bootAndShutdown.events | Where-Object { $_.id -eq 6005 } | Select-Object -First 5 | ForEach-Object { $_.time.Substring(0, 16).Replace('T', ' ') })
        $digest.Add(('最近开机时间：' + (Join-OrNone $boots)))
    } catch { Record-CollectionError 'events' $_ }
    Write-DiagnosticJson (Join-Path $reportDir 'events.json') $events
} catch {
    Record-CollectionError 'collector' $_
    Write-Host '部分项目未能完成，将把已收集的信息一起打包。' -ForegroundColor Yellow
} finally {
    Write-Host '[7/7] 生成诊断包'
    $summary.finishedAt = (Get-Date).ToString('o')
    $summary.partial = $errors.Count -gt 0
    $verdict = @()
    try { $verdict = @(Get-ConnectionVerdict $facts) } catch { Record-CollectionError 'verdict' $_ }
    $summary.verdict = $verdict
    try {
        Write-DiagnosticJson (Join-Path $reportDir 'collection-errors.json') @($errors.ToArray())
        Write-DiagnosticJson (Join-Path $reportDir 'summary.json') $summary
        $header = @(
            'LobsterAI 引擎连接诊断摘要',
            ('采集时间：' + $summary.startedAt + ' ~ ' + $summary.finishedAt),
            '',
            '初步判断：'
        )
        $body = @($verdict | ForEach-Object { '- ' + $_ }) + @('', '采集结果：') + @($digest.ToArray() | ForEach-Object { '- ' + $_ })
        $footer = @('', ('收集过程中的错误：' + $errors.Count + ' 项，见 collection-errors.json'), '详细数据见同目录的 JSON 和 netsh-*.txt；logs 目录是应用和引擎日志（已去除密钥和令牌）。')
        Write-ReportText 'summary.txt' (($header + $body + $footer) -join "`r`n")
    } catch { Write-Host ('写入摘要失败：' + $_) -ForegroundColor Yellow }
    if (-not $OutputDirectory) { $OutputDirectory = [Environment]::GetFolderPath('Desktop') }
    if (-not $OutputDirectory) { $OutputDirectory = [IO.Path]::GetTempPath() }
    [void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
    $zipPath = Join-Path $OutputDirectory ('LobsterAI-Connection-Diagnostics-' + $runId + '.zip')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($reportDir, $zipPath)
    # The cleanup boundary is the private directory created at the start of this run.
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ''
    if ($verdict.Count) { Write-Host ('初步判断：' + $verdict[0]) -ForegroundColor Yellow }
    Write-Host '诊断完成，请把下面的 ZIP 文件发给技术支持：' -ForegroundColor Green
    Write-Host $zipPath -ForegroundColor Cyan
    # The path is already on screen; failing to open Explorer is not an error.
    try { Start-Process explorer.exe -ArgumentList ('/select,"' + $zipPath + '"') } catch { }
}
