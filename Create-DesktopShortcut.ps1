# Create-DesktopShortcut.ps1 — Creates a Cerious Systems shortcut on the Desktop
# Run this once to set up the desktop icon.

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Cerious Systems.lnk"
$TargetPath = Join-Path $Root "Launch-Cerious.bat"
$IconSource = Join-Path $Root "apps\terminal\src\assets\branding\cerious-logo.png"
$IcoPath = Join-Path $Root "cerious.ico"

# ── Convert PNG to ICO if possible, otherwise use default ──────
$useCustomIcon = $false
if (Test-Path $IconSource) {
  try {
    Add-Type -AssemblyName System.Drawing
    $bitmap = [System.Drawing.Bitmap]::FromFile($IconSource)
    # Resize to 256x256 for icon
    $iconBitmap = New-Object System.Drawing.Bitmap(256, 256)
    $graphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($bitmap, 0, 0, 256, 256)
    $graphics.Dispose()
    $bitmap.Dispose()
    # Save as icon
    $stream = [System.IO.File]::Create($IcoPath)
    $iconBitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream.Close()
    $iconBitmap.Dispose()
    # Actually create a proper ICO file
    $fs = [System.IO.File]::Create($IcoPath)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $pngData = [System.IO.File]::ReadAllBytes($IconSource)
    # ICO header
    $bw.Write([UInt16]0)      # Reserved
    $bw.Write([UInt16]1)      # Type: ICO
    $bw.Write([UInt16]1)      # Count: 1 image
    # ICO directory entry
    $bw.Write([byte]0)        # Width (0 = 256)
    $bw.Write([byte]0)        # Height (0 = 256)
    $bw.Write([byte]0)        # Color palette
    $bw.Write([byte]0)        # Reserved
    $bw.Write([UInt16]1)      # Color planes
    $bw.Write([UInt16]32)     # Bits per pixel
    $bw.Write([UInt32]$pngData.Length) # Size of PNG data
    $bw.Write([UInt32]22)     # Offset to PNG data (6 + 16 = 22)
    # PNG data
    $bw.Write($pngData)
    $bw.Close()
    $fs.Close()
    $useCustomIcon = $true
    Write-Host "Created icon: $IcoPath"
  } catch {
    Write-Host "Could not convert PNG to ICO: $_"
  }
}

# ── Create shortcut ────────────────────────────────────────────
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $TargetPath
$shortcut.WorkingDirectory = $Root
$shortcut.Description = "Launch Cerious Systems Trading Terminal"
$shortcut.WindowStyle = 1  # Normal window
if ($useCustomIcon -and (Test-Path $IcoPath)) {
  $shortcut.IconLocation = "$IcoPath, 0"
} else {
  # Use a trading-themed Windows icon
  $shortcut.IconLocation = "%SystemRoot%\System32\shell32.dll, 21"
}
$shortcut.Save()

Write-Host ""
Write-Host "Desktop shortcut created: $ShortcutPath"
Write-Host "Double-click 'Cerious Systems' on your Desktop to launch."
Write-Host ""
