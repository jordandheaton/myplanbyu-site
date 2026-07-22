# Activates the myplanBYU scraper's Python environment.
#
# The venv lives OUTSIDE OneDrive on purpose: a heavy venv (torch, scipy, ...)
# inside a synced OneDrive folder is what corrupted the old scraper/.venv
# (missing pyvenv.cfg) and also hit Windows' 260-char path limit on install.
#
# Usage (from this scraper folder):
#   . .\activate-venv.ps1
#   python generate_data.py        # or advisor_server.py, embed_and_load.py, ...
#
# Rebuilt 2026-07-17 with Python 3.12.10. To recreate from scratch:
#   py -m venv C:\Users\jorda\venvs\myplan-scraper
#   C:\Users\jorda\venvs\myplan-scraper\Scripts\python.exe -m pip install -r requirements.txt

$venv = "C:\Users\jorda\venvs\myplan-scraper"
if (-not (Test-Path "$venv\Scripts\Activate.ps1")) {
  Write-Warning "Scraper venv not found at $venv. Recreate it (see header of this file)."
  return
}
& "$venv\Scripts\Activate.ps1"
Write-Host "myplanBYU scraper venv active ($venv). Python:" (python --version)
