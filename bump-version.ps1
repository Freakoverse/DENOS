<#
.SYNOPSIS
    Bump the DENOS version across all config files.

.DESCRIPTION
    Updates the version string in:
      - package.json
      - src-tauri/Cargo.toml
      - src-tauri/tauri.conf.json

.PARAMETER Version
    The new version string (e.g. "0.3.0"). If omitted, you will be prompted.

.EXAMPLE
    .\bump-version.ps1 0.3.0
    .\bump-version.ps1           # interactive prompt
#>

param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# -- Files to update --
$files = @(
    @{ Path = "$root\package.json";              Pattern = '"version":\s*"[^"]+"';  Replace = { param($v) """version"": ""$v""" } },
    @{ Path = "$root\src-tauri\tauri.conf.json"; Pattern = '"version":\s*"[^"]+"';  Replace = { param($v) """version"": ""$v""" } },
    @{ Path = "$root\src-tauri\Cargo.toml";      Pattern = '(?m)^version\s*=\s*"[^"]+"'; Replace = { param($v) "version = ""$v"""   } }
)

# -- Read current version from package.json --
$pkgJson = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$currentVersion = $pkgJson.version
Write-Host ""
Write-Host "  DENOS Version Bump" -ForegroundColor Cyan
Write-Host "  Current version: " -NoNewline
Write-Host "$currentVersion" -ForegroundColor Yellow
Write-Host ""

# -- Get new version --
if (-not $Version) {
    $Version = Read-Host "  Enter new version"
}

$Version = $Version.Trim()

if ($Version -eq $currentVersion) {
    Write-Host "  Version is already $currentVersion -- nothing to do." -ForegroundColor DarkGray
    exit 0
}

# Validate semver-ish format
if ($Version -notmatch '^\d+\.\d+\.\d+(-[\w.]+)?$') {
    Write-Host "  Invalid version format: '$Version'. Expected semver (e.g. 0.3.0)" -ForegroundColor Red
    exit 1
}

# -- Apply changes --
Write-Host ""
foreach ($f in $files) {
    $relPath = $f.Path.Replace($root, "").TrimStart("\")
    $content = Get-Content $f.Path -Raw
    $replacement = & $f.Replace $Version

    if ($content -match $f.Pattern) {
        $content = $content -replace $f.Pattern, $replacement
        Set-Content $f.Path -Value $content -NoNewline
        Write-Host "  Updated " -NoNewline
        Write-Host "$relPath" -ForegroundColor Green
    } else {
        Write-Host "  Skipped " -NoNewline
        Write-Host "$relPath" -ForegroundColor DarkYellow -NoNewline
        Write-Host " (pattern not found)"
    }
}

Write-Host ""
Write-Host "  Done: $currentVersion --> $Version" -ForegroundColor Cyan
Write-Host ""
