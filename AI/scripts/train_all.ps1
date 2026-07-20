param(
    [int]$Epochs = 100,
    [int]$Batch = 8,
    [int]$ImageSize = 640,
    [string]$Device = "0",
    [string]$Data = "data\fire_smoke\data.yaml"
)

$ErrorActionPreference = "Stop"
$aiRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $aiRoot ".venv\Scripts\python.exe"
$trainer = Join-Path $PSScriptRoot "train.py"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual environment not found: $python"
}

foreach ($model in @("yolo11n.pt", "yolo11s.pt", "yolo26n.pt")) {
    & $python $trainer --data $Data --model $model --epochs $Epochs --batch $Batch --imgsz $ImageSize --device $Device
    if ($LASTEXITCODE -ne 0) {
        throw "Training failed for $model"
    }
}

