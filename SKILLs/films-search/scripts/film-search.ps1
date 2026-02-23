# Films Search - 影视资源搜索 CLI 入口 (Windows PowerShell)
# 用法: powershell -File film-search.ps1 search "关键词" [--pan quark] [--quality 4k]

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillDir = Split-Path -Parent $ScriptDir

# ---- Resolve Node.js runtime ----
$NodeBin = $null
$EnvVars = @{}

# Try system node first
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if ($nodePath) {
    $NodeBin = $nodePath.Path
} elseif ($env:LOBSTERAI_ELECTRON_PATH -and (Test-Path $env:LOBSTERAI_ELECTRON_PATH)) {
    $NodeBin = $env:LOBSTERAI_ELECTRON_PATH
    $EnvVars["ELECTRON_RUN_AS_NODE"] = "1"
} else {
    Write-Output '{"success":false,"error":"未找到 Node.js 运行时。请安装 Node.js 或确保 LobsterAI Electron 可用。"}'
    exit 1
}

# ---- Load .env configuration ----
$envFile = Join-Path $SkillDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $eqIdx = $line.IndexOf("=")
            if ($eqIdx -gt 0) {
                $key = $line.Substring(0, $eqIdx).Trim()
                $value = $line.Substring($eqIdx + 1).Trim()
                [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
            }
        }
    }
}

# ---- Set additional environment variables ----
foreach ($key in $EnvVars.Keys) {
    [System.Environment]::SetEnvironmentVariable($key, $EnvVars[$key], "Process")
}

# ---- Handle @file syntax for non-ASCII keywords ----
$processedArgs = @()
foreach ($arg in $args) {
    if ($arg -match "^@(.+)$") {
        $filePath = $Matches[1]
        if (Test-Path $filePath) {
            $content = Get-Content $filePath -Raw -Encoding UTF8
            $processedArgs += $content.Trim()
        } else {
            $processedArgs += $arg
        }
    } else {
        $processedArgs += $arg
    }
}

# ---- Execute core script ----
$jsScript = Join-Path $ScriptDir "film-search.js"
& $NodeBin $jsScript @processedArgs
exit $LASTEXITCODE
