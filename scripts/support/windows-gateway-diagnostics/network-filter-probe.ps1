param(
    [string]$OutDir
)

# Elevated half of collect-network-filters.ps1. Compatible with Windows PowerShell 5.1.
# It reads Windows Filtering Platform (WFP) state, recent drop events, drivers and
# firewall rules, then names the filters that drop connections to listening
# 127.0.0.1 ports. Read-only: the only writes are its own report files and a
# scratch folder under %SystemRoot%\Temp that it removes again.
$ErrorActionPreference = 'Stop'
$errors = New-Object 'System.Collections.Generic.List[object]'
$lines = New-Object 'System.Collections.Generic.List[string]'
$analysis = [ordered]@{ startedAt = (Get-Date).ToString('o'); elevated = $true }
$InboundLayers = @(
    'FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4', 'FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6',
    'FWPM_LAYER_INBOUND_TRANSPORT_V4', 'FWPM_LAYER_INBOUND_TRANSPORT_V6',
    'FWPM_LAYER_INBOUND_IPPACKET_V4', 'FWPM_LAYER_INBOUND_IPPACKET_V6',
    'FWPM_LAYER_ALE_AUTH_LISTEN_V4', 'FWPM_LAYER_ALE_AUTH_LISTEN_V6',
    'FWPM_LAYER_ALE_AUTH_CONNECT_V4', 'FWPM_LAYER_ALE_AUTH_CONNECT_V6',
    'FWPM_LAYER_ALE_CONNECT_REDIRECT_V4', 'FWPM_LAYER_ALE_CONNECT_REDIRECT_V6',
    'FWPM_LAYER_OUTBOUND_TRANSPORT_V4', 'FWPM_LAYER_OUTBOUND_TRANSPORT_V6',
    'FWPM_LAYER_ALE_FLOW_ESTABLISHED_V4', 'FWPM_LAYER_ALE_FLOW_ESTABLISHED_V6',
    'FWPM_LAYER_STREAM_V4', 'FWPM_LAYER_STREAM_V6'
)

function Add-ProbeError {
    param([string]$Stage, $Failure)
    $entry = [ordered]@{ stage = $Stage; error = [string]$Failure }
    if ($Failure -is [System.Management.Automation.ErrorRecord] -and $Failure.InvocationInfo) { $entry.line = $Failure.InvocationInfo.ScriptLineNumber }
    $errors.Add($entry)
}

# Console tools write UTF-8 on some Windows 11 builds and the OEM code page on others.
function ConvertFrom-ConsoleBytes {
    param([byte[]]$Bytes)
    if (-not $Bytes -or $Bytes.Length -eq 0) { return '' }
    try { return (New-Object Text.UTF8Encoding($false, $true)).GetString($Bytes) }
    catch { return [Console]::OutputEncoding.GetString($Bytes) }
}

