# Compatible with Windows PowerShell 5.1. Functions are separately testable.
function Protect-DiagnosticText {
    param([AllowEmptyString()][string]$Text)
    if (-not $Text) { return '' }
    # Never export authentication-bearing argv or named credentials from logs.
    $Text = [regex]::Replace($Text, '(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*', '<REDACTED-AUTH>')
    $Text = [regex]::Replace($Text, '(?i)(["'']?--(?:token|api-key|password|secret)["'']?[\s,=]+)["'']?[^"''\s,\]]+["'']?', '$1"<REDACTED>"')
    $Text = [regex]::Replace($Text, '(?i)(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|gateway[_-]?token|token|password|secret)["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;\]}]+)', '$1"<REDACTED>"')
    $Text = [regex]::Replace($Text, '(?i)\bsk-[A-Za-z0-9_-]{8,}', '<REDACTED-KEY>')
    $Text = [regex]::Replace($Text, '(?i)(https?://[^\s?"'']+)\?[^\s"'']+', '$1?<QUERY-REDACTED>')
    if ($env:USERPROFILE) {
        $Text = $Text.Replace($env:USERPROFILE.Replace('\', '\\'), '<USERPROFILE>')
        $Text = $Text.Replace($env:USERPROFILE, '<USERPROFILE>')
    }
    return $Text
}

function Write-DiagnosticJson {
    param([string]$Path, $Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 12
    [IO.File]::WriteAllText($Path, (Protect-DiagnosticText $json), (New-Object Text.UTF8Encoding($false)))
}

function Read-DiagnosticTail {
    param([string]$Path, [int]$Limit = 2097152)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $offset = [Math]::Max(0, $stream.Length - $Limit)
        [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
        try {
            if ($offset -gt 0) { [void]$reader.ReadLine() }
            return $reader.ReadToEnd()
        } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Select-DiagnosticLogText {
    param([string]$Text)
    $selected = New-Object 'System.Collections.Generic.List[string]'
    $continuation = 0
    $pattern = '(?i)(SQLite read-only worker|ANOMALY:|Could not start the CLI|uses (?:newer )?schema version|Verified shared-state schema|Startup (?:migration process|state migration|compatibility)|Legacy session (?:doctor|storage|migration)|\[openclaw-launcher\]|\[gateway\] (?:starting|ready|listening)|gateway (?:process (?:exited|spawned)|auto-restart|failed to start|startup stopped)|\[OpenClawRepair\]|onHelloOk|waitForGatewayReady: (?:timed out|gateway process is gone)|startGateway: (?:resolveOpenClawEntry|waitForGatewayReady|gateway process)|LobsterAI started|currentVersion=|phase=custom-init-start)'
    foreach ($rawLine in ($Text -split '\r?\n')) {
        $line = $rawLine
        if ($line.StartsWith('{')) {
            try {
                $record = ConvertFrom-Json -InputObject $line -ErrorAction Stop
                $messages = @()
                foreach ($key in @('0', '1', '2')) {
                    if ($record.PSObject.Properties[$key] -and $record.$key -is [string]) { $messages += $record.$key }
                }
                $line = ([string]$record.time) + ' ' + ($messages -join ' ')
            } catch { continue }
        }
        # Credential/environment dumps and conversation payloads are never selected.
        if ($line -match '(?i)(collectSecretEnvVars|set secret env|authorization|rawPrompt|systemPrompt|"content"\s*:|"messages"\s*:)') { continue }
        if ($line -match $pattern) {
            $selected.Add((Protect-DiagnosticText $line))
            $continuation = 0
            if ($line.TrimEnd().EndsWith('{')) { $continuation = 20 }
        } elseif ($continuation -gt 0) {
            $continuation--
            if ($line -match '^\s*(?:pid|parentPid|entry|code|signal|status|version|stateDir|createdAt)\s*:') {
                $selected.Add((Protect-DiagnosticText $line))
            }
            if ($line.Trim().StartsWith('}')) { $continuation = 0 }
        }
    }
    return $selected -join "`r`n"
}

function ConvertTo-DiagnosticArgument {
    param([string]$Value)
    # CommandLineToArgvW quoting; paths containing spaces, quotes or trailing slashes.
    return '"' + ([regex]::Replace(([regex]::Replace($Value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
}
