param(
  [switch]$NoWarmup,
  [switch]$HostOnly,
  [switch]$StopServicesOnClose
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendHost = if ($env:CERIOUS_BACKEND_HOST) { $env:CERIOUS_BACKEND_HOST } else { "127.0.0.1" }
$BackendPort = if ($env:CERIOUS_BACKEND_PORT) { [int]$env:CERIOUS_BACKEND_PORT } else { 8000 }
$SimulexPort = if ($env:SIMULEX_HTTP_PORT) { [int]$env:SIMULEX_HTTP_PORT } else { 8011 }
$BackendUrl = "http://$($BackendHost):$($BackendPort)"
$SimulexUrl = "http://127.0.0.1:$($SimulexPort)"
$LogPath = Join-Path $Root "cerious-app-launcher.log"
$BackendOut = Join-Path $Root "cerious-backend.out.log"
$BackendErr = Join-Path $Root "cerious-backend.err.log"
$SimulexOut = Join-Path $Root "cerious-simulex.out.log"
$SimulexErr = Join-Path $Root "cerious-simulex.err.log"
$ProfileRoot = Join-Path $Root "data\client-profile"
$ProfileVersion = "cerious-branded-v1"
$script:BrowserProcessName = "chrome.exe"
$script:ProfileDir = Join-Path $ProfileRoot "chrome-$ProfileVersion"

function Write-AppLog {
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
    Write-AppLog "Stopping root-owned listener pid=$($proc.ProcessId) on port $Port"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Test-BackendHealth {
  try {
    $payload = Invoke-RestMethod -Uri "$BackendUrl/api/health" -TimeoutSec 4
    return ($payload -and $payload.ok -eq $true -and $payload.app -eq "cerious-systems" -and $payload.runtime -eq "cpp")
  } catch {
    return $false
  }
}

function Test-SimulexHealth {
  try {
    $payload = Invoke-RestMethod -Uri "$SimulexUrl/health" -TimeoutSec 3
    return ($payload -and $payload.ok -eq $true -and $payload.service -eq "simulex.exchange")
  } catch {
    return $false
  }
}

function Wait-BackendHealth {
  param([int]$Seconds = 75)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-BackendHealth) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-SimulexHealth {
  param([int]$Seconds = 20)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-SimulexHealth) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Find-AppBrowser {
  $chromeCandidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  foreach ($candidate in $chromeCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $script:BrowserProcessName = "chrome.exe"
      $script:ProfileDir = Join-Path $ProfileRoot "chrome-$ProfileVersion"
      return $candidate
    }
  }

  $edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($candidate in $edgeCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $script:BrowserProcessName = "msedge.exe"
      $script:ProfileDir = Join-Path $ProfileRoot "edge-$ProfileVersion"
      return $candidate
    }
  }
  throw "Chrome was not found. Install Chrome or complete the Tauri desktop client build."
}

function Start-Backend {
  $gateway = Join-Path $Root "native\gateway-cpp\build\Release\cerious_gateway.exe"
  if (!(Test-Path -LiteralPath $gateway)) {
    $gateway = Join-Path $Root "native\gateway-cpp\build\cerious_gateway.exe"
  }
  if (!(Test-Path -LiteralPath $gateway)) {
    throw "Native C++ gateway executable not found. Build native\gateway-cpp first."
  }

  if (Test-BackendHealth) {
    $proc = Get-PortProcess -Port $BackendPort
    $cmd = [string]$proc.CommandLine
    if ($cmd -and $cmd.Contains($Root)) {
      Write-AppLog "Backend already healthy on $BackendUrl"
      return
    }
  }

  Stop-RootOwnedPort -Port $BackendPort
  Stop-RootOwnedPort -Port 5173

  Write-AppLog "Starting native C++ gateway on $BackendUrl"
  $quotedRoot = "`"$Root`""
  Start-Process `
    -FilePath $gateway `
    -ArgumentList @("--host", $BackendHost, "--port", "$BackendPort", "--sim-host", "127.0.0.1", "--sim-port", "$SimulexPort", "--root", $quotedRoot) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $BackendOut `
    -RedirectStandardError $BackendErr

  if (!(Wait-BackendHealth -Seconds 90)) {
    throw "Native C++ gateway did not become healthy on $BackendUrl"
  }
}

function Start-Simulex {
  if ($env:CERIOUS_EXECUTION_DESTINATION -and $env:CERIOUS_EXECUTION_DESTINATION.ToLowerInvariant() -ne "simulex") {
    Write-AppLog "Simulex not started because CERIOUS_EXECUTION_DESTINATION=$($env:CERIOUS_EXECUTION_DESTINATION)"
    return
  }

  if (Test-SimulexHealth) {
    Write-AppLog "Simulex already healthy on $SimulexUrl"
    return
  }

  Stop-RootOwnedPort -Port $SimulexPort
  $exe = Join-Path $Root "native\simulex-cpp\build\cerious_simulex_server.exe"
  if (!(Test-Path -LiteralPath $exe)) {
    throw "Simulex executable not found at $exe. Build native\simulex-cpp first."
  }

  Write-AppLog "Starting Simulex on $SimulexUrl"
  Start-Process `
    -FilePath $exe `
    -ArgumentList @("--host", "127.0.0.1", "--port", "$SimulexPort") `
    -WorkingDirectory (Split-Path -Parent $exe) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $SimulexOut `
    -RedirectStandardError $SimulexErr

  if (!(Wait-SimulexHealth -Seconds 25)) {
    throw "Simulex did not become healthy on $SimulexUrl"
  }
}

