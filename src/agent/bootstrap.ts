import { quotePowerShell, quoteShell } from "../shared/strings";

export function shellBootstrapScript(baseUrl: string): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
WORK_DIR="\${TMPDIR:-/tmp}/soe-bootstrap-$$"
HEADERS_FILE="$WORK_DIR/headers"
AGENT_FILE="$WORK_DIR/agent.sh"

header_value() {
  awk -F': ' -v name="$1" 'tolower($1) == tolower(name) { sub("\\r$", "", $2); print $2; exit }' "$2"
}

cleanup() {
  rm -rf "$WORK_DIR"
}

mkdir -p "$WORK_DIR"
trap 'cleanup' INT TERM EXIT

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
sh "$AGENT_FILE"
`;
}

export function powerShellBootstrapScript(baseUrl: string): string {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("soe-bootstrap-" + [Guid]::NewGuid().ToString("N"))
$AgentPath = Join-Path $WorkDir "agent.ps1"

try {
  New-Item -ItemType Directory -Path $WorkDir | Out-Null
  $Response = Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/sessions.ps1" -UseBasicParsing -TimeoutSec 20
  [IO.File]::WriteAllText($AgentPath, [string]$Response.Content)
  $HostExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell.exe" }
  if ($HostExe -eq "powershell.exe") {
    & $HostExe -NoProfile -ExecutionPolicy Bypass -File $AgentPath
  } else {
    & $HostExe -NoProfile -File $AgentPath
  }
} finally {
  Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}
