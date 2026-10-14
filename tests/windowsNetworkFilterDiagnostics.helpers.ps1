# Execute with Windows PowerShell 5.1 or pwsh. Dot-sourcing the probe only
# defines its functions; the elevated collection runs when it is invoked as a script.
$ErrorActionPreference = 'Stop'
function Assert-Condition { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }
. (Join-Path $PSScriptRoot '..\scripts\support\windows-gateway-diagnostics\network-filter-probe.ps1')

# Shaped like `netsh wfp show state` / `show filters` / `show netevents` output.
$stateXml = @'
<?xml version="1.0"?>
<wfpdiag>
  <providers numItems="2">
    <item><providerKey>FWPM_PROVIDER_MPSSVC_WF</providerKey><displayData><name>Microsoft Windows WFP Built-in MPSSVC provider</name><description>Windows Firewall</description></displayData><flags numItems="1"><item>FWPM_PROVIDER_FLAG_PERSISTENT</item></flags><serviceName>mpssvc</serviceName></item>
    <item><providerKey>{6b2fa1c4-0000-4000-8000-000000000001}</providerKey><displayData><name>Example NetGuard Provider</name><description>Leftover vendor provider</description></displayData><flags numItems="1"><item>FWPM_PROVIDER_FLAG_PERSISTENT</item></flags><serviceName>ExampleNetGuard</serviceName></item>
  </providers>
  <subLayers numItems="1">
    <item><subLayerKey>{7c3fb2d5-0000-4000-8000-000000000002}</subLayerKey><displayData><name>Example NetGuard Sublayer</name></displayData><providerKey>{6b2fa1c4-0000-4000-8000-000000000001}</providerKey></item>
  </subLayers>
  <layers numItems="2">
    <item>
      <layer><layerKey>FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4</layerKey><layerId>44</layerId></layer>
      <callouts numItems="2">
        <item><calloutKey>{8d40c3e6-0000-4000-8000-000000000003}</calloutKey><displayData><name>Example NetGuard Accept Callout</name></displayData><flags numItems="1"><item>FWPM_CALLOUT_FLAG_PERSISTENT</item></flags><providerKey>{6b2fa1c4-0000-4000-8000-000000000001}</providerKey><applicableLayer>FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4</applicableLayer><calloutId>300</calloutId></item>
        <item><calloutKey>{9e51d4f7-0000-4000-8000-000000000004}</calloutKey><displayData><name>Windows Defender NIS callout</name></displayData><flags numItems="1"><item>FWPM_CALLOUT_FLAG_REGISTERED</item></flags><applicableLayer>FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4</applicableLayer><calloutId>301</calloutId></item>
      </callouts>
    </item>
    <item><layer><layerKey>FWPM_LAYER_STREAM_V4</layerKey><layerId>20</layerId></layer></item>
  </layers>
</wfpdiag>
'@
$filtersXml = @'
<?xml version="1.0"?>
<wfpdiag>
  <filters numItems="4">
    <item><filterKey>{a0000000-0000-4000-8000-000000000010}</filterKey><displayData><name>Default Inbound</name></displayData><flags numItems="1"><item>FWPM_FILTER_FLAG_PERSISTENT</item></flags><providerKey>FWPM_PROVIDER_MPSSVC_WF</providerKey><layerKey>FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4</layerKey><subLayerKey>FWPM_SUBLAYER_MPSSVC_WF</subLayerKey><action><type>FWP_ACTION_BLOCK</type><filterType/></action><filterId>1001</filterId></item>
    <item><filterKey>{a0000000-0000-4000-8000-000000000011}</filterKey><displayData><name>NetGuard inbound accept</name></displayData><flags numItems="1"><item>FWPM_FILTER_FLAG_PERSISTENT</item></flags><providerKey>{6b2fa1c4-0000-4000-8000-000000000001}</providerKey><layerKey>FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4</layerKey><subLayerKey>{7c3fb2d5-0000-4000-8000-000000000002}</subLayerKey><filterCondition numItems="1"><item><fieldKey>FWPM_CONDITION_FLAGS</fieldKey><matchType>FWP_MATCH_FLAGS_ALL_SET</matchType><conditionValue><type>FWP_UINT32</type><uint32>FWP_CONDITION_FLAG_IS_LOOPBACK</uint32></conditionValue></item></filterCondition><action><type>FWP_ACTION_CALLOUT_TERMINATING</type><calloutKey>{8d40c3e6-0000-4000-8000-000000000003}</calloutKey></action><filterId>2002</filterId></item>
    <item><filterKey>{a0000000-0000-4000-8000-000000000012}</filterKey><displayData><name>NetGuard stream inspect</name></displayData><providerKey>{6b2fa1c4-0000-4000-8000-000000000001}</providerKey><layerKey>FWPM_LAYER_STREAM_V4</layerKey><subLayerKey>{7c3fb2d5-0000-4000-8000-000000000002}</subLayerKey><action><type>FWP_ACTION_CALLOUT_INSPECTION</type><calloutKey>{f0000000-0000-4000-8000-0000000000ff}</calloutKey></action><filterId>2003</filterId></item>
    <item><filterKey>{a0000000-0000-4000-8000-000000000013}</filterKey><displayData><name>NIS inspection</name></displayData><layerKey>FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4</layerKey><subLayerKey>FWPM_SUBLAYER_UNIVERSAL</subLayerKey><action><type>FWP_ACTION_CALLOUT_TERMINATING</type><calloutKey>{9e51d4f7-0000-4000-8000-000000000004}</calloutKey></action><filterId>1002</filterId></item>
  </filters>