function Invoke-WarmupRequest {
  param(
    [string]$Url,
    [string]$Log,
    [string]$Username,
    [string]$Password
  )
  function Write-WarmupLog {
    param([string]$Message)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $Log -Value "[$stamp] $Message"
  }
  try {
    $authBody = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
    $auth = Invoke-RestMethod -Uri "$Url/api/auth/login" -Method POST -Body $authBody -ContentType "application/json" -TimeoutSec 10
    $headers = @{
      "Authorization" = "Bearer $($auth.sessionToken)"
      "X-Cerious-Session" = $auth.sessionToken
    }
    $payload = Invoke-RestMethod -Uri "$Url/api/system/warmup?blocking=true&timeout=90" -Method POST -Headers $headers -TimeoutSec 100
    Write-WarmupLog "Warmup completed status=$($payload.status) warmupMs=$($payload.warmupMs)"
  } catch {
    Write-WarmupLog "WARN: warmup did not complete: $($_.Exception.Message)"
  }
}

function Start-Warmup {
  param([switch]$Blocking)
  if ($NoWarmup) { return }
  $username = if ($env:CERIOUS_PORTAL_USERNAME) { $env:CERIOUS_PORTAL_USERNAME } else { "tsturiale" }
  $password = if ($env:CERIOUS_PORTAL_PASSWORD) { $env:CERIOUS_PORTAL_PASSWORD } else { "" }
  if (!$password) {
    Write-AppLog "WARN: warmup skipped: CERIOUS_PORTAL_PASSWORD is not configured"
    return
  }
  Write-AppLog "Starting background warmup"
  if ($Blocking) {
    Invoke-WarmupRequest -Url $BackendUrl -Log $LogPath -Username $username -Password $password
    return
  }
  Start-Job -Name "CeriousWorkspaceWarmup" -ScriptBlock {
    param([string]$Url, [string]$Log, [string]$Username, [string]$Password)
    try {
      $authBody = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
      $auth = Invoke-RestMethod -Uri "$Url/api/auth/login" -Method POST -Body $authBody -ContentType "application/json" -TimeoutSec 10
      $headers = @{
        "Authorization" = "Bearer $($auth.sessionToken)"
        "X-Cerious-Session" = $auth.sessionToken
      }
      $payload = Invoke-RestMethod -Uri "$Url/api/system/warmup?blocking=true&timeout=90" -Method POST -Headers $headers -TimeoutSec 100
      $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
      Add-Content -LiteralPath $Log -Value "[$stamp] Warmup completed status=$($payload.status) warmupMs=$($payload.warmupMs)"
    } catch {
      $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
      Add-Content -LiteralPath $Log -Value "[$stamp] WARN: warmup did not complete: $($_.Exception.Message)"
    }
  } -ArgumentList $BackendUrl, $LogPath, $username, $password | Out-Null
}

function Get-AppBrowserProcesses {
  if (!(Test-Path -LiteralPath $script:ProfileDir)) { return @() }
  $needle = $script:ProfileDir.Replace("\", "\\")
  return @(Get-CimInstance Win32_Process -Filter "Name='$($script:BrowserProcessName)'" -ErrorAction SilentlyContinue | Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -and ($cmd.Contains($script:ProfileDir) -or $cmd.Contains($needle))
  })
}

function Open-AppWindowAndWait {
  $browser = Find-AppBrowser
  New-Item -ItemType Directory -Force -Path $script:ProfileDir | Out-Null
  $launchId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $url = "$BackendUrl/?cerious_view=canvas&cerious_app=desktop&cerious_launch=$launchId"
  Write-AppLog "Opening $($script:BrowserProcessName) app window: $url"
  $started = Start-Process -FilePath $browser -ArgumentList @(
    "--app=$url",
    "--user-data-dir=$($script:ProfileDir)",
    "--no-first-run",
    "--disable-extensions",
    "--disable-features=Translate"
  ) -PassThru

  $seen = $false
  $firstSeenDeadline = (Get-Date).AddSeconds(30)
  while ($true) {
    $running = Get-AppBrowserProcesses
    if ($running.Count -gt 0) {
      $seen = $true
      Start-Sleep -Seconds 2
      continue
    }
    if ($seen) { break }
    if ((Get-Date) -gt $firstSeenDeadline) {
      try {
        if ($started -and !$started.HasExited) {
          Wait-Process -Id $started.Id -ErrorAction SilentlyContinue
        }
      } catch {
        # If the browser handed off to an existing process but the app profile is no longer visible,
        # treat that as a closed app window and let cleanup run.
      }
      $running = Get-AppBrowserProcesses
      if ($running.Count -eq 0) { break }
      $seen = $true
      continue
    }
    Start-Sleep -Seconds 1
  }
  Write-AppLog "App window closed"
}

function Stop-Services {
  Stop-RootOwnedPort -Port $BackendPort
  Stop-RootOwnedPort -Port $SimulexPort
  Stop-RootOwnedPort -Port 5173
}

$mutex = New-Object System.Threading.Mutex($false, "Global\CeriousSystemsAppLauncher")
$hasLock = $false

try {
  $hasLock = $mutex.WaitOne(0)
  if (!$hasLock) {
    Write-AppLog "Another app launcher is already running"
    return
  }
  Import-DotEnv -Path (Join-Path $Root ".env")
  Start-Simulex
  Start-Backend
  Start-Warmup -Blocking:$HostOnly
  if ($HostOnly) {
    Write-AppLog "HostOnly requested; backend remains hot at $BackendUrl"
  } else {
    Open-AppWindowAndWait
  }
} catch {
  Write-AppLog "ERROR: $($_.Exception.Message)"
  throw
} finally {
  if ($StopServicesOnClose) {
    Stop-Services
  } else {
    Write-AppLog "Leaving Cerious services running"
  }
  if ($hasLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
