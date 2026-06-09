import { quotePowerShell } from "./strings";
import type { SessionMeta } from "./types";

export function simplePowerShellAgentScript(baseUrl: string): string {
  return `$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$BaseUrl = ${quotePowerShell(baseUrl)}
$Code = [guid]::NewGuid().ToString()
$Clipboard = "copied to clipboard"
$Client = New-Object System.Net.Http.HttpClient
$Client.DefaultRequestHeaders.Add("x-api-key", $Code)

try {
  Set-Clipboard -Value $Code
} catch {
  $Clipboard = "clipboard copy unavailable"
}

function Send-Bye {
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      curl.exe -fsS -X POST -H "x-api-key: $Code" "$BaseUrl/api/v1/$Code/bye" | Out-Null
    } else {
      $Request = [System.Net.WebRequest]::Create("$BaseUrl/api/v1/$Code/bye")
      $Request.Method = "POST"
      $Request.Headers.Add("x-api-key", $Code)
      $Request.ContentLength = 0
      $Response = $Request.GetResponse()
      $Response.Close()
    }
  } catch {}
}

function Decode-Base64Text([string]$Value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Run-Command([string]$CommandId, [string]$Payload) {
  $Parts = $Payload.Split(":", 2)
  if ($Parts.Count -lt 2) { return }
  $CommandBody = Decode-Base64Text $Parts[1]
  $ResultFile = [IO.Path]::GetTempFileName()
  Write-Host ""
  Write-Host "$ $CommandBody"
  try {
    $global:LASTEXITCODE = 0
    $Output = & ([scriptblock]::Create($CommandBody)) *>&1 | Out-String
    $ExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
    [IO.File]::WriteAllText($ResultFile, $Output)
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    $ExitCode = 1
  }
  if (Test-Path $ResultFile) { Get-Content $ResultFile -Raw | Write-Host }
  if ($ExitCode -ne 0) { Write-Host "[exit $ExitCode]" }
  try {
    Send-Result -CommandId $CommandId -ExitCode $ExitCode -ResultFile $ResultFile
  } catch {
    Write-Host ("[soe] result upload failed " + $CommandId + ": " + $_.Exception.Message)
    throw
  }
  Remove-Item $ResultFile -Force
}

function Send-Result([string]$CommandId, [int]$ExitCode, [string]$ResultFile) {
  $ResultSize = (Get-Item -LiteralPath $ResultFile).Length
  $ResultUrl = $BaseUrl + "/api/v1/" + $Code + "/result/" + $CommandId + "?exit=" + $ExitCode
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    Write-Host ("[soe] posting result with curl.exe: " + $CommandId + " (" + $ResultSize + " bytes)")
    curl.exe -fsS -X POST -H "x-api-key: $Code" --data-binary "@$ResultFile" "$ResultUrl" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "curl.exe exited $LASTEXITCODE" }
    Write-Host ("[soe] result posted: " + $CommandId)
    return
  }
  Write-Host ("[soe] posting result with WebRequest: " + $CommandId + " (" + $ResultSize + " bytes)")
  $Bytes = [IO.File]::ReadAllBytes($ResultFile)
  $Request = [System.Net.WebRequest]::Create($ResultUrl)
  $Request.Method = "POST"
  $Request.Headers.Add("x-api-key", $Code)
  $Request.ContentType = "application/octet-stream"
  $Request.ContentLength = $Bytes.Length
  $Stream = $Request.GetRequestStream()
  $Stream.Write($Bytes, 0, $Bytes.Length)
  $Stream.Close()
  $Response = $Request.GetResponse()
  $Response.Close()
  Write-Host ("[soe] result posted: " + $CommandId)
}

function Open-EventStream {
  Write-Host "[soe] connecting event stream"
  $Response = $Client.GetAsync("$BaseUrl/api/v1/$Code/events", [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $Response.EnsureSuccessStatusCode() | Out-Null
  Write-Host "[soe] event stream connected"
  $Stream = $Response.Content.ReadAsStreamAsync().Result
  return New-Object System.IO.StreamReader -ArgumentList $Stream
}

Write-Host ""
Write-Host "Shell Over Edge"
Write-Host ""
Write-Host "Code: $Code ($Clipboard)"
Write-Host ""
Write-Host "Helper command:"
Write-Host "curl.exe -sS $BaseUrl -H ""x-api-key: $Code"" --data-binary ""pwd"""
Write-Host ""
Write-Host "Stop anytime: Ctrl+C"
Write-Host ""

try {
  while ($true) {
    try {
      $Reader = Open-EventStream
      $EventType = ""
      $EventId = ""
      $EventData = ""
      while ($null -ne ($Line = $Reader.ReadLine())) {
        if ($Line.StartsWith("event: ")) {
          $EventType = $Line.Substring(7)
        } elseif ($Line.StartsWith("id: ")) {
          $EventId = $Line.Substring(4)
        } elseif ($Line.StartsWith("data: ")) {
          $EventData = $Line.Substring(6)
        } elseif ($Line -eq "") {
          if ($EventType -eq "command" -and $EventId -and $EventData) {
            Write-Host ("[soe] command received: " + $EventId)
            Run-Command -CommandId $EventId -Payload $EventData
          }
          $EventType = ""
          $EventId = ""
          $EventData = ""
        }
      }
    } catch {
      Write-Host ("[soe] stream error: " + $_.Exception.Message)
      Start-Sleep -Seconds 1
    }
  }
} finally {
  Send-Bye
  $Client.Dispose()
}
`;
}