</wfpdiag>
'@
$eventsXml = @'
<?xml version="1.0"?>
<wfpdiag>
  <netEvents numItems="3">
    <item><header><timeStamp>2026-10-09T07:13:40.100Z</timeStamp><ipProtocol>6</ipProtocol><localAddrV4>127.0.0.1</localAddrV4><remoteAddrV4>127.0.0.1</remoteAddrV4><localPort>61989</localPort><remotePort>50111</remotePort><appId><asString>\device\harddiskvolume3\windows\system32\windowspowershell\v1.0\powershell.exe</asString></appId></header><type>FWPM_NET_EVENT_TYPE_CLASSIFY_DROP</type><classifyDrop><filterId>2002</filterId><layerId>44</layerId><isLoopback>true</isLoopback></classifyDrop></item>
    <item><header><timeStamp>2026-10-09T07:13:43.200Z</timeStamp><ipProtocol>6</ipProtocol><localAddrV4>127.0.0.1</localAddrV4><remoteAddrV4>127.0.0.1</remoteAddrV4><localPort>18789</localPort><remotePort>50112</remotePort><appId><asString>\device\harddiskvolume3\program files\lobsterai\lobsterai.exe</asString></appId></header><type>FWPM_NET_EVENT_TYPE_CLASSIFY_DROP</type><classifyDrop><filterId>2002</filterId><layerId>44</layerId><isLoopback>true</isLoopback></classifyDrop></item>
    <item><header><timeStamp>2026-10-09T07:10:00.000Z</timeStamp><ipProtocol>17</ipProtocol><localAddrV4>192.168.1.20</localAddrV4><remoteAddrV4>192.168.1.1</remoteAddrV4></header><type>FWPM_NET_EVENT_TYPE_CLASSIFY_DROP</type><classifyDrop><filterId>1001</filterId><layerId>44</layerId><isLoopback>false</isLoopback></classifyDrop></item>
  </netEvents>
</wfpdiag>
'@
function ConvertTo-Document { param([string]$Text) $document = New-Object Xml.XmlDocument; $document.LoadXml($Text); return $document }
$catalog = Get-WfpCatalog (ConvertTo-Document $stateXml)
Assert-Condition ($catalog.providers.Count -eq 2 -and $catalog.callouts.Count -eq 2 -and $catalog.layers['44'] -eq 'FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4') 'The WFP catalog was not parsed.'
Assert-Condition (-not $catalog.callouts['{8d40c3e6-0000-4000-8000-000000000003}'].registered -and $catalog.callouts['{9e51d4f7-0000-4000-8000-000000000004}'].registered) 'Callout registration was misread.'
$filters = @(Get-WfpFilters (ConvertTo-Document $filtersXml))
Assert-Condition ($filters.Count -eq 4 -and $filters[1].calloutKey -eq '{8d40c3e6-0000-4000-8000-000000000003}') 'Filters were not parsed.'
$events = @(Get-WfpNetEvents (ConvertTo-Document $eventsXml))
Assert-Condition ($events.Count -eq 3 -and $events[0].loopback -and -not $events[2].loopback -and $events[1].localPort -eq '18789') 'Net events were not parsed.'

