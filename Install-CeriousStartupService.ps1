param(
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupService = Join-Path $Root "Start-CeriousStartupService.ps1"
$TaskName = "Cerious Systems Startup Service"
$LegacyTaskName = "Cerious Systems " + "G" + "uardian"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupServiceVbs = Join-Path $Root "Launch-CeriousStartupService.vbs"
$StartupShortcut = Join-Path $StartupDir "Cerious Systems Startup Service.lnk"
$LegacyShortcut = Join-Path $StartupDir ($LegacyTaskName + ".lnk")

if (!(Test-Path -LiteralPath $StartupService)) {
  throw "Startup service script not found at $StartupService"
}

Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Remove-Item -LiteralPath $LegacyShortcut -Force -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-STA -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartupService`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$installMode = "scheduled-task"
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Starts and monitors the Cerious native gateway, market data session, and selected exchange session." `
    -Force | Out-Null

  if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
  }
} catch {
  $installMode = "startup-shortcut"
  $escapedStartupService = $StartupService.Replace('"', '""')
  $vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -STA -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$escapedStartupService""", 0, False
"@
  Set-Content -LiteralPath $StartupServiceVbs -Value $vbs -Encoding ASCII
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($StartupShortcut)
  $shortcut.TargetPath = "wscript.exe"
  $shortcut.Arguments = "`"$StartupServiceVbs`""
  $shortcut.WorkingDirectory = $Root
  $ico = Join-Path $Root "assets\branding\cerious-logo.ico"
  if (Test-Path -LiteralPath $ico) { $shortcut.IconLocation = $ico }
  $shortcut.Save()
  if ($RunNow) {
    Start-Process -FilePath "wscript.exe" -ArgumentList @("`"$StartupServiceVbs`"") -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  }
}

[pscustomobject]@{
  ok = $true
  mode = $installMode
  taskName = $TaskName
  startupService = $StartupService
  startupShortcut = if (Test-Path -LiteralPath $StartupShortcut) { $StartupShortcut } else { $null }
  runNow = [bool]$RunNow
}
