# Execute with Windows PowerShell 5.1 or pwsh. Only the collector's pure and
# socket helpers are loaded (through the AST); the collection itself never runs.
$ErrorActionPreference = 'Stop'
$toolDirectory = Join-Path $PSScriptRoot '..\scripts\support\windows-gateway-diagnostics'
. (Join-Path $toolDirectory 'diagnostic-common.ps1')
function Assert-Condition { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }
# pwsh on macOS or Linux has no SystemRoot; the path helpers only need the value.
if (-not $env:SystemRoot) { $env:SystemRoot = 'C:\Windows' }

$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $toolDirectory 'collect-connection.ps1'), [ref]$tokens, [ref]$parseErrors)
Assert-Condition ($parseErrors.Count -eq 0) ('collect-connection.ps1 does not parse: ' + ($parseErrors -join '; '))
$helpers = @(
    'ConvertTo-ProcessArgument', 'Invoke-CapturedProcess', 'Get-LobsterProcessRole', 'Get-GatewayPortFromCommandLine',
    'Get-SocketException', 'Set-SocketFailure', 'Test-TcpConnect', 'Test-RawHttpGet', 'Test-LoopbackSelf', 'Get-CurlMeaning',
    'Get-PortRanges', 'Test-PortInRanges', 'Get-DynamicPortRange', 'Get-WinsockProviderPaths', 'Get-ProbeDetailKind',
    'Get-GatewayStartupTimeline', 'Format-Counts', 'Format-ErrorCodes', 'Get-ConnectionVerdict', 'ConvertTo-RedactedObject',
    'Resolve-SystemPath', 'Get-ExecutableFromCommandLine', 'Hide-UserInfo', 'Get-ThirdPartyWinsockProviders', 'Join-OrNone', 'Format-Known',
    'ConvertFrom-ConsoleBytes', 'Format-CimCount'
)
# The Winsock allowlist is script data the helpers read.
$allowlist = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$StandardWinsockProviders' }, $true)
. ([ScriptBlock]::Create($allowlist.Extent.Text))
$sources = @{}
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($helpers -contains $function.Name) {
        $sources[$function.Name] = $function.Extent.Text
        . ([ScriptBlock]::Create($function.Extent.Text))
    }
}
foreach ($name in $helpers) { Assert-Condition ([bool](Get-Command $name -ErrorAction SilentlyContinue)) ('Missing helper: ' + $name) }

# Process roles come from command lines, which carry the gateway token and are never exported.
$gatewayLine = '"C:\Program Files\LobsterAI\LobsterAI.exe" "C:\Program Files\LobsterAI\resources\cfmind\gateway-launcher.cjs" gateway --port 18790 --token secret-token'
Assert-Condition ((Get-LobsterProcessRole $gatewayLine) -eq 'gateway') 'Gateway role was not recognized.'
Assert-Condition ((Get-GatewayPortFromCommandLine $gatewayLine) -eq 18790) 'Gateway port was not parsed.'
Assert-Condition ((Get-LobsterProcessRole '"C:\Program Files\LobsterAI\LobsterAI.exe" --type=renderer --lang=zh-CN') -eq 'renderer') 'Renderer role was not recognized.'
# Seen on a customer machine (2026-10-09): no gateway-launcher in the gateway's command line.
$cliGateway = '"C:\Program Files\LobsterAI\LobsterAI.exe" "C:\Program Files\LobsterAI\resources\cfmind\openclaw.mjs" gateway --port 18789 --token secret-token'
Assert-Condition ((Get-LobsterProcessRole $cliGateway) -eq 'gateway' -and (Get-GatewayPortFromCommandLine $cliGateway) -eq 18789) 'An openclaw.mjs gateway was not recognized.'
Assert-Condition ((Get-LobsterProcessRole '"C:\Program Files\LobsterAI\LobsterAI.exe" "C:\Program Files\LobsterAI\resources\cfmind\openclaw.mjs" config validate --json') -eq 'openclaw-cli') 'An OpenClaw CLI call was taken for the gateway.'
Assert-Condition ((Get-LobsterProcessRole '"C:\Program Files\LobsterAI\LobsterAI.exe" "C:\Users\a\AppData\Roaming\LobsterAI\SKILLs\web-search\server.js"') -eq 'node-helper') 'Skill server role was not recognized.'
Assert-Condition ((Get-LobsterProcessRole '"C:\Program Files\LobsterAI\LobsterAI.exe"') -eq 'main') 'Main role was not recognized.'
Assert-Condition ($null -eq (Get-GatewayPortFromCommandLine '"C:\Program Files\LobsterAI\LobsterAI.exe"')) 'A port was invented.'
Assert-Condition ((ConvertTo-ProcessArgument 'protocol=tcp') -eq 'protocol=tcp') 'A plain argument was quoted.'
Assert-Condition ((ConvertTo-ProcessArgument 'HTTP_CODE=%{http_code}') -eq 'HTTP_CODE=%{http_code}') 'The curl format was quoted.'
Assert-Condition ((ConvertTo-ProcessArgument 'C:\Program Files\x.cjs') -eq '"C:\Program Files\x.cjs"') 'A path with spaces was not quoted.'
Assert-Condition ((Hide-UserInfo 'http://user:pass@127.0.0.1:7890') -eq 'http://<USERINFO>@127.0.0.1:7890') 'Proxy credentials were kept.'
Assert-Condition ((Get-CurlMeaning 7) -match '无法连接') 'curl exit code 7 was not explained.'
Assert-Condition ((Get-CurlMeaning 56) -match '重置') 'curl exit code 56 was not explained.'