$findings = Get-WfpFindings $catalog $filters $events
Assert-Condition ($findings.loopbackDropEvents -eq 2) ('Loopback drops: ' + $findings.loopbackDropEvents)
$top = $findings.loopbackDropFilters[0]
Assert-Condition ($top.filterId -eq '2002' -and $top.dropCount -eq 2 -and $top.owner -eq 'Example NetGuard Provider' -and $top.orphanCallout) ('Drop owner: ' + ($top | ConvertTo-Json -Compress))
Assert-Condition (@($top.apps).Count -eq 2) 'Dropping apps were not listed.'
$suspects = @($findings.nonMicrosoftBlockingFilters)
Assert-Condition ($suspects.Count -eq 2 -and $suspects[0].filterId -eq '2002') ('Suspects: ' + (@($suspects | ForEach-Object { $_.filterId }) -join ','))
Assert-Condition (-not $suspects[1].orphanCallout) 'An inspection callout was treated as a block.'
Assert-Condition (-not (@($suspects | Where-Object { $_.filterId -in @('1001', '1002') }).Count)) 'Microsoft filters were reported as suspects.'
$report = $findings.report -join "`n"
Assert-Condition ($report -match '★ 规则 2002 NetGuard inbound accept' -and $report -match '所属：Example NetGuard Provider' -and $report -match '服务：ExampleNetGuard' -and $report -match '等同于阻止' -and $report -match '丢弃 2 次') ('Report: ' + $report)
Assert-Condition ($report -match '条件：FWPM_CONDITION_FLAGS' -and $report -match '被拦程序：powershell\.exe、lobsterai\.exe' -and $report -match '系统标记为回环的连接：2/2 条') ('Drop details: ' + $report)
Assert-Condition ($report -match '非微软的过滤平台提供者：Example NetGuard Provider（ExampleNetGuard）') ('Providers line: ' + $report)
Assert-Condition ($report -match '驱动未加载的非微软 callout：Example NetGuard Accept Callout') ('Unregistered callouts line: ' + $report)

# Without drop records the report falls back to the rule list; with one provider the node list must not split.
$single = Get-WfpCatalog (ConvertTo-Document '<wfpdiag><providers><item><providerKey>{1}</providerKey><displayData><name>Only Vendor</name></displayData></item></providers></wfpdiag>')
Assert-Condition ($single.providers.Count -eq 1 -and $single.providers['{1}'].name -eq 'Only Vendor') 'A single provider was not parsed.'
$quiet = Get-WfpFindings $catalog $filters @()
Assert-Condition ($quiet.loopbackDropFilters.Count -eq 0 -and ($quiet.report -join "`n") -match '没有找到本机连接的丢弃') 'The no-drop fallback is missing.'
$empty = Get-WfpFindings (Get-WfpCatalog $null) @() @()
Assert-Condition (($empty.report -join "`n") -match '未能解析过滤平台的提供者信息') 'An empty dump was not handled.'

# As seen on a customer machine (2026-10-09): the state dump yielded no providers or
# callouts, and the drops came from Windows Firewall's own "Query User" filter.
$queryUserFilters = @(
    [pscustomobject]@{ filterId = '8846186'; key = '{q}'; name = 'Query User'; providerKey = '{4b153735-1049-4480-aab4-d1b9bdc03710}'; layer = 'FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4'; subLayer = '{b3cdd441-af90-41ba-a745-7c6008ff2302}'; action = 'FWP_ACTION_BLOCK'; calloutKey = $null; flags = @(); conditions = @() },
    [pscustomobject]@{ filterId = '8846894'; key = '{g}'; name = 'Game Bar'; providerKey = '{4b153735-1049-4480-aab4-d1b9bdc03710}'; layer = 'FWPM_LAYER_ALE_AUTH_LISTEN_V4'; subLayer = '{b3cdd441-af90-41ba-a745-7c6008ff2302}'; action = 'FWP_ACTION_CALLOUT_TERMINATING'; calloutKey = '{c}'; flags = @(); conditions = @() }
)
$queryUserEvents = @(
    [pscustomobject]@{ type = 'FWPM_NET_EVENT_TYPE_CLASSIFY_DROP'; filterId = '8846186'; layerId = '44'; app = '\device\harddiskvolume3\program files\lobsterai\lobsterai.exe'; loopbackFlag = 'true'; loopback = $true },
    [pscustomobject]@{ type = 'FWPM_NET_EVENT_TYPE_CLASSIFY_DROP'; filterId = '8846186'; layerId = '44'; app = '\device\harddiskvolume3\windows\system32\windowspowershell\v1.0\powershell.exe'; loopbackFlag = 'false'; loopback = $true }
)
$noState = Get-WfpFindings (Get-WfpCatalog $null) $queryUserFilters $queryUserEvents
$noStateReport = $noState.report -join "`n"
Assert-Condition ($noStateReport -match '★ 规则 8846186 Query User' -and $noStateReport -match '动作：BLOCK' -and $noStateReport -match '丢弃 2 次') ('Query User drop: ' + $noStateReport)
Assert-Condition ($noStateReport -match '条件：无（对所有连接生效）' -and $noStateReport -match '系统标记为回环的连接：1/2 条' -and $noStateReport -match 'Query user default' -and $noStateReport -match '添加入站放行规则') ('Query User details: ' + $noStateReport)
Assert-Condition ($noState.nonMicrosoftBlockingFilters.Count -eq 0 -and $noStateReport -notmatch '残留' -and $noStateReport -match '未能解析过滤平台的提供者信息') ('Unknown providers produced suspects: ' + $noStateReport)
Assert-Condition ($null -eq $noState.loopbackDropFilters[0].calloutRegistered) 'Callout registration was guessed without a callout list.'

