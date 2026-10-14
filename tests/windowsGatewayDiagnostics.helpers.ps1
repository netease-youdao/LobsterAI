# Execute with Windows PowerShell 5.1 or pwsh. No Windows-specific APIs are used here.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\support\windows-gateway-diagnostics\diagnostic-common.ps1')
function Assert-Condition { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }

$sample = @'
[info] [OpenClaw] forking gateway: args=["gateway","--token","sensitive-gateway-token"]
Authorization: Bearer sensitive-authorization
apiKey="sensitive-api-key"
password: sensitive-password
url=https://example.invalid/check?token=sensitive-query&uuid=customer-uuid
'@
$protected = Protect-DiagnosticText $sample
foreach ($secret in @('sensitive-gateway-token', 'sensitive-authorization', 'sensitive-api-key', 'sensitive-password', 'sensitive-query', 'customer-uuid')) {
    Assert-Condition (-not $protected.Contains($secret)) ('Secret was retained: ' + $secret)
}
$logs = @'
[2026-09-20 21:00:00] [info] user message: private conversation content
[2026-09-20 21:00:01] [error] [OpenClaw stderr] [openclaw] Reason: SQLite read-only worker returned invalid JSON
[2026-09-20 21:00:02] [info] [OpenClaw stdout] [0x123] ANOMALY: meaningless REX prefix used
[2026-09-20 21:00:03] [info] [OpenClaw] Startup migration process closed: {
  pid: 123,
  code: 0,
  signal: null
}
[2026-09-20 21:00:04] [info] collectSecretEnvVars token=never-export-this
{"0":"SQLite read-only worker returned invalid JSON","time":"2026-09-20T21:00:05+08:00","_meta":{"private":"never-export-metadata"}}
'@
$filtered = Select-DiagnosticLogText $logs
Assert-Condition ($filtered.Contains('invalid JSON')) 'The root failure was dropped.'
Assert-Condition ($filtered.Contains('ANOMALY:')) 'Native stdout evidence was dropped.'
Assert-Condition ($filtered.Contains('code: 0')) 'Migration exit code was dropped.'
foreach ($privateText in @('private conversation content', 'never-export-this', 'never-export-metadata')) {
    Assert-Condition (-not $filtered.Contains($privateText)) ('Unrelated content retained: ' + $privateText)
}
Assert-Condition ((ConvertTo-DiagnosticArgument 'C:\Program Files\LobsterAI\') -eq '"C:\Program Files\LobsterAI\\"') 'Trailing slash quoting failed.'
Assert-Condition ((ConvertTo-DiagnosticArgument 'C:\a"b\file') -eq '"C:\a\"b\file"') 'Quote escaping failed.'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('diagnostic-helper-test-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testRoot)
try {
    $logPath = Join-Path $testRoot 'fixture.log'
    [IO.File]::WriteAllText($logPath, "old line`nnew line`n")
    Assert-Condition ((Read-DiagnosticTail $logPath 12).Trim() -eq 'new line') 'Bounded log tail failed.'
    $jsonPath = Join-Path $testRoot 'fixture.json'
    Write-DiagnosticJson $jsonPath @{ stdout = '{"ok":true,"location":"C:\\temp\\fixture.sqlite"}'; path = 'C:\Program Files\LobsterAI' }
    $decoded = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
    Assert-Condition (($decoded.stdout | ConvertFrom-Json).ok -eq $true) 'Nested worker JSON was corrupted.'
} finally { Remove-Item -LiteralPath $testRoot -Recurse -Force }
Write-Host 'PowerShell helper checks passed.'