$excludedEnglish = @'

Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     18700       18799     *
     50000       50059     *

* - Administered port exclusions.

'@
$ranges = @(Get-PortRanges $excludedEnglish)
Assert-Condition ($ranges.Count -eq 3) 'Excluded port ranges were not parsed.'
Assert-Condition ((Test-PortInRanges 18789 $ranges) -and -not (Test-PortInRanges 18800 $ranges)) 'Port range membership is wrong.'
Assert-Condition ($ranges[1].administered -and -not $ranges[0].administered) 'Administered ranges were not marked.'
$excludedChinese = "协议 tcp 端口排除范围`r`n`r`n开始端口    结束端口`r`n----------    --------`r`n      1080        1179`r`n`r`n* - 管理的端口排除。`r`n"
Assert-Condition (-not (Test-PortInRanges 18789 (Get-PortRanges $excludedChinese))) 'A localized range was misread.'
$dynamic = Get-DynamicPortRange "协议 tcp 动态端口范围`r`n---------------------------------`r`n启动端口        : 49152`r`n端口数          : 16384`r`n"
Assert-Condition ($dynamic.start -eq 49152 -and $dynamic.end -eq 65535) 'The dynamic port range was not parsed.'
$catalog = "Winsock 目录提供程序条目`r`n提供程序路径:                      %SystemRoot%\system32\mswsock.dll`r`n提供程序路径:                      C:\Program Files (x86)\Example\nf_lsp.dll`r`n提供程序路径:                      %SystemRoot%\system32\mswsock.dll`r`n"
$providers = @(Get-WinsockProviderPaths $catalog)
Assert-Condition ($providers.Count -eq 2 -and $providers[1] -eq 'C:\Program Files (x86)\Example\nf_lsp.dll') 'Winsock providers were not extracted.'
$thirdParty = @(Get-ThirdPartyWinsockProviders $providers)
Assert-Condition ($thirdParty.Count -eq 1 -and $thirdParty[0] -like '*nf_lsp.dll') ('Third-party Winsock providers: ' + ($thirdParty -join '; '))
Assert-Condition (@(Get-ThirdPartyWinsockProviders @('%SystemRoot%\system32\nlasvc.dll')).Count -eq 0) 'The NLA namespace provider was reported as third-party.'
# Windows 11 netsh wrote UTF-8 into a GBK console; both must decode.
Assert-Condition ((ConvertFrom-ConsoleBytes ([Text.Encoding]::UTF8.GetBytes('当前的 WinHTTP 代理服务器设置'))) -eq '当前的 WinHTTP 代理服务器设置') 'UTF-8 console output was not decoded.'
Assert-Condition ((ConvertFrom-ConsoleBytes ([byte[]](0xB5, 0xB1))) -ne $null) 'Non-UTF-8 console output was dropped.'
$script:cimFailures = @{ Win32_SystemDriver = $true }
Assert-Condition ((Format-CimCount 'Win32_SystemDriver' @() { $_.name }) -match '读取失败') 'A failed WMI query was shown as zero items.'
Assert-Condition ((Format-CimCount 'Win32_Service' @([pscustomobject]@{ name = 'qmbsrv' }) { $_.name }) -eq '1 个：qmbsrv') 'A WMI count was misformatted.'
Assert-Condition ((Join-OrNone @()) -eq '无' -and (Join-OrNone @('a', $null, '', 'b')) -eq 'a、b') 'Empty lists are not shown as 无.'
Assert-Condition ((Format-Known $null) -eq '未知' -and (Format-Known 0) -eq '0' -and (Format-Known $false) -eq 'False') 'Unknown values are not shown as 未知.'
Assert-Condition ((Resolve-SystemPath '\SystemRoot\System32\drivers\tcpip.sys') -like '*System32\drivers\tcpip.sys') 'A kernel path was not resolved.'
Assert-Condition ((Get-ExecutableFromCommandLine '"C:\Program Files\Vendor\svc.exe" -k run') -eq 'C:\Program Files\Vendor\svc.exe') 'A quoted service binary was not found.'
Assert-Condition ((Get-ExecutableFromCommandLine 'C:\Vendor Tools\svc.exe /service') -eq 'C:\Vendor Tools\svc.exe') 'An unquoted service binary was not found.'

