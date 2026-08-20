param(
    [string]$Only = ''
)

$ErrorActionPreference = 'Stop'

function Import-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) {
            return
        }

        $eq = $line.IndexOf('=')
        if ($eq -lt 1) {
            return
        }

        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $existing = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ([string]::IsNullOrWhiteSpace($existing)) {
            Set-Item -Path "Env:$key" -Value $value
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'Installing Playwright...' -ForegroundColor Cyan
    npm install --prefix $PSScriptRoot
}

Import-DotEnv (Join-Path $PSScriptRoot '.env')

if ([string]::IsNullOrWhiteSpace($env:EMIAS_URL)) {
    $env:EMIAS_URL = $DefaultEmiasUrl
}
if ([string]::IsNullOrWhiteSpace($env:EMIAS_CODE)) {
    $env:EMIAS_CODE = $DefaultEmiasCode
}

try {
    if (-not [string]::IsNullOrWhiteSpace($Only)) {
        $env:EMIAS_ONLY = $Only
    }
    npm start --prefix $PSScriptRoot
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($Only)) {
        Remove-Item Env:EMIAS_ONLY -ErrorAction SilentlyContinue
    }
}