export function powerShellAgentScript(baseUrl: string, meta: SessionMeta, token: string): string {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$Code = ${quotePowerShell(meta.code)}
$Token = ${quotePowerShell(token)}
$Helper = ${quotePowerShell(meta.helperName)}
$Expires = ${quotePowerShell(new Date(meta.expiresAt).toISOString())}
$Headers = @{ Authorization = "Bearer $Token" }

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
  try { Invoke-AgentRequest -Method Post -Path "/api/agent/$Code/bye" | Out-Null } catch {}
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

function Write-RemoteFile([string]$SourceFile, [string]$TargetPath, [string]$ResultFile) {
  try {
    $Parent = Split-Path -Parent $TargetPath
    if ($Parent) { New-Item -ItemType Directory -Path $Parent -Force | Out-Null }
    [IO.File]::WriteAllBytes($TargetPath, [IO.File]::ReadAllBytes($SourceFile))
    $Size = (Get-Item $TargetPath).Length
    [IO.File]::WriteAllText($ResultFile, "Wrote $Size bytes to $TargetPath")
    return 0
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  }
}

function Read-RemoteFile([string]$TargetPath, [string]$ResultFile) {
  try {
    if (!(Test-Path -LiteralPath $TargetPath -PathType Leaf)) { throw "File not found: $TargetPath" }
    [IO.File]::WriteAllBytes($ResultFile, [IO.File]::ReadAllBytes($TargetPath))
    return 0
  } catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message)
    return 1
  }
}

Write-Host ""
Write-Host "Shell Over Edge"
Write-Host ""
Write-Host "Session: $Code"
Write-Host "Helper: $Helper"
Write-Host "Access: command runner + file transfer"
Write-Host "Expires: $Expires"
Write-Host ""
Write-Host "Stop anytime: Ctrl+C"
Write-Host ""

try { [Console]::TreatControlCAsInput = $false } catch {}
try {
  Invoke-AgentRequest -Method Post -Path "/api/agent/$Code/hello" -Body (@{ platform = $PSVersionTable.Platform; user = [Environment]::UserName; cwd = (Get-Location).Path } | ConvertTo-Json -Compress) -ContentType "application/json" | Out-Null
  while ($true) {
    $BodyFile = [IO.Path]::GetTempFileName()
    $ResultFile = [IO.Path]::GetTempFileName()
    $Response = Invoke-AgentRequest -Method Get -Path "/api/agent/$Code/next" -OutFile $BodyFile
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
    $TargetPath = Decode-Base64Text (Get-ResponseHeader $Response "X-Command-Path-Base64")
    if ($CommandType -eq "shell") {
      $ExitCode = Run-Command -CommandBody (Get-Content $BodyFile -Raw) -Cwd $Cwd -ResultFile $ResultFile
    } elseif ($CommandType -eq "write-file") {
      $ExitCode = Write-RemoteFile -SourceFile $BodyFile -TargetPath $TargetPath -ResultFile $ResultFile
    } elseif ($CommandType -eq "read-file") {
      $ExitCode = Read-RemoteFile -TargetPath $TargetPath -ResultFile $ResultFile
    } else {
      [IO.File]::WriteAllText($ResultFile, "Unknown command type: $CommandType")
      $ExitCode = 1
    }
    Invoke-AgentRequest -Method Post -Path "/api/agent/$Code/result/\${CommandId}?exit=$ExitCode" -Body ([IO.File]::ReadAllBytes($ResultFile)) -ContentType "application/octet-stream" | Out-Null
    Remove-Item $BodyFile, $ResultFile -Force
  }
} finally {
  Send-Bye
}
`;
}
