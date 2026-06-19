param(
  [switch]$InstallShortcut
)

$ErrorActionPreference = "Stop"

function Resolve-CeriousRoot {
  $packageParent = Split-Path -Parent $PSScriptRoot
  $candidates = @(
    $env:CERIOUS_SYSTEMS_ROOT,
    (Join-Path $packageParent "Cerious local"),
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -First 1)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($candidate in $candidates) {
    $launcher = Join-Path $candidate "Start-CeriousApp.ps1"
    if (Test-Path -LiteralPath $launcher) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Cerious Systems root was not found. Set CERIOUS_SYSTEMS_ROOT to the install directory."
}

function Install-DesktopShortcut {
  param([string]$ScriptPath)
  $desktop = [Environment]::GetFolderPath("DesktopDirectory")
  $shortcutPath = Join-Path $desktop "Cerious Systems.lnk"
  $root = Resolve-CeriousRoot
  $launcher = Join-Path $root "Launch-Cerious.vbs"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = (Join-Path $env:WINDIR "System32\wscript.exe")
  $shortcut.Arguments = "`"$launcher`""
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = "Launch Cerious Systems Terminal"
  $ico = Join-Path $root "assets\branding\cerious-logo.ico"
  if (!(Test-Path -LiteralPath $ico)) {
    $ico = Join-Path $root "apps\terminal\public\branding\cerious-logo.ico"
  }
  if (!(Test-Path -LiteralPath $ico)) {
    $ico = Join-Path $root "cerious.ico"
  }
  if (Test-Path -LiteralPath $ico) {
    $shortcut.IconLocation = "$ico, 0"
  }
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  Write-Host "Shortcut installed: $shortcutPath"
}

$root = Resolve-CeriousRoot
$launcher = Join-Path $root "Start-CeriousApp.ps1"

if ($InstallShortcut) {
  Install-DesktopShortcut -ScriptPath $PSCommandPath
}

Start-Process -FilePath "powershell.exe" -WorkingDirectory $root -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "`"$launcher`""
) -WindowStyle Hidden

Write-Host "Cerious Systems app launch requested."
