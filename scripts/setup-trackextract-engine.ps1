[CmdletBinding()]
param(
    [ValidateSet("cpu", "gpu", "dml")]
    [string] $Runtime = $(if ($env:TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA) {
        $env:TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA
    } else {
        "cpu"
    }),
    [string] $Python = "python"
)

$ErrorActionPreference = "Stop"
$rootDirectory = Split-Path -Parent $PSScriptRoot
$venvDirectory = if ($env:TRACKEXTRACT_ENGINE_VENV) {
    $env:TRACKEXTRACT_ENGINE_VENV
} else {
    Join-Path $rootDirectory ".venv-trackextract-engine"
}
$venvPython = Join-Path $venvDirectory "Scripts\python.exe"

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string] $Executable,
        [Parameter(ValueFromRemainingArguments)]
        [string[]] $Arguments
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable exited with code $LASTEXITCODE"
    }
}

if (!(Test-Path -LiteralPath $venvPython)) {
    Write-Host "Creating Track Extract Python engine environment at $venvDirectory"
    Invoke-Checked $Python -m venv $venvDirectory
}

Invoke-Checked $venvPython -m pip install --upgrade pip wheel

if ($Runtime -eq "gpu") {
    # PyPI's Windows torch package is CPU-only. Install the aligned CUDA wheels
    # explicitly before resolving the engine's remaining provider dependencies.
    Invoke-Checked $venvPython -m pip install --upgrade `
        torch==2.7.1 torchvision==0.22.1 torchaudio==2.7.1 `
        --index-url https://download.pytorch.org/whl/cu118
}

$engineExtra = Join-Path $rootDirectory "engine[runtime-$Runtime]"
$installArguments = @("-m", "pip", "install", "-e", $engineExtra)
if ($Runtime -eq "gpu") {
    $installArguments += @(
        "--constraint",
        (Join-Path $rootDirectory "engine\constraints-runtime-gpu.txt")
    )
}
Invoke-Checked $venvPython @installArguments
Invoke-Checked $venvPython (Join-Path $PSScriptRoot "probe-trackextract-runtime.py") --expect $Runtime

Write-Host ""
Write-Host "Track Extract $Runtime runtime is ready."
Write-Host "Interpreter: $venvPython"
