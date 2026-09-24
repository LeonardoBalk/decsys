Set-Location $PSScriptRoot
if (-not (Test-Path '.\node_modules')) {
  Write-Host 'Instalando dependências da interface...'
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm install } else { npm install }
}
npm run dev