# Lines as LobsterAI 2026.9.23 writes them (a reboot, then two startup waits that never connect).
$mainLog = @'
[2026-10-08 22:55:58.906] [info]  LobsterAI started (win32 x64)
[2026-10-08 22:56:14.351] [info]  [OpenClaw] gateway process spawned (8545ms), pid=9696
[2026-10-08 22:56:55.457] [info]  [OpenClaw] startup milestone (41111ms since spawn): 2026-10-08T22:56:55.447+08:00 [gateway] ready
[2026-10-08 22:56:55.598] [info]  [OpenClaw] waitForGatewayReady: gateway startup complete after 40969ms (41 polls)
[2026-10-08 23:15:25.741] [info]  LobsterAI started (win32 x64)
[2026-10-08 23:15:37.762] [info]  [OpenClaw] gateway process spawned (10353ms), pid=12504
[2026-10-08 23:15:43.245] [info]  [OpenClaw] startup probe details: /startupz → fetch failed
[2026-10-08 23:15:55.546] [info]  [OpenClaw] startup milestone (17790ms since spawn): 2026-10-08T23:15:55.547+08:00 [gateway] ready
[2026-10-08 23:15:55.546] [info]  [OpenClaw stdout] 2026-10-08T23:15:55.547+08:00 [gateway] ready
[2026-10-08 23:15:59.450] [info]  [OpenClaw] startup probe details: /startupz → fetch failed
[2026-10-08 23:16:08.634] [info]  [OpenClaw] startup probe details: /startupz → This operation was aborted
[2026-10-08 23:20:38.365] [info]  [OpenClaw] waitForGatewayReady: timed out after 300000ms (333 polls)
[2026-10-08 23:20:46.000] [info]  [OpenClaw] gateway process spawned (8000ms), pid=11576
[2026-10-08 23:21:08.074] [info]  [OpenClaw] startup probe details: /startupz → HTTP 503, status=starting
[2026-10-08 23:25:47.011] [info]  [OpenClaw] waitForGatewayReady: timed out after 300000ms (334 polls)
[2026-10-08 23:25:47.223] [info]  [ChannelSync] ensureGatewayClientReady: engine phase= error message= OpenClaw gateway failed to become healthy in time.
'@
$timeline = Get-GatewayStartupTimeline $mainLog
Assert-Condition ($timeline.startedAt -eq '2026-10-08 23:15:25') 'The newest startup was not chosen.'
Assert-Condition ($timeline.gatewaySpawns -eq 2) ('Gateway spawns: ' + $timeline.gatewaySpawns)
Assert-Condition ($timeline.gatewaySelfReady -eq 1 -and $timeline.firstSelfReadyAt -eq '2026-10-08 23:15:55') 'Gateway self-ready was miscounted.'
Assert-Condition ($timeline.readyConfirmed -eq 0) 'A ready confirmation from the previous run leaked in.'
Assert-Condition ($timeline.waitTimeouts -eq 2 -and $timeline.healthFailures -eq 1) 'Timeouts were miscounted.'
Assert-Condition ($timeline.probeNotReady -eq 4) ('Probe lines: ' + $timeline.probeNotReady)
Assert-Condition ((Format-Counts $timeline.probeDetails) -eq 'fetch failed×2、timeout×1、HTTP 503×1') ('Probe kinds: ' + (Format-Counts $timeline.probeDetails))

