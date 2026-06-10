import { quotePowerShell, quoteShell } from "../shared/strings";
import { nativeReleaseBaseUrl } from "../shared/config";

export function shellBootstrapScript(baseUrl: string): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
NATIVE_BASE_URL=\${SOE_NATIVE_BASE_URL:-${quoteShell(nativeReleaseBaseUrl)}}
WORK_DIR="\${TMPDIR:-/tmp}/soe-bootstrap-$$"
HEADERS_FILE="$WORK_DIR/headers"
AGENT_FILE="$WORK_DIR/agent.sh"
NATIVE_FILE="$WORK_DIR/soe-agent"
AGENT_PID=""
UPGRADED=0

header_value() {
  awk -F': ' -v name="$1" 'tolower($1) == tolower(name) { sub("\\r$", "", $2); print $2; exit }' "$2"
}

post_bye() {
  if [ "$UPGRADED" = "1" ]; then
    return 0
  fi
  if [ -n "\${SESSION_ID:-}" ]; then
    curl -fsS --connect-timeout 5 --max-time 10 -X POST "$BASE_URL/api/sessions/$SESSION_ID/end" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
  post_bye
  rm -rf "$WORK_DIR"
}

native_name() {
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]')
  case "$os:$arch" in
    darwin:arm64) printf '%s' soe-agent-aarch64-macos ;;
    darwin:x86_64) printf '%s' soe-agent-x86_64-macos ;;
    linux:aarch64|linux:arm64) printf '%s' soe-agent-aarch64-linux-musl ;;
    linux:x86_64|linux:amd64) printf '%s' soe-agent-x86_64-linux-musl ;;
    *) printf '' ;;
  esac
}

download_native() {
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  if [ -n "\${SOE_NATIVE_URL:-}" ]; then
    url="$SOE_NATIVE_URL"
  else
    name=$(native_name)
    [ -n "$name" ] || return 1
    url="$NATIVE_BASE_URL/$name"
  fi
  curl -fsSL --connect-timeout 2 --max-time 20 -o "$NATIVE_FILE.tmp" "$url" >/dev/null 2>&1 || return 1
  chmod +x "$NATIVE_FILE.tmp" || return 1
  mv "$NATIVE_FILE.tmp" "$NATIVE_FILE"
}

mkdir -p "$WORK_DIR"
trap 'cleanup; exit 0' INT TERM EXIT

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required\\n' >&2
  exit 1
fi

curl -fsS --connect-timeout 5 --max-time 20 -D "$HEADERS_FILE" -o "$AGENT_FILE" -X POST "$BASE_URL/api/sessions"
SESSION_ID=$(header_value X-Session-Id "$HEADERS_FILE")
if [ -z "$SESSION_ID" ]; then
  printf 'Could not read session id\\n' >&2
  exit 1
fi

chmod +x "$AGENT_FILE"
if [ "\${SOE_AUTO_UPGRADE:-}" = "1" ] || [ "\${SOE_WARM_NATIVE:-}" = "1" ] || [ -n "\${SOE_NATIVE_URL:-}" ]; then
  (download_native) &
fi
SOE_NO_END_ON_EXIT=1 sh "$AGENT_FILE" &
AGENT_PID=$!

while kill -0 "$AGENT_PID" 2>/dev/null; do
  if [ "\${SOE_AUTO_UPGRADE:-}" = "1" ] && [ -x "$NATIVE_FILE" ]; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
    UPGRADED=1
    exec "$NATIVE_FILE" --base-url "$BASE_URL" --session "$SESSION_ID"
  fi
  sleep 1
done

wait "$AGENT_PID"
`;
}

export function powerShellBootstrapScript(baseUrl: string): string {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$NativeBaseUrl = if ($env:SOE_NATIVE_BASE_URL) { $env:SOE_NATIVE_BASE_URL } else { ${quotePowerShell(nativeReleaseBaseUrl)} }
$WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("soe-bootstrap-" + [Guid]::NewGuid().ToString("N"))
$AgentPath = Join-Path $WorkDir "agent.ps1"
$NativePath = Join-Path $WorkDir "soe-agent.exe"
$SessionId = ""
$Agent = $null
$Upgraded = $false

function Stop-RelayAgent {
  if ($Agent -and !$Agent.HasExited) {
    Stop-Process -Id $Agent.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $Agent.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
}

function Send-Bye {
  if ($Upgraded -or [string]::IsNullOrWhiteSpace($SessionId)) { return }
  try { Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/sessions/$SessionId/end" -UseBasicParsing -TimeoutSec 10 | Out-Null } catch {}
}

function Get-NativeName {
  $Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($Architecture -eq "arm64") { return "soe-agent-aarch64-windows.exe" }
  if ($Architecture -eq "x64") { return "soe-agent-x86_64-windows.exe" }
  return ""
}

function Start-NativeDownload {
  $Url = if ($env:SOE_NATIVE_URL) {
    $env:SOE_NATIVE_URL
  } else {
    $Name = Get-NativeName
    if (!$Name) { return }
    "$NativeBaseUrl/$Name"
  }
  Start-Job -ArgumentList $Url, $NativePath -ScriptBlock {
    param([string]$Url, [string]$NativePath)
    try {
      Invoke-WebRequest -Uri $Url -OutFile "$NativePath.tmp" -UseBasicParsing -TimeoutSec 20
      Move-Item "$NativePath.tmp" $NativePath -Force
    } catch {}
  } | Out-Null
}

try {
  New-Item -ItemType Directory -Path $WorkDir | Out-Null
  $Response = Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/sessions.ps1" -UseBasicParsing -TimeoutSec 20
  [IO.File]::WriteAllText($AgentPath, [string]$Response.Content)
  $SessionId = [string]$Response.Headers["X-Session-Id"]
  if ([string]::IsNullOrWhiteSpace($SessionId)) { throw "Could not read session id" }

  if ($env:SOE_AUTO_UPGRADE -eq "1" -or $env:SOE_WARM_NATIVE -eq "1" -or $env:SOE_NATIVE_URL) {
    Start-NativeDownload
  }
  $env:SOE_NO_END_ON_EXIT = "1"
  $HostExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell.exe" }
  $Agent = Start-Process -FilePath $HostExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $AgentPath) -PassThru

  while ($Agent -and !$Agent.HasExited) {
    if ($env:SOE_AUTO_UPGRADE -eq "1" -and (Test-Path $NativePath)) {
      Stop-RelayAgent
      $Upgraded = $true
      & $NativePath --base-url $BaseUrl --session $SessionId
      break
    }
    Start-Sleep -Seconds 1
    $Agent.Refresh()
  }
} finally {
  Stop-RelayAgent
  Send-Bye
  Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}
