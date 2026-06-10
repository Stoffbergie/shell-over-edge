import type { SessionMeta } from "../domain/session";
import { agentProtocolVersion, nativeReleaseBaseUrl } from "../shared/config";
import { quotePowerShell } from "../shared/strings";

export function powerShellAgentScript(baseUrl: string, meta: SessionMeta): string {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$SessionId = ${quotePowerShell(meta.code)}
$AgentVersion = ${quotePowerShell(agentProtocolVersion)}
$NativeBaseUrl = if ($env:SOE_NATIVE_BASE_URL) { $env:SOE_NATIVE_BASE_URL } else { ${quotePowerShell(nativeReleaseBaseUrl)} }
$WebRtcBaseUrl = if ($env:SOE_WEBRTC_BASE_URL) { $env:SOE_WEBRTC_BASE_URL } else { $NativeBaseUrl }
$NativePath = Join-Path ([IO.Path]::GetTempPath()) "soe-agent-$SessionId"
$WebRtcPath = Join-Path ([IO.Path]::GetTempPath()) "soe-webrtc-$SessionId.exe"
$WebRtcActivePath = Join-Path ([IO.Path]::GetTempPath()) "soe-webrtc-active-$SessionId"
$UpgradeToNative = $false
$PlatformName = if ($PSVersionTable.Platform) { [string]$PSVersionTable.Platform } else { [string][Environment]::OSVersion.Platform }
$Headers = @{
  "X-Agent-Platform" = $PlatformName
  "X-Agent-User" = [Environment]::UserName
}
$Clipboard = "copied to clipboard"

try {
  Set-Clipboard -Value $SessionId
} catch {
  $Clipboard = "clipboard copy unavailable"
}

function Decode-Base64Text([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Get-ResponseHeader([object]$Response, [string]$Name) {
  if (!$Response -or !$Response.Headers) { return "" }
  if ($Response.Headers.AllKeys) {
    foreach ($Key in $Response.Headers.AllKeys) {
      if ($Key -ieq $Name) { return [string]$Response.Headers[$Key] }
    }
  }
  return ""
}

function Get-ErrorResponse([object]$ErrorRecord) {
  if ($ErrorRecord.Exception.Response) { return $ErrorRecord.Exception.Response }
  if ($ErrorRecord.Exception.InnerException -and $ErrorRecord.Exception.InnerException.Response) {
    return $ErrorRecord.Exception.InnerException.Response
  }
  return $null
}

function Invoke-AgentRequest {
  param([string]$Method, [string]$Path, [string]$OutFile, [byte[]]$Body, [string]$ContentType)
  $Request = [System.Net.WebRequest]::Create("$BaseUrl$Path")
  $Request.Method = $Method
  $Request.Timeout = 35000
  try { $Request.ReadWriteTimeout = 35000 } catch {}
  foreach ($Key in $Headers.Keys) {
    $Request.Headers.Add($Key, [string]$Headers[$Key])
  }
  if ($ContentType) { $Request.ContentType = $ContentType }
  if ($null -ne $Body) {
    $Request.ContentLength = $Body.Length
    if ($Body.Length -gt 0) {
      $RequestStream = $Request.GetRequestStream()
      try {
        $RequestStream.Write($Body, 0, $Body.Length)
      } finally {
        $RequestStream.Close()
      }
    }
  } elseif ($Method -ine "GET") {
    $Request.ContentLength = 0
  }
  try {
    $Response = $Request.GetResponse()
  } catch {
    $ErrorResponse = Get-ErrorResponse $_
    if ($ErrorResponse) {
      $Response = $ErrorResponse
    } else {
      throw
    }
  }
  try {
    $StatusCode = [int]$Response.StatusCode
    if ($OutFile) {
      $Stream = $Response.GetResponseStream()
      $File = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write)
      try {
        if ($Stream) { $Stream.CopyTo($File) }
      } finally {
        $File.Close()
        if ($Stream) { $Stream.Close() }
      }
    }
    return [pscustomobject]@{ StatusCode = $StatusCode; Headers = $Response.Headers }
  } finally {
    $Response.Close()
  }
}

function Send-Bye {
  if ($env:SOE_NO_END_ON_EXIT -eq "1") { return }
  try { Invoke-AgentRequest -Method Post -Path "/api/sessions/$SessionId/end" | Out-Null } catch {}
}

function Start-CommandJob([string]$CommandBody, [string]$Cwd) {
  $Block = {
    param([string]$CommandBody, [string]$Cwd)
    try {
      if ($Cwd) {
        if (!(Test-Path -LiteralPath $Cwd -PathType Container)) {
          [pscustomobject]@{ ExitCode = 1; Output = "Working directory does not exist: $Cwd\`n" }
          return
        }
        Set-Location -LiteralPath $Cwd
      }
      $global:LASTEXITCODE = $null
      $Output = & ([scriptblock]::Create($CommandBody)) *>&1 | Out-String
      $ExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
      [pscustomobject]@{ ExitCode = $ExitCode; Output = $Output }
    } catch {
      [pscustomobject]@{ ExitCode = 1; Output = $_.Exception.Message }
    }
  }
  if (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue) {
    return Start-ThreadJob -ScriptBlock $Block -ArgumentList $CommandBody, $Cwd
  }
  return Start-Job -ScriptBlock $Block -ArgumentList $CommandBody, $Cwd
}

function Run-Command([string]$CommandBody, [string]$Cwd, [string]$ResultFile, [int]$TimeoutSeconds) {
  if ($TimeoutSeconds -lt 1) { $TimeoutSeconds = 900 }
  $Job = $null
  try {
    $Job = Start-CommandJob -CommandBody $CommandBody -Cwd $Cwd
    if (Wait-Job $Job -Timeout $TimeoutSeconds) {
      $Results = @(Receive-Job $Job)
      $Result = $Results | Select-Object -Last 1
      if (!$Result) {
        [IO.File]::WriteAllText($ResultFile, "")
        return 0
      }
      [IO.File]::WriteAllText($ResultFile, [string]$Result.Output)
      return [int]$Result.ExitCode
    }
    Stop-Job $Job -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($ResultFile, "Command timed out after $TimeoutSeconds seconds\`n")
    return 124
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  } finally {
    if ($Job) { Remove-Job $Job -ErrorAction SilentlyContinue }
  }
}

function Test-AgentCommand([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NativeName {
  $Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    if ($Architecture -eq "arm64") { return "soe-agent-aarch64-windows.exe" }
    if ($Architecture -eq "x64") { return "soe-agent-x86_64-windows.exe" }
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::OSX)) {
    if ($Architecture -eq "arm64") { return "soe-agent-aarch64-macos" }
    if ($Architecture -eq "x64") { return "soe-agent-x86_64-macos" }
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Linux)) {
    if ($Architecture -eq "arm64") { return "soe-agent-aarch64-linux-musl" }
    if ($Architecture -eq "x64") { return "soe-agent-x86_64-linux-musl" }
  }
  return ""
}

function Get-WebRtcName {
  $Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    if ($Architecture -eq "arm64") { return "soe-webrtc-aarch64-windows.exe" }
    if ($Architecture -eq "x64") { return "soe-webrtc-x86_64-windows.exe" }
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::OSX)) {
    if ($Architecture -eq "arm64") { return "soe-webrtc-aarch64-macos" }
    if ($Architecture -eq "x64") { return "soe-webrtc-x86_64-macos" }
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Linux)) {
    if ($Architecture -eq "arm64") { return "soe-webrtc-aarch64-linux" }
    if ($Architecture -eq "x64") { return "soe-webrtc-x86_64-linux" }
  }
  return ""
}