$gatewayListener = @{ pid = 12504; name = 'LobsterAI.exe'; address = '127.0.0.1'; isGateway = $true; isLobster = $true }
$refused = [ordered]@{ ok = $false; code = 'ConnectionRefused' }
$connected = [ordered]@{ ok = $true; code = 'Connected' }
$base = @{ appRunning = $true; gatewayProcess = $true; gatewayPort = 18789; listeners = @($gatewayListener); envProxy = @() }
function New-Facts { param([hashtable]$Changes) $facts = $base.Clone(); foreach ($key in $Changes.Keys) { $facts[$key] = $Changes[$key] }; return $facts }

$verdict = @(Get-ConnectionVerdict (New-Facts @{ psTcp = @($refused, $refused); nodeGateway = @{ tcpOk = 0; tcpTotal = 3; fetchOk = 0; fetchTotal = 4; errorCodes = @('ECONNREFUSED'); startupStatus = $null } }))
Assert-Condition ($verdict[0] -match '系统层被拦截' -and $verdict[0] -match 'ConnectionRefused' -and $verdict[0] -match 'ECONNREFUSED') ('System-level block: ' + $verdict[0])
$verdict = @(Get-ConnectionVerdict (New-Facts @{ psTcp = @($connected); nodeGateway = @{ tcpOk = 0; tcpTotal = 3; fetchOk = 0; fetchTotal = 4; errorCodes = @('ECONNRESET'); startupStatus = $null } }))
Assert-Condition ($verdict[0] -match '只有 LobsterAI' -and $verdict[0] -match 'ECONNRESET') ('App-only block: ' + $verdict[0])
$verdict = @(Get-ConnectionVerdict (New-Facts @{ psTcp = @($connected); nodeGateway = @{ tcpOk = 3; tcpTotal = 3; fetchOk = 0; fetchTotal = 4; errorCodes = @('UND_ERR_SOCKET'); startupStatus = $null }; envProxy = @('NODE_USE_ENV_PROXY(User)') }))
Assert-Condition ($verdict[0] -match 'HTTP 请求失败' -and ($verdict -join ' ') -match 'NODE_USE_ENV_PROXY') ('HTTP-only failure: ' + ($verdict -join ' | '))
$verdict = @(Get-ConnectionVerdict (New-Facts @{ psTcp = @($connected); nodeGateway = @{ tcpOk = 3; tcpTotal = 3; fetchOk = 4; fetchTotal = 4; errorCodes = @(); startupStatus = 'HTTP 200 started' }; timeline = $timeline }))
Assert-Condition ($verdict[0] -match '没有复现' -and $verdict[0] -match 'HTTP 200 started' -and $verdict[0] -match '一直没探测成功') ('Not reproduced: ' + $verdict[0])
$verdict = @(Get-ConnectionVerdict (New-Facts @{ listeners = @(@{ pid = 4321; name = 'node.exe'; address = '0.0.0.0'; isGateway = $false; isLobster = $false }) }))
Assert-Condition ($verdict[0] -match '被其他程序占用' -and $verdict[0] -match 'node.exe') ('Port taken: ' + $verdict[0])
$verdict = @(Get-ConnectionVerdict (New-Facts @{ listeners = @(); gatewayProcess = $false }))
Assert-Condition ($verdict[0] -match '没有找到正在运行的引擎进程') ('No gateway: ' + $verdict[0])
$verdict = @(Get-ConnectionVerdict @{ appRunning = $false; gatewayPort = 18789; listeners = @(); psTcp = @($refused); envProxy = @(); fixedPort = @{ listenOk = $true; connectOk = $false; code = 'ECONNREFUSED' }; psSelf = [ordered]@{ ok = $false; code = 'ConnectionRefused' } })
Assert-Condition ($verdict[0] -match '没有运行') ('App closed: ' + $verdict[0])
Assert-Condition (($verdict -join ' ') -match '拦截只针对这个端口' -and ($verdict -join ' ') -match '回环自测失败') ('Self-tests were not reported: ' + ($verdict -join ' | '))
$verdict = @(Get-ConnectionVerdict (New-Facts @{ psTcp = @($refused); nodeGateway = @{ tcpOk = 0; tcpTotal = 3; fetchOk = 0; fetchTotal = 4; errorCodes = @('ECONNREFUSED') }; gatewayLostDuringTests = $true; excludedRangeHit = $true; portProxyHit = $true }))
Assert-Condition (($verdict -join ' ') -match '测试期间引擎进程退出' -and ($verdict -join ' ') -match '保留端口' -and ($verdict -join ' ') -match 'portproxy') ('Extra findings missing: ' + ($verdict -join ' | '))

