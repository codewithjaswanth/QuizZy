<#
.SYNOPSIS
    QuizZy FastAPI Backend Supervisor.
    Keeps the backend running silently on http://127.0.0.1:8000.
    Self-heals if killed or after laptop sleep/wake cycles.
#>

[CmdletBinding()]
param()

# 1. Resolve and set repo root
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$LockFile = Join-Path $RepoRoot "backend\supervisor.lock"
$LogFile  = Join-Path $RepoRoot "backend\server.log"
$ErrFile  = Join-Path $RepoRoot "backend\server.err.log"
$PythonW  = Join-Path $RepoRoot ".venv\Scripts\pythonw.exe"
$HealthUrl = "http://127.0.0.1:8000/health"

# Ensure backend directory exists
$backendDir = Join-Path $RepoRoot "backend"
if (-not (Test-Path $backendDir)) {
    New-Item -ItemType Directory -Path $backendDir -Force | Out-Null
}

# 2. Single-Instance Guard: Check if another supervisor is active
if (Test-Path $LockFile) {
    try {
        $existingPid = Get-Content $LockFile -ErrorAction SilentlyContinue
        if ($existingPid) {
            $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match "powershell") {
                try {
                    $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3 -ErrorAction Stop
                    if ($resp.status -eq "ok") {
                        # Supervisor running and healthy - exit cleanly without duplicating loops
                        exit 0
                    }
                } catch {
                    # Process exists but backend unhealthy; continue and take over
                }
            }
        }
    } catch {}
}

# Register our PID in lockfile
$PID | Set-Content -Path $LockFile -Force

# Helper: Test backend health endpoint
function Test-BackendHealth {
    try {
        $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3 -ErrorAction Stop
        return ($resp.status -eq "ok")
    } catch {
        return $false
    }
}

# Helper: Log rotation (truncate if > 5 MB, keeping last 1000 lines)
function Check-LogRotation {
    foreach ($file in @($LogFile, $ErrFile)) {
        if (Test-Path $file) {
            try {
                $item = Get-Item $file
                if ($item.Length -gt 5MB) {
                    $tail = Get-Content -Path $file -Tail 1000 -ErrorAction SilentlyContinue
                    $tail | Set-Content -Path $file -Force
                }
            } catch {}
        }
    }
}

# Helper: Clean up any stale process blocking port 8000
function Stop-StalePortProcess {
    try {
        $conns = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            foreach ($c in $conns) {
                if ($c.OwningProcess -and $c.OwningProcess -ne $PID) {
                    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {}
}

# Helper: Launch uvicorn via pythonw.exe completely windowless
function Start-BackendProcess {
    Check-LogRotation
    Stop-StalePortProcess
    
    $argsList = @(
        "-m", "uvicorn", "backend.app:app",
        "--host", "127.0.0.1",
        "--port", "8000"
    )
    
    Start-Process -FilePath $PythonW `
                  -ArgumentList $argsList `
                  -WorkingDirectory $RepoRoot `
                  -WindowStyle Hidden `
                  -RedirectStandardOutput $LogFile `
                  -RedirectStandardError $ErrFile
}

# 3. Initial check / startup
if (-not (Test-BackendHealth)) {
    Start-BackendProcess
    
    # Wait up to 10 seconds for initial initialization
    $initWait = 0
    while ($initWait -lt 10) {
        Start-Sleep -Seconds 1
        if (Test-BackendHealth) { break }
        $initWait++
    }
}

# 4. Infinite Self-Healing Supervisor Loop (checks every 15 seconds)
while ($true) {
    try {
        if (-not (Test-BackendHealth)) {
            Start-BackendProcess
            
            # Allow up to 10 seconds to recover
            $recoverWait = 0
            while ($recoverWait -lt 10) {
                Start-Sleep -Seconds 1
                if (Test-BackendHealth) { break }
                $recoverWait++
            }
        }
    } catch {}
    
    Start-Sleep -Seconds 15
}