function Invoke-Captured {
    param([string]$FilePath, [string[]]$Arguments = @(), [int]$TimeoutSeconds = 180)
    $result = [ordered]@{ command = ([IO.Path]::GetFileName($FilePath) + ' ' + ($Arguments -join ' ')); exitCode = $null; timedOut = $false; stdout = ''; stderr = '' }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    # Callers pass arguments without spaces, so no quoting is involved.
    $startInfo.Arguments = ($Arguments -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    $stdout = New-Object IO.MemoryStream
    $stderr = New-Object IO.MemoryStream
    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
    $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
    if ($process.WaitForExit($TimeoutSeconds * 1000)) { $result.exitCode = $process.ExitCode }
    else {
        $result.timedOut = $true
        try { $process.Kill() } catch { }
    }
    [void]$stdoutTask.Wait(5000)
    [void]$stderrTask.Wait(5000)
    $result.stdout = ConvertFrom-ConsoleBytes $stdout.ToArray()
    $result.stderr = ConvertFrom-ConsoleBytes $stderr.ToArray()
    $process.Dispose()
    return $result
}

function Save-Text {
    param([string]$Name, [AllowEmptyString()][string]$Text)
    [IO.File]::WriteAllText((Join-Path $OutDir $Name), $Text, (New-Object Text.UTF8Encoding($true)))
}

# A connection to a listening loopback port; when it times out, WFP records the drop.
function Test-LoopbackConnect {
    param([int]$TimeoutMs = 3000)
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $client = New-Object Net.Sockets.TcpClient
    $result = [ordered]@{ port = $port; connected = $false; at = (Get-Date).ToString('o') }
    try { $result.connected = $client.ConnectAsync('127.0.0.1', $port).Wait($TimeoutMs) }
    catch { $result.error = [string]$_.Exception.Message }
    finally { $client.Close(); $listener.Stop() }
    return $result
}

function Read-XmlDocument {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    # WFP dumps can carry control characters from binary fields; do not reject them.
    $settings = New-Object Xml.XmlReaderSettings
    $settings.CheckCharacters = $false
    $settings.DtdProcessing = [Xml.DtdProcessing]::Ignore
    $settings.XmlResolver = $null
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($Path, $settings)
    try { $document.Load($reader) } finally { $reader.Dispose() }
    return $document
}

# Records which elements a dump contains, so a parser mismatch can be fixed from the report.
function Get-XmlShape {
    param($Document)
    if ($null -eq $Document -or $null -eq $Document.DocumentElement) { return $null }
    $children = @()
    foreach ($child in @($Document.DocumentElement.ChildNodes)) {
        if ($child.NodeType -ne [Xml.XmlNodeType]::Element) { continue }
        $children += ($child.Name + '(' + @($child.ChildNodes).Count + ')')
        if ($children.Count -ge 40) { break }
    }
    return [ordered]@{ root = $Document.DocumentElement.Name; children = $children }
}

function Get-NodeText {
    param($Node, [string]$XPath)
    if ($null -eq $Node) { return $null }
    $found = $Node.SelectSingleNode($XPath)
    if ($null -eq $found) { return $null }
    return $found.InnerText.Trim()
}

function Get-NodeList {
    param($Document, [string[]]$XPaths)
    # The comma keeps the array whole: a lone XmlElement would otherwise be
    # enumerated by foreach as its child nodes.
    if ($null -eq $Document) { return , @() }
    foreach ($xpath in $XPaths) {
        $nodes = @($Document.SelectNodes($xpath))
        if ($nodes.Count -gt 0) { return , $nodes }
    }
    return , @()
}

function Test-MicrosoftOwned {
    param([string]$Key, [string]$Name)
    if ($Key -and $Key -match '^FWPM_') { return $true }
    if ($Name -and $Name -match '(?i)microsoft|windows|mpssvc|ikeext|defender|edge traversal|teredo|wfp built-in|tcp (chimney|templates)|rpc|ipsec|hyper-v|wsl|container|bfe') { return $true }
    return $false
}

function Get-WfpCatalog {
    param($State)
    $catalog = [ordered]@{ providers = @{}; subLayers = @{}; callouts = @{}; layers = @{} }
    foreach ($node in (Get-NodeList $State @('//providers/item'))) {
        $key = Get-NodeText $node 'providerKey'
        if (-not $key) { continue }
        $catalog.providers[$key] = [ordered]@{
            key = $key; name = (Get-NodeText $node 'displayData/name'); description = (Get-NodeText $node 'displayData/description')
            serviceName = (Get-NodeText $node 'serviceName'); flags = @($node.SelectNodes('flags/item') | ForEach-Object { $_.InnerText.Trim() })
        }
    }
    foreach ($node in (Get-NodeList $State @('//subLayers/item'))) {
        $key = Get-NodeText $node 'subLayerKey'
        if ($key) { $catalog.subLayers[$key] = [ordered]@{ key = $key; name = (Get-NodeText $node 'displayData/name'); providerKey = (Get-NodeText $node 'providerKey') } }
    }
    foreach ($node in (Get-NodeList $State @('//callouts/item'))) {
        $key = Get-NodeText $node 'calloutKey'
        if (-not $key) { continue }
        $flags = @($node.SelectNodes('flags/item') | ForEach-Object { $_.InnerText.Trim() })
        $catalog.callouts[$key] = [ordered]@{
            key = $key; name = (Get-NodeText $node 'displayData/name'); providerKey = (Get-NodeText $node 'providerKey')
            layer = (Get-NodeText $node 'applicableLayer'); calloutId = (Get-NodeText $node 'calloutId')
            flags = $flags; registered = (@($flags | Where-Object { $_ -match 'REGISTERED' }).Count -gt 0)
        }
    }
    foreach ($node in (Get-NodeList $State @('//layers/item/layer', '//item[layerKey and layerId and not(filterId)]'))) {
        $id = Get-NodeText $node 'layerId'
        if ($id) { $catalog.layers[$id] = Get-NodeText $node 'layerKey' }
    }
    return $catalog
}

function Get-WfpFilters {
    param($Document)
    $filters = @()
    foreach ($node in (Get-NodeList $Document @('//filters/item', '//item[filterId and layerKey]'))) {
        $calloutKey = Get-NodeText $node 'action/calloutKey'
        if (-not $calloutKey) { $calloutKey = Get-NodeText $node 'action/filterType' }
        $conditions = @($node.SelectNodes('filterCondition/item') | ForEach-Object {
            $field = Get-NodeText $_ 'fieldKey'
            $value = Get-NodeText $_ 'conditionValue'
            if ($value -and $value.Length -gt 80) { $value = $value.Substring(0, 80) + '…' }
            ($field + ' ' + (Get-NodeText $_ 'matchType') + ' ' + $value).Trim()
        })
        $filters += [pscustomobject]@{
            filterId = (Get-NodeText $node 'filterId'); key = (Get-NodeText $node 'filterKey'); name = (Get-NodeText $node 'displayData/name')
            providerKey = (Get-NodeText $node 'providerKey'); layer = (Get-NodeText $node 'layerKey'); subLayer = (Get-NodeText $node 'subLayerKey')
            action = (Get-NodeText $node 'action/type'); calloutKey = $calloutKey
            flags = @($node.SelectNodes('flags/item') | ForEach-Object { $_.InnerText.Trim() }); conditions = $conditions
        }
    }
    return $filters
}

function Get-WfpNetEvents {
    param($Document)
    $events = @()
    foreach ($node in (Get-NodeList $Document @('//netEvents/item', '//item[header]'))) {
        $text = $node.InnerXml
        $isLoopbackFlag = Get-NodeText $node './/isLoopback'
        $events += [pscustomobject]@{
            time = (Get-NodeText $node 'header/timeStamp'); type = (Get-NodeText $node 'type')
            filterId = (Get-NodeText $node './/filterId'); layerId = (Get-NodeText $node './/layerId')
            localAddress = (Get-NodeText $node 'header/localAddrV4'); remoteAddress = (Get-NodeText $node 'header/remoteAddrV4')
            localPort = (Get-NodeText $node 'header/localPort'); remotePort = (Get-NodeText $node 'header/remotePort')
            protocol = (Get-NodeText $node 'header/ipProtocol'); app = (Get-NodeText $node 'header/appId/asString')
            # Whether the stack itself flagged the connection as loopback; firewall loopback exemptions key on it.
            loopbackFlag = $isLoopbackFlag
            loopback = (($isLoopbackFlag -match '(?i)^(true|1)$') -or ($text -match '127\.0\.0\.1') -or ($text -match '>::1<'))
        }
    }
    return $events
}

# Describes a filter with its owner, so a report line names the product.
function Get-FilterOwner {
    param($Filter, $Catalog)
    $provider = $null
    if ($Filter.providerKey -and $Catalog.providers.ContainsKey($Filter.providerKey)) { $provider = $Catalog.providers[$Filter.providerKey] }
    $subLayer = $null
    if ($Filter.subLayer -and $Catalog.subLayers.ContainsKey($Filter.subLayer)) { $subLayer = $Catalog.subLayers[$Filter.subLayer] }
    $callout = $null
    if ($Filter.calloutKey -and $Catalog.callouts.ContainsKey($Filter.calloutKey)) { $callout = $Catalog.callouts[$Filter.calloutKey] }
    $calloutProvider = $null
    if ($callout -and $callout.providerKey -and $Catalog.providers.ContainsKey($callout.providerKey)) { $calloutProvider = $Catalog.providers[$callout.providerKey] }
    $ownerName = $null
    foreach ($candidate in @($provider, $calloutProvider)) { if (-not $ownerName -and $candidate -and $candidate.name) { $ownerName = $candidate.name } }
    if (-not $ownerName -and $subLayer -and $subLayer.name) { $ownerName = $subLayer.name }
    $isCallout = [string]$Filter.action -match 'CALLOUT'
    # Without a parsed callout list, registration is unknown rather than "missing".
    $calloutsKnown = $Catalog.callouts.Count -gt 0
    $owner = [ordered]@{
        filterId = $Filter.filterId; filterName = $Filter.name; layer = $Filter.layer; action = $Filter.action
        provider = $(if ($provider) { $provider.name } else { $Filter.providerKey }); providerService = $(if ($provider) { $provider.serviceName } else { $null })
        subLayer = $(if ($subLayer) { $subLayer.name } else { $Filter.subLayer })
        callout = $(if ($callout) { $callout.name } else { $Filter.calloutKey })
        calloutRegistered = $(if ($isCallout -and $calloutsKnown) { [bool]($callout -and $callout.registered) } else { $null })
        owner = $ownerName; conditions = $Filter.conditions
    }
    $owner.microsoft = (Test-MicrosoftOwned $Filter.providerKey $owner.provider) -or ((-not $Filter.providerKey) -and (Test-MicrosoftOwned $Filter.subLayer $owner.subLayer))
    # WFP treats a terminating (or unknown) callout filter whose callout is not
    # registered as a block filter; an inspection callout is skipped instead.
    $owner.orphanCallout = $calloutsKnown -and ([string]$Filter.action -match 'CALLOUT_(TERMINATING|UNKNOWN)') -and -not ($callout -and $callout.registered)
    return $owner
}

function Format-Owner {
    param($Owner)
    $parts = @(('规则 ' + $Owner.filterId + ' ' + $Owner.filterName))
    if ($Owner.owner) { $parts += ('所属：' + $Owner.owner) }
    if ($Owner.providerService) { $parts += ('服务：' + $Owner.providerService) }
    $parts += ('层：' + ([string]$Owner.layer -replace '^FWPM_LAYER_', ''))
    $parts += ('动作：' + ([string]$Owner.action -replace '^FWP_ACTION_', ''))
    if ($null -ne $Owner.calloutRegistered) {
        $state = '是'
        if (-not $Owner.calloutRegistered) { $state = '否' }
        if ($Owner.orphanCallout) { $state = '否（驱动不在，这条规则等同于阻止）' }
        $parts += ('驱动已注册：' + $state)
    }
    return ($parts -join '；')
}

# Pure analysis over parsed WFP data; returns findings and report lines.
function Get-WfpFindings {
    param($Catalog, $Filters, $Events)
    $findings = [ordered]@{}
    $byId = @{}
    foreach ($filter in @($Filters)) { if ($filter.filterId) { $byId[[string]$filter.filterId] = $filter } }
    $loopbackDrops = @(@($Events) | Where-Object { $_.loopback -and ([string]$_.type -match 'DROP') })
    $findings.loopbackDropEvents = $loopbackDrops.Count
    $dropFilters = @()
    foreach ($group in @($loopbackDrops | Where-Object { $_.filterId } | Group-Object filterId | Sort-Object Count -Descending)) {
        $filter = $byId[[string]$group.Name]
        if ($filter) { $owner = Get-FilterOwner $filter $Catalog }
        else {
            $layerName = $null
            $sample = $group.Group[0]
            if ($sample.layerId -and $Catalog.layers.ContainsKey([string]$sample.layerId)) { $layerName = $Catalog.layers[[string]$sample.layerId] }
            $owner = [ordered]@{ filterId = $group.Name; filterName = '（规则已不存在）'; layer = $layerName; action = $null; owner = $null; microsoft = $false; orphanCallout = $false; calloutRegistered = $null; conditions = @() }
        }
        $owner.dropCount = $group.Count
        $owner.loopbackFlagged = @($group.Group | Where-Object { [string]$_.loopbackFlag -match '(?i)^(true|1)$' }).Count
        $owner.apps = @($group.Group | ForEach-Object { $_.app } | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 5)
        $dropFilters += $owner
    }
    $findings.loopbackDropFilters = $dropFilters
    # Telling vendor filters from Microsoft ones needs the provider list from the state dump.
    $providersKnown = $Catalog.providers.Count -gt 0
    $suspects = @()
    if ($providersKnown) {
        foreach ($filter in @($Filters)) {
            if ($InboundLayers -notcontains [string]$filter.layer) { continue }
            if ([string]$filter.action -match 'PERMIT') { continue }
            $owner = Get-FilterOwner $filter $Catalog
            if ($owner.microsoft -and -not $owner.orphanCallout) { continue }
            $suspects += $owner
        }
    }
    # Script-block keys: Windows PowerShell 5.1 cannot sort dictionaries by key name.
    $findings.nonMicrosoftBlockingFilters = @($suspects | Sort-Object @{ Expression = { -not $_.orphanCallout } }, @{ Expression = { [string]$_.layer } })
    $findings.orphanCalloutFilters = @($suspects | Where-Object { $_.orphanCallout }).Count
    $findings.nonMicrosoftProviders = @($Catalog.providers.Values | Where-Object { -not (Test-MicrosoftOwned $_.key $_.name) } | ForEach-Object { [ordered]@{ name = $_.name; serviceName = $_.serviceName; key = $_.key; flags = $_.flags } })
    $findings.unregisteredCallouts = @($Catalog.callouts.Values | Where-Object { -not $_.registered } | ForEach-Object {
        $providerName = $null
        if ($_.providerKey -and $Catalog.providers.ContainsKey($_.providerKey)) { $providerName = $Catalog.providers[$_.providerKey].name }
        [ordered]@{ name = $_.name; provider = $providerName; layer = $_.layer; key = $_.key }
    })

    $report = New-Object 'System.Collections.Generic.List[string]'
    if ($dropFilters.Count -gt 0) {
        $report.Add(('丢弃本机连接的过滤规则（来自系统丢包记录，共 {0} 条记录）：' -f $loopbackDrops.Count))
        foreach ($owner in $dropFilters | Select-Object -First 8) {
            $report.Add(('  ★ ' + (Format-Owner $owner) + '；丢弃 ' + $owner.dropCount + ' 次'))
            if (@($owner.conditions).Count) { $report.Add(('      条件：' + ((@($owner.conditions) | Select-Object -First 6) -join '；'))) } else { $report.Add('      条件：无（对所有连接生效）') }
            if (@($owner.apps).Count) { $report.Add(('      被拦程序：' + ((@($owner.apps) | ForEach-Object { ($_ -split '\\')[-1] }) -join '、'))) }
            $report.Add(('      系统标记为回环的连接：{0}/{1} 条' -f $owner.loopbackFlagged, $owner.dropCount))
            if ([string]$owner.filterName -match '(?i)^(Query User|Default Inbound|Default Outbound)') {
                # Microsoft's filter-origin docs: "Query user default" drops stop once the app has an inbound allow rule.
                $report.Add('      这是 Windows Defender 防火墙的默认拦截（Query user default）：程序没有入站放行规则时生效。解决办法：为上面的被拦程序添加入站放行规则。')
            }
        }
    } else {
        $report.Add(('系统丢包记录里没有找到本机连接的丢弃（共 {0} 条本机丢弃记录）。拦截方可能直接吞掉了连接而不记录，请看下面的规则清单。' -f $loopbackDrops.Count))
    }
    if (-not $providersKnown) {
        $report.Add('未能解析过滤平台的提供者信息，已跳过第三方规则筛查（原始数据在 wfp 目录）。')
    } elseif ($findings.nonMicrosoftBlockingFilters.Count -gt 0) {
        $report.Add(('连接相关层上的非微软/残留拦截规则 {0} 条（残留 {1} 条）：' -f $findings.nonMicrosoftBlockingFilters.Count, $findings.orphanCalloutFilters))
        foreach ($owner in $findings.nonMicrosoftBlockingFilters | Select-Object -First 15) { $report.Add(('  - ' + (Format-Owner $owner))) }
    } else {
        $report.Add('连接相关层上没有非微软的拦截规则。')
    }
    if ($providersKnown) {
        $providerNames = @($findings.nonMicrosoftProviders | ForEach-Object { $_.name + $(if ($_.serviceName) { '（' + $_.serviceName + '）' } else { '' }) })
        if ($providerNames.Count) { $report.Add(('非微软的过滤平台提供者：' + ($providerNames -join '、'))) } else { $report.Add('非微软的过滤平台提供者：无') }
    }
    $unregistered = @($findings.unregisteredCallouts | Where-Object { -not (Test-MicrosoftOwned $null $_.provider) } | ForEach-Object { $_.name + $(if ($_.provider) { '（' + $_.provider + '）' } else { '' }) })
    if ($unregistered.Count) { $report.Add(('驱动未加载的非微软 callout：' + (($unregistered | Select-Object -First 10) -join '、'))) }
    $findings.report = $report.ToArray()
    return $findings
}

function Get-PersistentBfeObjects {
    # Persistent WFP objects survive reboots and uninstalls; their names show who added them.
    $base = 'HKLM:\SYSTEM\CurrentControlSet\Services\BFE\Parameters\Policy\Persistent'
    $result = [ordered]@{}
    foreach ($kind in @('Provider', 'SubLayer', 'Callout', 'Filter')) {
        $entries = @()
        try {
            $key = Get-Item -LiteralPath (Join-Path $base $kind) -ErrorAction Stop
            foreach ($valueName in $key.GetValueNames()) {
                $bytes = $key.GetValue($valueName)
                if (-not ($bytes -is [byte[]])) { continue }
                $text = [Text.Encoding]::Unicode.GetString($bytes)
                $strings = @([regex]::Matches($text, '[ -~　-〿一-鿿＀-￯]{4,}') | ForEach-Object { $_.Value.Trim() } | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 6)
                if ($kind -eq 'Filter' -and (($strings -join ' ') -match '(?i)microsoft|windows|@%systemroot%|@fwpuclnt|@firewallapi|@mpssvc')) { continue }
                $entries += [ordered]@{ key = $valueName; strings = $strings }
            }
            $result[$kind] = @($entries | Select-Object -First 300)
        } catch {
            # $null (not an empty list) tells the report the key could not be read.
            Add-ProbeError ('bfe ' + $kind) $_
            $result[$kind] = $null
        }
    }
    return $result
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $OutDir) { throw 'OutDir is required.' }
    [void](New-Item -ItemType Directory -Path $OutDir -Force)
    $scratch = Join-Path $env:SystemRoot ('Temp\lobsterai-wfp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    [void](New-Item -ItemType Directory -Path $scratch -Force)
    $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
    try {
        Write-Host '  [管理员] 重新做本机连接测试，让系统记下丢包…'
        $analysis.loopbackTests = @((Test-LoopbackConnect), (Test-LoopbackConnect))
        Write-Host '  [管理员] 导出网络过滤规则（大约 1 分钟）…'
        $dumps = [ordered]@{ netevents = 'netevents.xml'; filters = 'filters.xml'; state = 'wfpstate.xml'; boottimepolicy = 'boottime.xml' }
        $analysis.dumps = [ordered]@{}
        foreach ($kind in $dumps.Keys) {
            $target = Join-Path $scratch $dumps[$kind]
            try {
                $run = Invoke-Captured $netsh @('wfp', 'show', $kind, ('file=' + $target)) 300
                $analysis.dumps[$kind] = [ordered]@{ exitCode = $run.exitCode; timedOut = $run.timedOut; output = ($run.stdout + ' ' + $run.stderr).Trim(); bytes = $(if (Test-Path -LiteralPath $target) { (Get-Item -LiteralPath $target).Length } else { 0 }) }
            } catch { Add-ProbeError ('netsh ' + $kind) $_ }
        }
        foreach ($option in @('netevents', 'keywords')) {
            try { $run = Invoke-Captured $netsh @('wfp', 'show', 'options', ('optionsfor=' + $option)) 60; Save-Text ('wfp-options-' + $option + '.txt') ($run.stdout + $run.stderr) } catch { Add-ProbeError ('options ' + $option) $_ }
        }
        Write-Host '  [管理员] 读取驱动和防火墙规则…'
        try { $run = Invoke-Captured (Join-Path $env:SystemRoot 'System32\driverquery.exe') @('/v', '/fo', 'csv') 120; Save-Text 'drivers.csv' $run.stdout } catch { Add-ProbeError 'driverquery' $_ }
        try { $run = Invoke-Captured (Join-Path $env:SystemRoot 'System32\fltMC.exe') @('filters') 60; Save-Text 'fltmc-filters.txt' ($run.stdout + $run.stderr) } catch { Add-ProbeError 'fltmc' $_ }
        try {
            $analysis.firewallProfiles = @(Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object {
                [ordered]@{ name = $_.Name; enabled = [string]$_.Enabled; defaultInbound = [string]$_.DefaultInboundAction; allowInboundRules = [string]$_.AllowInboundRules; allowLocalFirewallRules = [string]$_.AllowLocalFirewallRules; notifyOnListen = [string]$_.NotifyOnListen }
            })
            $analysis.inboundBlockRules = @(Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue | Select-Object -First 200 | ForEach-Object {
                $rule = $_
                $program = $null; $address = $null; $ports = $null
                try { $program = ($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop).Program } catch { }
                try { $address = ($rule | Get-NetFirewallAddressFilter -ErrorAction Stop).LocalAddress -join ',' } catch { }
                try { $ports = ($rule | Get-NetFirewallPortFilter -ErrorAction Stop).LocalPort -join ',' } catch { }
                [ordered]@{ name = $rule.DisplayName; group = $rule.DisplayGroup; owner = $rule.Owner; program = $program; localAddress = $address; localPort = $ports; policyStore = [string]$rule.PolicyStoreSourceType }
            })
        } catch { Add-ProbeError 'firewall' $_ }
        $analysis.persistentBfe = Get-PersistentBfeObjects
        try { $analysis.services = @(Get-Service -Name BFE, MpsSvc, mpsdrv -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ name = $_.Name; status = [string]$_.Status; startType = [string]$_.StartType } }) } catch { Add-ProbeError 'services' $_ }

        Write-Host '  [管理员] 分析过滤规则…'
        $state = $null; $filterDocument = $null; $eventDocument = $null
        try { $state = Read-XmlDocument (Join-Path $scratch 'wfpstate.xml') } catch { Add-ProbeError 'parse state' $_ }
        try { $filterDocument = Read-XmlDocument (Join-Path $scratch 'filters.xml') } catch { Add-ProbeError 'parse filters' $_ }
        try { $eventDocument = Read-XmlDocument (Join-Path $scratch 'netevents.xml') } catch { Add-ProbeError 'parse netevents' $_ }
        $catalog = Get-WfpCatalog $state
        $filters = @(Get-WfpFilters $filterDocument)
        if ($filters.Count -eq 0) { $filters = @(Get-WfpFilters $state) }
        $events = @(Get-WfpNetEvents $eventDocument)
        $analysis.counts = [ordered]@{ providers = $catalog.providers.Count; subLayers = $catalog.subLayers.Count; callouts = $catalog.callouts.Count; filters = $filters.Count; netEvents = $events.Count }
        $analysis.xmlShapes = [ordered]@{ state = (Get-XmlShape $state); filters = (Get-XmlShape $filterDocument); netevents = (Get-XmlShape $eventDocument) }
        $findings = Get-WfpFindings $catalog $filters $events
        $analysis.findings = $findings
        $lines.Add(('过滤平台：提供者 {0} 个，callout {1} 个，过滤规则 {2} 条，丢包记录 {3} 条' -f $catalog.providers.Count, $catalog.callouts.Count, $filters.Count, $events.Count))
        foreach ($line in $findings.report) { $lines.Add($line) }
        if ($analysis.Contains('firewallProfiles')) {
            $profiles = @($analysis.firewallProfiles | ForEach-Object { $_.name + '=' + $_.enabled + '/入站默认 ' + $_.defaultInbound + '/允许入站规则 ' + $_.allowInboundRules })
            $lines.Add(('防火墙配置：' + ($profiles -join '；')))
        } else { $lines.Add('防火墙配置：未能读取') }
        if ($analysis.Contains('inboundBlockRules')) {
            $blockRules = @($analysis.inboundBlockRules | Where-Object { $_ } | ForEach-Object { $_.name + $(if ($_.program -and $_.program -ne 'Any') { '（' + $_.program + '）' } else { '' }) })
            $lines.Add(('已启用的入站阻止规则 {0} 条：{1}' -f $blockRules.Count, $(if ($blockRules.Count) { (($blockRules | Select-Object -First 10) -join '、') } else { '无' })))
        }
        if ($null -eq $analysis.persistentBfe.Provider) { $lines.Add('持久化（重启后仍存在）的非微软提供者：未能读取') }
        else {
            $persistentProviders = @($analysis.persistentBfe.Provider | ForEach-Object { ($_.strings | Select-Object -First 2) -join ' / ' } | Where-Object { $_ -and -not (Test-MicrosoftOwned $null $_) })
            $lines.Add(('持久化（重启后仍存在）的非微软提供者：' + $(if ($persistentProviders.Count) { $persistentProviders -join '、' } else { '无' })))
        }
    } catch {
        Add-ProbeError 'probe' $_
    } finally {
        foreach ($file in @(Get-ChildItem -LiteralPath $scratch -File -ErrorAction SilentlyContinue)) {
            # Copy, not move: a moved file keeps the admin-only ACL of %SystemRoot%\Temp,
            # and the non-elevated collector could then not zip it (seen 2026-10-09).
            try { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $OutDir $file.Name) -Force } catch { Add-ProbeError ('copy ' + $file.Name) $_ }
        }
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
        $analysis.finishedAt = (Get-Date).ToString('o')
        $analysis.errors = $errors.ToArray()
        if ($errors.Count) { $lines.Add(('管理员采集过程中的错误：' + $errors.Count + ' 项（' + ((@($errors.ToArray()) | ForEach-Object { $_.stage }) -join '、') + '），见 wfp-analysis.json')) }
        $json = ConvertTo-Json -InputObject $analysis -Depth 10
        [IO.File]::WriteAllText((Join-Path $OutDir 'wfp-analysis.json'), $json, (New-Object Text.UTF8Encoding($false)))
        Save-Text 'wfp-summary.txt' ($lines.ToArray() -join "`r`n")
    }
}
