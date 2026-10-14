<#
.SYNOPSIS
    QuizZy Autostart & Background Supervisor Uninstaller.
    Removes autostart shortcuts, scheduled tasks, and terminates running background services.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartupFolder = [Environment]::GetFolderPath("Startup")
$StartupVbs = Join-Path $StartupFolder "QuizZy_Backend_Autostart.vbs"
$LockFile = Join-Path $RepoRoot "backend\supervisor.lock"

Write-Host "===========================================================================" -ForegroundColor Yellow
Write-Host "QuizZy - Removing Silent Windows Background Autostart & Stopping Services" -ForegroundColor Yellow
Write-Host "===========================================================================" -ForegroundColor Yellow

# 1. Remove Startup folder launcher
if (Test-Path $StartupVbs) {
    Remove-Item -Path $StartupVbs -Force -ErrorAction SilentlyContinue
    Write-Host "  -> Removed Startup script: $StartupVbs" -ForegroundColor Green
} else {
    Write-Host "  -> No Startup script found at $StartupVbs."
}

# 2. Unregister Scheduled Task
try {
    $existingTask = Get-ScheduledTask -TaskName "QuizZyBackendAutoStart" -ErrorAction SilentlyContinue
    if ($existingTask) {
        Unregister-ScheduledTask -TaskName "QuizZyBackendAutoStart" -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "  -> Unregistered Scheduled Task 'QuizZyBackendAutoStart'." -ForegroundColor Green
    } else {
        Write-Host "  -> Scheduled Task 'QuizZyBackendAutoStart' not registered."
    }
} catch {
    Write-Host "  -> Scheduled task check skipped."
}

# 3. Terminate supervisor PowerShell instances
Write-Host "  -> Terminating QuizZy supervisor processes..."
if (Test-Path $LockFile) {
    $supPid = Get-Content $LockFile -ErrorAction SilentlyContinue
    if ($supPid) {
        Stop-Process -Id $supPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue
}

# Also search for any PowerShell processes running keep_backend_alive.ps1
try {
    $supProcesses = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*keep_backend_alive.ps1*" }
    foreach ($p in $supProcesses) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

# 4. Terminate process listening on port 8000 (uvicorn)
Write-Host "  -> Terminating backend uvicorn process on port 8000..."
try {
    $conns = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Host "  -> Stopped process on port 8000 (PID: $($c.OwningProcess))." -ForegroundColor Green
        }
    }
} catch {}

Write-Host ""
Write-Host "===========================================================================" -ForegroundColor Green
Write-Host "[SUCCESS] QuizZy autostart removed and all background processes stopped." -ForegroundColor Green
Write-Host "===========================================================================" -ForegroundColor Green
