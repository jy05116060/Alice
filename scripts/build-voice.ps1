# Build whisper_server.py into a standalone directory using PyInstaller.
# Output: voice-dist/ at project root, picked up by electron-builder as extraResources.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-voice.ps1
#
# Run this before `npm run build`. The build script calls it automatically.

$ErrorActionPreference = 'Stop'

$scriptRoot  = $PSScriptRoot
$projectRoot = Join-Path $scriptRoot ".."
$voiceDir    = Join-Path $projectRoot "src\voice"
$voiceDist   = Join-Path $projectRoot "voice-dist"

Write-Host "[build-voice] Installing PyInstaller..." -ForegroundColor Cyan
pip install pyinstaller --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }

Write-Host "[build-voice] Running PyInstaller (this takes a few minutes)..." -ForegroundColor Cyan
Push-Location $voiceDir
try {
    pyinstaller `
        --noconfirm `
        --clean `
        --onedir `
        --name whisper_server `
        --collect-all whisper `
        --collect-all tiktoken `
        --hidden-import "websockets.server" `
        --hidden-import "websockets.legacy" `
        --hidden-import "websockets.legacy.server" `
        --hidden-import "tiktoken_ext" `
        --hidden-import "tiktoken_ext.openai_public" `
        --hidden-import "tqdm" `
        --hidden-import "tqdm.auto" `
        --hidden-import "numpy" `
        --hidden-import "numpy.core._methods" `
        --exclude-module "matplotlib" `
        --exclude-module "PIL" `
        --exclude-module "IPython" `
        --exclude-module "tensorflow" `
        --exclude-module "tensorflow_hub" `
        --exclude-module "jupyter" `
        --exclude-module "notebook" `
        whisper_server.py

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

    Write-Host "[build-voice] Moving output to voice-dist/..." -ForegroundColor Cyan
    if (Test-Path $voiceDist) { Remove-Item $voiceDist -Recurse -Force }
    Move-Item (Join-Path $voiceDir "dist\whisper_server") $voiceDist

    Write-Host "[build-voice] Done: $voiceDist" -ForegroundColor Green
} finally {
    # Clean up PyInstaller build artifacts
    $buildDir = Join-Path $voiceDir "build"
    $distDir  = Join-Path $voiceDir "dist"
    $specFile = Join-Path $voiceDir "whisper_server.spec"
    if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
    if (Test-Path $distDir)  { Remove-Item $distDir  -Recurse -Force }
    if (Test-Path $specFile) { Remove-Item $specFile }
    Pop-Location
}
