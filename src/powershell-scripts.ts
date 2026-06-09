import { quotePowerShell } from "./strings";
import type { SessionMeta } from "./types";

export function powerShellAgentScript(baseUrl: string, meta: SessionMeta): string {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$SessionId = ${quotePowerShell(meta.id)}
$Expires = ${quotePowerShell(new Date(meta.expiresAt).toISOString())}
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
  $Value = $Response.Headers[$Name]
  if ($Value) { return [string]$Value }
  if ($Response.Headers.AllKeys) {
    foreach ($Key in $Response.Headers.AllKeys) {
      if ($Key -ieq $Name) { return [string]$Response.Headers[$Key] }
    }
  }
  if ($Response.Headers.Keys) {
    foreach ($Key in $Response.Headers.Keys) {
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

function Invoke-AgentDownload {
  param([string]$Method, [string]$Path, [string]$OutFile)
  $Request = [System.Net.WebRequest]::Create("$BaseUrl$Path")
  $Request.Method = $Method
  foreach ($Key in $Headers.Keys) {
    $Request.Headers.Add($Key, [string]$Headers[$Key])
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
    if ($StatusCode -eq 204) {
      [IO.File]::WriteAllBytes($OutFile, [byte[]]@())
      return [pscustomobject]@{ StatusCode = $StatusCode; Headers = $Response.Headers }
    }
    $Stream = $Response.GetResponseStream()
    $File = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write)
    try {
      if ($Stream) { $Stream.CopyTo($File) }
    } finally {
      $File.Close()
      if ($Stream) { $Stream.Close() }
    }
    return [pscustomobject]@{ StatusCode = $StatusCode; Headers = $Response.Headers }
  } finally {
    $Response.Close()
  }
}

function Invoke-AgentRequest {
  param([string]$Method, [string]$Path, [string]$OutFile, [object]$Body, [string]$ContentType)
  if ($OutFile) { return Invoke-AgentDownload -Method $Method -Path $Path -OutFile $OutFile }
  $Parameters = @{
    Uri = "$BaseUrl$Path"
    Method = $Method
    Headers = $Headers
    UseBasicParsing = $true
  }
  if ($OutFile) { $Parameters.OutFile = $OutFile }
  if ($null -ne $Body) { $Parameters.Body = $Body }
  if ($ContentType) { $Parameters.ContentType = $ContentType }
  try {
    return Invoke-WebRequest @Parameters
  } catch {
    $ErrorResponse = Get-ErrorResponse $_
    if ($ErrorResponse) { return $ErrorResponse }
    throw
  }
}

function Send-Bye {
  try { Invoke-AgentRequest -Method Post -Path "/api/sessions/$SessionId/end" | Out-Null } catch {}
}

function Run-Command([string]$CommandBody, [string]$Cwd, [string]$ResultFile) {
  $Previous = Get-Location
  try {
    if ($Cwd) { Set-Location $Cwd }
    $Output = & ([scriptblock]::Create($CommandBody)) *>&1 | Out-String
    $ExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
    [IO.File]::WriteAllText($ResultFile, $Output)
    return $ExitCode
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  } finally {
    Set-Location $Previous
  }
}

Write-Host ""
Write-Host "Shell Over Edge"
Write-Host ""
Write-Host "Session: $SessionId ($Clipboard)"
Write-Host "Expires: $Expires"
Write-Host ""
Write-Host "Send command:"
Write-Host "curl.exe -sS -X POST $BaseUrl/api/sessions/$SessionId/send --data ""pwd"""
Write-Host ""
Write-Host "Stop anytime: Ctrl+C"
Write-Host ""

try { [Console]::TreatControlCAsInput = $false } catch {}
try {
  Invoke-AgentRequest -Method Post -Path "/api/sessions/$SessionId/hello" -Body (Get-Location).Path -ContentType "text/plain" | Out-Null
  while ($true) {
    $BodyFile = [IO.Path]::GetTempFileName()
    $ResultFile = [IO.Path]::GetTempFileName()
    $Response = Invoke-AgentRequest -Method Get -Path "/api/sessions/$SessionId/next" -OutFile $BodyFile
    $StatusCode = [int]$Response.StatusCode
    if ($StatusCode -eq 204) {
      Remove-Item $BodyFile, $ResultFile -Force
      Start-Sleep -Seconds 2
      continue
    }
    if ($StatusCode -eq 410 -or $StatusCode -eq 401 -or $StatusCode -eq 404) {
      if (Test-Path $BodyFile) { Get-Content $BodyFile -Raw | Write-Host }
      Remove-Item $BodyFile, $ResultFile -Force
      break
    }
    if ($StatusCode -ne 200) {
      if (Test-Path $BodyFile) { Get-Content $BodyFile -Raw | Write-Host }
      Remove-Item $BodyFile, $ResultFile -Force
      Start-Sleep -Seconds 2
      continue
    }
    $CommandId = Get-ResponseHeader $Response "X-Command-Id"
    $CommandType = Get-ResponseHeader $Response "X-Command-Type"
    $Cwd = Decode-Base64Text (Get-ResponseHeader $Response "X-Command-Cwd-Base64")
    if ($CommandType -eq "shell") {
      $ExitCode = Run-Command -CommandBody (Get-Content $BodyFile -Raw) -Cwd $Cwd -ResultFile $ResultFile
    } else {
      [IO.File]::WriteAllText($ResultFile, "Unknown command type: $CommandType")
      $ExitCode = 1
    }
    Invoke-AgentRequest -Method Post -Path "/api/sessions/$SessionId/result/\${CommandId}?exit=$ExitCode" -Body ([IO.File]::ReadAllBytes($ResultFile)) -ContentType "application/octet-stream" | Out-Null
    Remove-Item $BodyFile, $ResultFile -Force
  }
} finally {
  Send-Bye
}
`;
}
