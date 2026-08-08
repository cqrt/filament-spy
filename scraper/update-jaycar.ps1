# Daily Jaycar refresh: browser-scrape jaycar.co.nz, commit+push if changed.
# The GitHub Action merges data/manual/jaycar.json into the live data on its
# next run. Run via Task Scheduler (see README) or manually.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)  # repo root

node scraper/jaycar-browser.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "jaycar-browser failed ($LASTEXITCODE)"; exit 1 }

git add data/manual/jaycar.json
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host "jaycar.json unchanged"
  exit 0
}
git commit -m "data: jaycar browser refresh [skip ci]" | Out-Host
git pull --rebase -X theirs origin main | Out-Host
git push origin main | Out-Host
Write-Host "jaycar.json pushed"