function Start-NativeDownload {
  $Name = Get-NativeName
  if (!$Name -and !$env:SOE_NATIVE_URL) { return $false }
  $Url = if ($env:SOE_NATIVE_URL) { $env:SOE_NATIVE_URL } else { "$NativeBaseUrl/$Name" }
  try {
    Invoke-WebRequest -Uri $Url -OutFile "$NativePath.tmp" -UseBasicParsing -TimeoutSec 40
    Move-Item "$NativePath.tmp" $NativePath -Force
    if (![Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
      & chmod +x $NativePath 2>$null
    }
    return Test-Path -LiteralPath $NativePath -PathType Leaf
  } catch {
    return $false
  }
}

function Start-WebRtcDriver {
  $Name = Get-WebRtcName
  if (!$Name -and !$env:SOE_WEBRTC_URL) { return $false }
  $Url = if ($env:SOE_WEBRTC_URL) { $env:SOE_WEBRTC_URL } else { "$WebRtcBaseUrl/$Name" }
  try {
    if (!(Test-Path -LiteralPath $WebRtcPath -PathType Leaf)) {
      Invoke-WebRequest -Uri $Url -OutFile "$WebRtcPath.tmp" -UseBasicParsing -TimeoutSec 40
      Move-Item "$WebRtcPath.tmp" $WebRtcPath -Force
      if (![Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
        & chmod +x $WebRtcPath 2>$null
      }
    }
    Start-Process -FilePath $WebRtcPath -ArgumentList @("agent", "--base-url", $BaseUrl, "--session", $SessionId) | Out-Null
    Set-Content -LiteralPath $WebRtcActivePath -Value "1"
    return $true
  } catch {
    return $false
  }
}

function Get-BaseUrlLatencyMs {
  try {
    $Watch = [Diagnostics.Stopwatch]::StartNew()
    Invoke-AgentRequest -Method Get -Path "/a" | Out-Null
    $Watch.Stop()
    return [int]$Watch.Elapsed.TotalMilliseconds
  } catch {
    return $null
  }
}

function Get-PrivateIps {
  try {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -ExpandProperty IPAddress) -join ","
  } catch {
    try {
      return @([Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $_.ToString() -notlike "127.*" } | ForEach-Object { $_.ToString() }) -join ","
    } catch {
      return ""
    }
  }
}

function Get-ProbeJson {
  $NativeSupported = ![string]::IsNullOrWhiteSpace((Get-NativeName))
  $WebRtcSupported = ![string]::IsNullOrWhiteSpace((Get-WebRtcName))
  $ActiveTransport = if (Test-Path -LiteralPath $WebRtcActivePath -PathType Leaf) { "webrtc" } else { "relay" }
  $CpuName = ""
  $MemoryBytes = $null
  try { $CpuName = (Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Name) } catch {}
  try { $MemoryBytes = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory } catch {}
  $Payload = [ordered]@{
    session = $SessionId
    agent = [ordered]@{ kind = "powershell"; version = $AgentVersion; pid = $PID }
    os = [ordered]@{
      name = [Runtime.InteropServices.RuntimeInformation]::OSDescription
      version = [Environment]::OSVersion.VersionString
      arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    hardware = [ordered]@{
      cpu = $CpuName
      cores = [Environment]::ProcessorCount
      memoryBytes = $MemoryBytes
    }
    runtime = [ordered]@{
      shell = "powershell"
      cwd = (Get-Location).Path
      user = [Environment]::UserName
      hostname = [Environment]::MachineName
      commands = [ordered]@{
        curl = Test-AgentCommand "curl"
        powershell = $true
        pwsh = Test-AgentCommand "pwsh"
        python3 = Test-AgentCommand "python3"
        node = Test-AgentCommand "node"
        bun = Test-AgentCommand "bun"
      }
    }
    network = [ordered]@{
      baseUrl = $BaseUrl
      baseUrlLatencyMs = Get-BaseUrlLatencyMs
      privateIps = Get-PrivateIps
    }
    supports = [ordered]@{
      relay = $true
      native = $NativeSupported
      directHttp = $false
      webrtc = $WebRtcSupported
      webrtcSignaling = $true
    }
    activeTransport = $ActiveTransport
  }
  return ($Payload | ConvertTo-Json -Depth 8 -Compress)
}

function Get-ConfigJson([string]$Requested) {
  $Mode = if ([string]::IsNullOrWhiteSpace($Requested)) { "auto" } else { $Requested.Trim().ToLowerInvariant() }
  if ($Mode -eq "auto" -or $Mode -eq "native") {
    if (Start-NativeDownload) {
      $script:UpgradeToNative = $true
      return (@{ ok = $true; requested = $Mode; active = "native"; upgraded = $true; fallback = $false; reason = "native agent downloaded and will take over after this response" } | ConvertTo-Json -Compress)
    }
    return (@{ ok = $true; requested = $Mode; active = "relay"; upgraded = $false; fallback = $true; reason = "native agent is not available on this machine" } | ConvertTo-Json -Compress)
  }
  if ($Mode -eq "relay") {
    return (@{ ok = $true; requested = "relay"; active = "relay"; upgraded = $false; fallback = $false; reason = "relay is already active" } | ConvertTo-Json -Compress)
  }
  if ($Mode -eq "direct") {
    if (Start-NativeDownload) {
      $script:UpgradeToNative = $true
      return (@{ ok = $true; requested = "direct"; active = "native"; upgraded = $true; fallback = $true; reason = "native driver downloaded; direct HTTP listener is not enabled yet" } | ConvertTo-Json -Compress)
    }
    return (@{ ok = $true; requested = "direct"; active = "relay"; upgraded = $false; fallback = $true; reason = "this PowerShell agent does not run a direct HTTP listener yet" } | ConvertTo-Json -Compress)
  }
  if ($Mode -eq "webrtc") {
    if (Start-WebRtcDriver) {
      return (@{ ok = $true; requested = "webrtc"; active = "webrtc"; upgraded = $true; fallback = $false; reason = "WebRTC sidecar started; relay remains available as fallback" } | ConvertTo-Json -Compress)
    }
    return (@{ ok = $true; requested = "webrtc"; active = "relay"; upgraded = $false; fallback = $true; reason = "WebRTC sidecar is not available on this machine" } | ConvertTo-Json -Compress)
  }
  return (@{ ok = $false; requested = $Mode; active = "relay"; upgraded = $false; fallback = $true; reason = "unsupported transport" } | ConvertTo-Json -Compress)
}

Write-Host "Session: $SessionId ($Clipboard)"
Write-Host "Stop anytime: Ctrl+C"

try { [Console]::TreatControlCAsInput = $false } catch {}
try {
  Invoke-AgentRequest -Method Post -Path "/api/sessions/$SessionId/hello" -Body ([Text.Encoding]::UTF8.GetBytes((Get-Location).Path)) -ContentType "text/plain" | Out-Null
  while ($true) {
    $BodyFile = [IO.Path]::GetTempFileName()
    $ResultFile = [IO.Path]::GetTempFileName()
    $Response = Invoke-AgentRequest -Method Get -Path "/api/sessions/$SessionId/next" -OutFile $BodyFile
    $StatusCode = [int]$Response.StatusCode
    if ($StatusCode -eq 204) {
      Remove-Item $BodyFile, $ResultFile -Force
      continue
    }
    if ($StatusCode -eq 410 -or $StatusCode -eq 401 -or $StatusCode -eq 404) {
      Remove-Item $BodyFile, $ResultFile -Force
      break
    }
    if ($StatusCode -ne 200) {
      if (Test-Path $BodyFile) { Get-Content $BodyFile -Raw | Write-Host }
      Remove-Item $BodyFile, $ResultFile -Force
      Start-Sleep -Seconds 1
      continue
    }
    $CommandId = Get-ResponseHeader $Response "X-Command-Id"
    $CommandType = Get-ResponseHeader $Response "X-Command-Type"
    if ([string]::IsNullOrWhiteSpace($CommandType)) { $CommandType = "shell" }
    $Cwd = Decode-Base64Text (Get-ResponseHeader $Response "X-Command-Cwd-Base64")
    $TimeoutSeconds = [int](Get-ResponseHeader $Response "X-Command-Timeout")
    if ($TimeoutSeconds -lt 1) { $TimeoutSeconds = 900 }
    $CommandBody = Get-Content $BodyFile -Raw
    if ($CommandType -eq "shell") {
      $ExitCode = Run-Command -CommandBody $CommandBody -Cwd $Cwd -ResultFile $ResultFile -TimeoutSeconds $TimeoutSeconds
    } elseif ($CommandType -eq "probe") {
      [IO.File]::WriteAllText($ResultFile, (Get-ProbeJson))
      $ExitCode = 0
    } elseif ($CommandType -eq "config") {
      [IO.File]::WriteAllText($ResultFile, (Get-ConfigJson $CommandBody))
      $ExitCode = 0
    } else {
      [IO.File]::WriteAllText($ResultFile, (@{ ok = $false; reason = "unsupported command type" } | ConvertTo-Json -Compress))
      $ExitCode = 1
    }
    Invoke-AgentRequest -Method Post -Path "/api/sessions/$SessionId/result/\${CommandId}?exit=$ExitCode" -Body ([IO.File]::ReadAllBytes($ResultFile)) -ContentType "application/octet-stream" | Out-Null
    Remove-Item $BodyFile, $ResultFile -Force
    if ($UpgradeToNative -and (Test-Path -LiteralPath $NativePath -PathType Leaf)) {
      $env:SOE_NO_END_ON_EXIT = "1"
      & $NativePath --base-url $BaseUrl --session $SessionId
      break
    }
  }
} finally {
  Send-Bye
}
`;
}
