# Ghanipur — one-command startup for Windows.
#   Right-click > Run with PowerShell, or:  ./run.ps1        (start everything)
#   ./run.ps1 -Seed     also loads demo data (super admin, demo shop, products)
#   ./run.ps1 -Stop     stop the app
param([switch]$Seed, [switch]$Stop)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if ($Stop) { docker compose down; Write-Host "Ghanipur stopped." -ForegroundColor Yellow; exit 0 }

$dd = "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# Check the engine with a hard timeout so a HUNG engine (500s / frozen API) is
# detected too, not just a stopped one.
function Test-DockerReady {
  $job = Start-Job { docker version --format '{{.Server.Version}}' 2>$null }
  $ok = Wait-Job $job -Timeout 12
  $out = if ($ok) { Receive-Job $job } else { $null }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  return [bool]$out
}

function Reset-DockerEngine {
  Write-Host "Resetting the Docker engine (stop + wsl shutdown + relaunch)..." -ForegroundColor Yellow
  foreach ($n in 'Docker Desktop','com.docker.backend','com.docker.build','vpnkit','com.docker.proxy') {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 4
  try { wsl --shutdown 2>$null } catch {}
  Start-Sleep -Seconds 3
  if (Test-Path $dd) { Start-Process $dd }
}

# 1) Ensure the engine is responsive; recover a stopped OR hung engine.
if (-not (Test-DockerReady)) {
  if (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue) {
    Reset-DockerEngine            # running but hung -> full reset
  } elseif (Test-Path $dd) {
    Write-Host "Docker engine is down — starting Docker Desktop..." -ForegroundColor Yellow
    Start-Process $dd             # not running -> just start
  }
  $deadline = (Get-Date).AddMinutes(3)
  do { Start-Sleep -Seconds 4 } until ((Test-DockerReady) -or (Get-Date) -gt $deadline)
  if (-not (Test-DockerReady)) { Write-Host "Docker did not come up in time. Open Docker Desktop manually, then re-run." -ForegroundColor Red; exit 1 }
}
Write-Host "Docker engine is up." -ForegroundColor Green

# 2) Free ports 3000/5000 if a stray host process (e.g. a leftover 'next dev') holds them.
foreach ($port in 3000, 5000) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') {
      Write-Host "Freeing port $port (stopping stray node PID $($c.OwningProcess))..." -ForegroundColor Yellow
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

# 3) Start the stack.
Write-Host "Starting Ghanipur..." -ForegroundColor Cyan
docker compose up -d

# 4) Wait for the API to be ready.
$deadline = (Get-Date).AddMinutes(2)
do {
  Start-Sleep -Seconds 2
  try { $r = Invoke-WebRequest -Uri http://localhost:5000/health/ready -UseBasicParsing -TimeoutSec 4; $ok = $r.StatusCode -eq 200 } catch { $ok = $false }
} until ($ok -or (Get-Date) -gt $deadline)

# 5) Optionally seed demo data.
if ($Seed) {
  Write-Host "Seeding demo data..." -ForegroundColor Cyan
  docker compose exec -e ALLOW_SEED=true backend node dist/scripts/seed.js
}

Write-Host ""
Write-Host "✅ Ghanipur is running:" -ForegroundColor Green
Write-Host "   Web:  http://localhost:3000"
Write-Host "   API:  http://localhost:5000"
Write-Host "   Super Admin: superadmin@ghanipur.test / password123"
Write-Host "   Shop Admin:  admin@ghanipur.test / password123"
Write-Host "   (If a page looks old, hard-refresh with Ctrl+Shift+R)"
