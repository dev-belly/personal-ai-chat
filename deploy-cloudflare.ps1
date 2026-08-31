$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Installing locked dependencies..." -ForegroundColor Cyan
npm ci

Write-Host "Running tests and production builds..." -ForegroundColor Cyan
npm run check

Write-Host "Deploying to Cloudflare Workers..." -ForegroundColor Cyan
Write-Host "Production secrets must already be configured with 'wrangler secret put'." -ForegroundColor Yellow
npm run deploy

Write-Host "Deployment completed." -ForegroundColor Green
