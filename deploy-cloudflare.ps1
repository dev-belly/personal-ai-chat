$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Installing locked dependencies..." -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed (exit $LASTEXITCODE)." }

Write-Host "Running tests and production builds..." -ForegroundColor Cyan
npm run check
if ($LASTEXITCODE -ne 0) { throw "Project checks failed (exit $LASTEXITCODE)." }

Write-Host "Deploying to Cloudflare Workers..." -ForegroundColor Cyan
Write-Host "Production secrets must already be configured with 'wrangler secret put'." -ForegroundColor Yellow
npm run deploy
if ($LASTEXITCODE -ne 0) { throw "Cloudflare deployment failed (exit $LASTEXITCODE)." }

Write-Host "Deployment completed." -ForegroundColor Green
