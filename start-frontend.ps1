Set-Location $PSScriptRoot

if (-not (Test-Path (Join-Path $PSScriptRoot "index.html"))) {
    throw "index.html was not found in the project root."
}

py -3 -m http.server 8000 --bind 0.0.0.0