$config = '{"gateway":{"mode":"local","bind":"loopback","auth":{"mode":"token","token":"abc"},"remote":{"password":"p","url":"ws://x"},"tailscale":{"mode":"off"}}}' | ConvertFrom-Json
$redacted = ConvertTo-RedactedObject $config.gateway
$json = ConvertTo-Json -InputObject $redacted -Depth 6
Assert-Condition ($redacted.bind -eq 'loopback' -and $redacted.tailscale.mode -eq 'off') 'Gateway bind settings were lost.'
Assert-Condition (-not $json.Contains('abc') -and -not $json.Contains('"p"')) ('Gateway secrets were exported: ' + $json)

# Real sockets: a free loopback port, a refused connection and a raw HTTP exchange.
$self = Test-LoopbackSelf 0 3000
Assert-Condition ($self.ok -and $self.code -eq 'Exchanged') ('Loopback self-test failed: ' + $self.code)
$closedListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$closedListener.Start(); $closedPort = ([Net.IPEndPoint]$closedListener.LocalEndpoint).Port; $closedListener.Stop()
$refusedResult = Test-TcpConnect $closedPort 3000
Assert-Condition (-not $refusedResult.ok -and $refusedResult.code -eq 'ConnectionRefused') ('Refused connect: ' + $refusedResult.code)
$server = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$server.Start()
try {
    $serverPort = ([Net.IPEndPoint]$server.LocalEndpoint).Port
    $acceptTask = $server.AcceptTcpClientAsync()
    # The client blocks on its read, so it runs in a second runspace while this one answers.
    $clientScript = (@('Get-SocketException', 'Set-SocketFailure', 'Test-RawHttpGet') | ForEach-Object { $sources[$_] }) -join "`n"
    $job = [PowerShell]::Create().AddScript($clientScript + "`nTest-RawHttpGet $serverPort '/startupz' 3000")
    $pending = $job.BeginInvoke()
    Assert-Condition ($acceptTask.Wait(5000)) 'The raw HTTP client never connected.'
    $peer = $acceptTask.Result
    $stream = $peer.GetStream()
    $buffer = New-Object byte[] 1024
    [void]$stream.Read($buffer, 0, $buffer.Length)
    $reply = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/json`r`n`r`n{`"ok`":true,`"status`":`"started`"}")
    $stream.Write($reply, 0, $reply.Length)
    $peer.Close()
    $raw = $job.EndInvoke($pending) | Select-Object -First 1
    $job.Dispose()
    Assert-Condition ($raw.ok -and $raw.statusLine -eq 'HTTP/1.1 200 OK' -and $raw.bodyPreview -match 'started') ('Raw HTTP: ' + ($raw | ConvertTo-Json -Compress))
} finally { $server.Stop() }

if ($env:OS -ne 'Windows_NT') {
    $run = Invoke-CapturedProcess -FilePath '/bin/sh' -Arguments @('-c', 'echo out; echo err 1>&2') -TimeoutSeconds 10
    Assert-Condition ($run.exitCode -eq 0 -and $run.stdout.Trim() -eq 'out' -and $run.stderr.Trim() -eq 'err') ('Captured process: ' + ($run | ConvertTo-Json -Compress))
}
$missing = Invoke-CapturedProcess -FilePath (Join-Path ([IO.Path]::GetTempPath()) 'no-such-program.exe')
Assert-Condition ($missing.missing) 'A missing program was not reported.'
Write-Host 'Connection collector helper checks passed.'
