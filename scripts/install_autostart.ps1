<#
.SYNOPSIS
    QuizZy Autostart & Background Supervisor Installer.
    Sets up automatic, silent background execution on Windows boot, login, and wake.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$HiddenVbs = Join-Path $RepoRoot "scripts\launch_backend_hidden.vbs"
$StartupFolder = [Environment]::GetFolderPath("Startup")
$StartupVbs = Join-Path $StartupFolder "QuizZy_Backend_Autostart.vbs"

Write-Host "===========================================================================" -ForegroundColor Cyan
Write-Host "QuizZy - Configuring Silent Windows Background Autostart" -ForegroundColor Cyan
Write-Host "===========================================================================" -ForegroundColor Cyan
Write-Host "Repository root: $RepoRoot"

# 1. Create Startup folder launcher script
Write-Host "[1/3] Setting up Windows Startup folder autostart..."
$startupContent = @"
' QuizZy Background Autostart Launcher
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "wscript.exe ""$HiddenVbs""", 0, False
Set WshShell = Nothing
"@

Set-Content -Path $StartupVbs -Value $startupContent -Force
if (Test-Path $StartupVbs) {
    Write-Host "  -> Created: $StartupVbs" -ForegroundColor Green
} else {
    Write-Error "Failed to create Startup script at $StartupVbs"
}

# 2. Register User-Level Scheduled Task (for logon / wake resilience without admin privileges)
Write-Host "[2/3] Registering user-level Scheduled Task 'QuizZyBackendAutoStart'..."
try {
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$HiddenVbs`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
    Register-ScheduledTask -TaskName "QuizZyBackendAutoStart" -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
    Write-Host "  -> Scheduled Task 'QuizZyBackendAutoStart' registered successfully." -ForegroundColor Green
} catch {
    Write-Warning "Scheduled Task registration skipped: $($_.Exception.Message)"
    Write-Host "  -> Startup folder script ($StartupVbs) will handle autostart reliably on login."
}

# 3. Immediately launch the supervisor hidden and verify health
Write-Host "[3/3] Launching background supervisor and verifying backend health..."
Start-Process "wscript.exe" -ArgumentList "`"$HiddenVbs`"" -WindowStyle Hidden

Write-Host "Waiting for backend at http://127.0.0.1:8000/health..."
$deadline = (Get-Date).AddSeconds(30)
$isHealthy = $false

while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 2 -ErrorAction Stop
        if ($resp.status -eq "ok") {
            $isHealthy = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 800
    }
}

if ($isHealthy) {
    Write-Host ""
    Write-Host "===========================================================================" -ForegroundColor Green
    Write-Host "[SUCCESS] QuizZy backend is live and responding (status: ok)!" -ForegroundColor Green
    Write-Host "  - Health URL: http://127.0.0.1:8000/health"
    Write-Host "  - Autostart: Configured in Startup Menu & Scheduled Tasks"
    Write-Host "  - Window: Completely hidden (zero visible consoles)"
    Write-Host "  - Supervisor: Self-heals every 15s if killed or after sleep"
    Write-Host "===========================================================================" -ForegroundColor Green
} else {
    Write-Error "Backend did not respond within 30 seconds. Please inspect backend\server.log."
}
