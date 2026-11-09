Set-Location $PSScriptRoot\backend
py -3 -m pip install -r requirements.txt
py -3 app.py
