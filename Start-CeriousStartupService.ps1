param(
  [int]$CheckSeconds = 10,
  [switch]$NoTray
)

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendHost = if ($env:CERIOUS_BACKEND_HOST) { $env:CERIOUS_BACKEND_HOST } else { "127.0.0.1" }
$BackendPort = if ($env:CERIOUS_BACKEND_PORT) { [int]$env:CERIOUS_BACKEND_PORT } else { 8000 }
$SimulexPort = if ($env:SIMULEX_HTTP_PORT) { [int]$env:SIMULEX_HTTP_PORT } else { 8011 }
$BackendUrl = "http://$($BackendHost):$($BackendPort)"
$SimulexUrl = "http://127.0.0.1:$($SimulexPort)"
$LogPath = Join-Path $Root "cerious-startup-service.log"
$Launcher = Join-Path $Root "Start-CeriousApp.ps1"
$script:ExitRequested = $false
$script:LastStatus = "starting"
$script:LastStartAttempt = [datetime]::MinValue
$script:CeriousIcon = $null

function Write-StartupLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogPath -Value "[$stamp] $Message"
}

function Import-DotEnv {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#") -or !$line.Contains("=")) { return }
    $parts = $line -split "=", 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

function Get-PortProcess {
  param([int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$conn) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

function Stop-RootOwnedPort {
  param([int]$Port)
  $proc = Get-PortProcess -Port $Port
  if (!$proc) { return }
  $cmd = [string]$proc.CommandLine
  if ($cmd -and $cmd.Contains($Root)) {
    Write-StartupLog "Stopping root-owned listener pid=$($proc.ProcessId) on port $Port"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Stop-OrphanNativeChildren {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $cmd = [string]$_.CommandLine
    if (!$cmd -or !$cmd.Contains($Root)) { return $false }
    if ($_.Name -eq "cerious_price_feed.exe") { return $true }
    if ($_.Name -eq "cerious_price_history.exe") { return $true }
    if ($_.Name -eq "cmd.exe" -and $cmd.Contains("cerious_price_feed.exe")) { return $true }
    if ($_.Name -eq "cmd.exe" -and $cmd.Contains("cerious_price_history.exe")) { return $true }
    return $false
  } | ForEach-Object {
    Write-StartupLog "Stopping orphan native child name=$($_.Name) pid=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Json {
  param(
    [string]$Uri,
    [string]$Method = "GET",
    [string]$Body = ""
  )
  try {
    if ($Method -eq "POST") {
      return Invoke-RestMethod -Uri $Uri -Method POST -Body $Body -ContentType "application/json" -TimeoutSec 4
    }
    return Invoke-RestMethod -Uri $Uri -TimeoutSec 4
  } catch {
    return $null
  }
}

function Start-HostServices {
  $now = Get-Date
  if (($now - $script:LastStartAttempt).TotalSeconds -lt 25) {
    Write-StartupLog "Start skipped; previous start attempt still settling"
    return
  }
  $script:LastStartAttempt = $now
  if (!(Test-Path -LiteralPath $Launcher)) {
    Write-StartupLog "ERROR: launcher missing at $Launcher"
    return
  }
  Stop-OrphanNativeChildren
  Write-StartupLog "Starting Cerious native services"
  try {
    Start-Process `
      -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Launcher, "-HostOnly") `
      -WorkingDirectory $Root `
      -WindowStyle Hidden | Out-Null
  } catch {
    Write-StartupLog "ERROR: failed to start services: $($_.Exception.Message)"
  }
}

function Restart-HostServices {
  Write-StartupLog "Restart requested"
  Stop-RootOwnedPort -Port $BackendPort
  Stop-RootOwnedPort -Port $SimulexPort
  Stop-RootOwnedPort -Port 5173
  Start-Sleep -Milliseconds 750
  Start-HostServices
}

function Shutdown-HostServices {
  Write-StartupLog "Shutdown requested"
  Invoke-Json -Uri "$BackendUrl/api/system/shutdown" -Method POST -Body "{}" | Out-Null
  Start-Sleep -Milliseconds 750
  Stop-RootOwnedPort -Port $BackendPort
  Stop-RootOwnedPort -Port $SimulexPort
  Stop-RootOwnedPort -Port 5173
}

function Open-Terminal {
  Start-Process "$BackendUrl/" | Out-Null
}

function New-CeriousIcon {
  Add-Type -AssemblyName System.Drawing
  $candidates = @(
    (Join-Path $Root "assets\branding\cerious-logo.ico"),
    (Join-Path $Root "apps\terminal\public\branding\cerious-logo.ico"),
    (Join-Path $Root "cerious.ico")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return New-Object System.Drawing.Icon($candidate)
    }
  }
  return [System.Drawing.SystemIcons]::Application
}

function Test-Gateway {
  $payload = Invoke-Json -Uri "$BackendUrl/api/health"
  return ($payload -and $payload.ok -eq $true -and $payload.app -eq "cerious-systems" -and $payload.runtime -eq "cpp")
}

function Get-MarketDataStatus {
  return Invoke-Json -Uri "$BackendUrl/api/market-data/status"
}

function Get-ExecutionStatus {
  $payload = Invoke-Json -Uri "$BackendUrl/api/execution/status"
  if ($payload) { return $payload }
  $sim = Invoke-Json -Uri "$SimulexUrl/health"
  return [pscustomobject]@{
    ok = [bool]$sim
    destination = "simulex"
    exchange = "simulex"
    required = $true
    healthy = ($sim -and $sim.ok -eq $true -and $sim.service -eq "simulex.exchange")
  }
}

function Get-ServiceSnapshot {
  $gatewayOk = Test-Gateway
  if (!$gatewayOk) {
    Start-HostServices
    return [pscustomobject]@{
      Status = "starting services"
      GatewayOk = $false
      ExecutionOk = $false
      MarketConnected = $false
      PriceReady = $false
      Detail = "gateway unavailable"
    }
  }

  $execution = Get-ExecutionStatus
  $market = Get-MarketDataStatus
  $executionOk = ($execution -and $execution.healthy -eq $true)
  $marketConnected = ($market -and $market.connected -eq $true)
  $priceReady = ($market -and $market.priceReady -eq $true)
  $marketStatus = if ($market) { [string]$market.status } else { "unknown" }
  $detail = if ($market -and $market.detail) { [string]$market.detail } else { "" }

  if (!$executionOk) {
    Start-HostServices
  }

  $status = if ($gatewayOk -and $executionOk -and $marketConnected -and $priceReady) {
    "connected and price-ready"
  } elseif ($gatewayOk -and $executionOk -and $marketConnected) {
    "connected, waiting for price events"
  } elseif ($gatewayOk -and $executionOk) {
    "services hot, connecting market data ($marketStatus)"
  } else {
    "starting services"
  }

  return [pscustomobject]@{
    Status = $status
    GatewayOk = $gatewayOk
    ExecutionOk = $executionOk
    MarketConnected = $marketConnected
    PriceReady = $priceReady
    Detail = $detail
  }
}

function Set-TrayStatus {
  param(
    [object]$NotifyIcon,
    [object]$Snapshot
  )
  if (!$NotifyIcon) { return }
  $text = "Cerious Startup Service: $($Snapshot.Status)"
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $NotifyIcon.Text = $text
  $NotifyIcon.Icon = $script:CeriousIcon
}

function New-TrayIcon {
  if ($NoTray) { return $null }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $script:CeriousIcon = New-CeriousIcon
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = $script:CeriousIcon
    $notify.Text = "Cerious Startup Service: starting"
    $notify.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $open = $menu.Items.Add("Open Cerious Terminal")
    $restart = $menu.Items.Add("Restart Native Services")
    $shutdown = $menu.Items.Add("Shutdown Native Services")
    $menu.Items.Add("-") | Out-Null
    $exit = $menu.Items.Add("Exit Startup Service")
    $open.add_Click({ Open-Terminal })
    $restart.add_Click({ Restart-HostServices })
    $shutdown.add_Click({ Shutdown-HostServices })
    $exit.add_Click({
      $script:ExitRequested = $true
      Shutdown-HostServices
    })
    $notify.ContextMenuStrip = $menu
    $notify.add_DoubleClick({ Open-Terminal })
    return $notify
  } catch {
    Write-StartupLog "WARN: tray unavailable: $($_.Exception.Message)"
    return $null
  }
}

$mutex = New-Object System.Threading.Mutex($false, "Global\CeriousSystemsStartupService")
$hasLock = $false
$notify = $null

try {
  $hasLock = $mutex.WaitOne(0)
  if (!$hasLock) {
    Write-StartupLog "Startup service already running; exiting duplicate instance"
    return
  }

  Import-DotEnv -Path (Join-Path $Root ".env")
  $notify = New-TrayIcon
  Write-StartupLog "Startup service started root=$Root checkSeconds=$CheckSeconds tray=$([bool]$notify)"

  while (!$script:ExitRequested) {
    $snapshot = Get-ServiceSnapshot
    Set-TrayStatus -NotifyIcon $notify -Snapshot $snapshot
    if ($snapshot.Status -ne $script:LastStatus) {
      Write-StartupLog "Heartbeat status='$($snapshot.Status)' gateway=$($snapshot.GatewayOk) execution=$($snapshot.ExecutionOk) marketData=$($snapshot.MarketConnected) priceReady=$($snapshot.PriceReady) detail='$($snapshot.Detail)'"
      $script:LastStatus = $snapshot.Status
    }
    $sleepUntil = (Get-Date).AddSeconds([Math]::Max(3, $CheckSeconds))
    while ((Get-Date) -lt $sleepUntil -and !$script:ExitRequested) {
      if ($notify) { [System.Windows.Forms.Application]::DoEvents() }
      Start-Sleep -Milliseconds 250
    }
  }
} finally {
  if ($notify) {
    $notify.Visible = $false
    $notify.Dispose()
  }
  if ($script:CeriousIcon) { $script:CeriousIcon.Dispose() }
  if ($hasLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  Write-StartupLog "Startup service stopped"
}