# Packaging skips a file the collector cannot read instead of losing the whole ZIP.
$tokens = $null; $parseErrors = $null
$collector = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\support\windows-gateway-diagnostics\collect-network-filters.ps1'), [ref]$tokens, [ref]$parseErrors)
Assert-Condition ($parseErrors.Count -eq 0) 'collect-network-filters.ps1 does not parse.'
$zipFunction = $collector.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-DiagnosticZip' }, $true)
. ([ScriptBlock]::Create($zipFunction.Extent.Text))
$zipRoot = Join-Path ([IO.Path]::GetTempPath()) ('filter-zip-test-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path (Join-Path $zipRoot 'report/wfp') -Force)
try {
    [IO.File]::WriteAllText((Join-Path $zipRoot 'report/summary.txt'), 'summary')
    [IO.File]::WriteAllText((Join-Path $zipRoot 'report/wfp/filters.xml'), '<wfpdiag/>')
    $locked = Join-Path $zipRoot 'report/wfp/boottime.xml'
    [IO.File]::WriteAllText($locked, '<wfpdiag/>')
    $canRestrict = $false
    if ($env:OS -ne 'Windows_NT') { & chmod 000 $locked; $canRestrict = $true }
    $zipPath = Join-Path $zipRoot 'out.zip'
    $skipped = @(New-DiagnosticZip (Join-Path $zipRoot 'report') $zipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try { $entries = @($archive.Entries | ForEach-Object { $_.FullName }) } finally { $archive.Dispose() }
    Assert-Condition ($entries -contains 'summary.txt' -and $entries -contains 'wfp/filters.xml') ('Readable files are missing: ' + ($entries -join ','))
    $clean = Join-Path $zipRoot 'clean'
    [void](New-Item -ItemType Directory -Path $clean)
    [IO.File]::WriteAllText((Join-Path $clean 'a.txt'), 'a')
    Assert-Condition (@(New-DiagnosticZip $clean (Join-Path $zipRoot 'clean.zip')).Count -eq 0) 'A clean package reported skipped files.'
    if ($canRestrict) {
        Assert-Condition ($skipped.Count -eq 1 -and $skipped[0] -is [string] -and $skipped[0] -match '^wfp/boottime\.xml' -and $entries -contains 'zip-skipped.txt' -and $entries -notcontains 'wfp/boottime.xml') ('Unreadable file handling: ' + ($skipped -join '; ') + ' / ' + ($entries -join ','))
    }
} finally {
    if ($env:OS -ne 'Windows_NT') { & chmod -R u+rw $zipRoot }
    Remove-Item -LiteralPath $zipRoot -Recurse -Force
}
Assert-Condition ((ConvertFrom-ConsoleBytes ([Text.Encoding]::UTF8.GetBytes('当前的 WinHTTP 代理服务器设置'))) -eq '当前的 WinHTTP 代理服务器设置') 'UTF-8 console output was not decoded.'
Write-Host 'Network filter probe checks passed.'
