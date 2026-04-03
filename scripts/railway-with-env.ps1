# Loads railway.local.env then runs Railway CLI. Usage:
#   .\scripts\railway-with-env.ps1 whoami
#   .\scripts\railway-with-env.ps1 up --ci
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RailwayArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envFile = Join-Path $repoRoot "railway.local.env"

if (-not (Test-Path $envFile)) {
  Write-Host "Missing railway.local.env in repo root." -ForegroundColor Yellow
  Write-Host "Copy railway.local.env.example -> railway.local.env and set RAILWAY_TOKEN (see README)." -ForegroundColor Yellow
  exit 1
}

foreach ($line in Get-Content $envFile) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith("#")) { continue }
  $eq = $t.IndexOf("=")
  if ($eq -lt 1) { continue }
  $key = $t.Substring(0, $eq).Trim()
  $val = $t.Substring($eq + 1).Trim()
  if (
    ($val.StartsWith('"') -and $val.EndsWith('"')) -or
    ($val.StartsWith("'") -and $val.EndsWith("'"))
  ) {
    $val = $val.Substring(1, $val.Length - 2)
  }
  Set-Item -Path "Env:$key" -Value $val
}

Push-Location $repoRoot
try {
  $cli = "npx"
  $prefix = @("--yes", "@railway/cli")
  & $cli @prefix @RailwayArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
