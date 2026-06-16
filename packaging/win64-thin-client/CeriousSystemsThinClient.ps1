param(
  [switch]$InstallShortcut
)

$ErrorActionPreference = "Stop"

function Resolve-CeriousRoot {
  $candidates = @(
    $env:CERIOUS_SYSTEMS_ROOT,
    "C:\Users\tstur\Documents\Codex\2026-06-10\Cerious Systems",
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -First 1)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($candidate in $candidates) {
    $launcher = Join-Path $candidate "Start-CeriousTerminal.ps1"
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
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $shortcut.WorkingDirectory = Split-Path -Parent $ScriptPath
  $shortcut.Description = "Launch Cerious Systems Terminal"
  $shortcut.Save()
  Write-Host "Shortcut installed: $shortcutPath"
}

$root = Resolve-CeriousRoot
$launcher = Join-Path $root "Start-CeriousTerminal.ps1"

if ($InstallShortcut) {
  Install-DesktopShortcut -ScriptPath $PSCommandPath
}

Start-Process -FilePath "powershell.exe" -WorkingDirectory $root -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$launcher`"",
  "-DesktopClient"
) -WindowStyle Hidden

Write-Host "Cerious Systems desktop client launch requested."
