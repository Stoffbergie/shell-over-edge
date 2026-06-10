import type { SessionMeta } from "../domain/session";
import { agentProtocolVersion, nativeReleaseBaseUrl } from "../shared/config";
import { quoteShell } from "../shared/strings";

export function shellAgentScript(baseUrl: string, meta: SessionMeta): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
SESSION_ID=${quoteShell(meta.code)}
AGENT_VERSION=${quoteShell(agentProtocolVersion)}
NATIVE_BASE_URL=\${SOE_NATIVE_BASE_URL:-${quoteShell(nativeReleaseBaseUrl)}}
NATIVE_FILE="\${TMPDIR:-/tmp}/soe-agent-$SESSION_ID"
UPGRADE_TO_NATIVE=0

copy_text() {
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$1" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$1" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$1" | xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then
    printf '%s' "$1" | xsel --clipboard --input
  elif command -v clip.exe >/dev/null 2>&1; then
    printf '%s' "$1" | clip.exe
  else
    return 1
  fi
}

decode_b64() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null || printf ''
  else
    printf ''
  fi
}

header_value() {
  awk -F': ' -v name="$1" 'tolower($1) == tolower(name) { sub("\\r$", "", $2); print $2; exit }' "$2"
}

json_escape() {
  awk 'BEGIN { ORS = "" } { gsub(/\\\\/, "\\\\\\\\"); gsub(/"/, "\\\\\\""); gsub(/\\r/, ""); if (NR > 1) printf "\\\\n"; printf "%s", $0 }'
}

json_value() {
  printf '%s' "$1" | json_escape
}

has_command() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

first_line() {
  printf '%s' "$1" | sed -n '1p'
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
  curl -fsSL --connect-timeout 5 --max-time 40 -o "$NATIVE_FILE.tmp" "$url" >/dev/null 2>&1 || return 1
  chmod +x "$NATIVE_FILE.tmp" || return 1
  mv "$NATIVE_FILE.tmp" "$NATIVE_FILE"
}

private_ips() {
  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | paste -sd,
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\\./ { print $2 }' | paste -sd,
  else
    printf ''
  fi
}

latency_ms() {
  if ! command -v curl >/dev/null 2>&1; then
    printf ''
    return
  fi
  total=$(curl -fsS -o /dev/null -w '%{time_total}' --connect-timeout 3 --max-time 8 "$BASE_URL/a" 2>/dev/null || printf '')
  if [ -n "$total" ] && command -v awk >/dev/null 2>&1; then
    printf '%s' "$total" | awk '{ printf "%d", ($1 * 1000) }'
  else
    printf ''
  fi
}

probe_json() {
  os_name=$(uname -s 2>/dev/null || printf unknown)
  arch=$(uname -m 2>/dev/null || printf unknown)
  host=$(hostname 2>/dev/null || printf '')
  user=$(whoami 2>/dev/null || printf '')
  cwd=$(pwd 2>/dev/null || printf '')
  shell_name=\${SHELL:-}
  os_version=''
  cpu=''
  cores=''
  memory=''
  if command -v sw_vers >/dev/null 2>&1; then
    os_version=$(sw_vers -productVersion 2>/dev/null || printf '')
  elif [ -r /etc/os-release ]; then
    os_version=$(awk -F= '/^PRETTY_NAME=/{ gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release 2>/dev/null || printf '')
  fi
  cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || awk -F: '/model name/{ sub(/^ /, "", $2); print $2; exit }' /proc/cpuinfo 2>/dev/null || printf '')
  cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || printf '')
  memory=$(sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/{ print $2 * 1024; exit }' /proc/meminfo 2>/dev/null || printf '')
  ips=$(private_ips)
  latency=$(latency_ms)
  native_supported=false
  [ -n "$(native_name)" ] && native_supported=true
  printf '{'
  printf '"session":"%s",' "$(json_value "$SESSION_ID")"
  printf '"agent":{"kind":"posix-shell","version":"%s","pid":%s},' "$(json_value "$AGENT_VERSION")" "$$"
  printf '"os":{"name":"%s","version":"%s","arch":"%s"},' "$(json_value "$os_name")" "$(json_value "$os_version")" "$(json_value "$arch")"
  printf '"hardware":{"cpu":"%s","cores":"%s","memoryBytes":"%s"},' "$(json_value "$(first_line "$cpu")")" "$(json_value "$cores")" "$(json_value "$memory")"
  printf '"runtime":{"shell":"%s","cwd":"%s","user":"%s","hostname":"%s","commands":{"curl":%s,"sh":%s,"bash":%s,"zsh":%s,"python3":%s,"node":%s,"bun":%s,"timeout":%s,"base64":%s}},' "$(json_value "$shell_name")" "$(json_value "$cwd")" "$(json_value "$user")" "$(json_value "$host")" "$(has_command curl)" "$(has_command sh)" "$(has_command bash)" "$(has_command zsh)" "$(has_command python3)" "$(has_command node)" "$(has_command bun)" "$(has_command timeout)" "$(has_command base64)"
  printf '"network":{"baseUrl":"%s","baseUrlLatencyMs":"%s","privateIps":"%s"},' "$(json_value "$BASE_URL")" "$(json_value "$latency")" "$(json_value "$ips")"
  printf '"supports":{"relay":true,"native":%s,"directHttp":false,"webrtc":false,"webrtcSignaling":true},' "$native_supported"
  printf '"activeTransport":"relay"'
  printf '}'
}

config_json() {
  requested=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  [ -n "$requested" ] || requested=auto
  case "$requested" in
    auto|native)
      if download_native; then
        UPGRADE_TO_NATIVE=1
        printf '{"ok":true,"requested":"%s","active":"native","upgraded":true,"fallback":false,"reason":"native agent downloaded and will take over after this response"}' "$requested"
      else
        printf '{"ok":true,"requested":"%s","active":"relay","upgraded":false,"fallback":true,"reason":"native agent is not available on this machine"}' "$requested"
      fi
      ;;
    relay)
      printf '{"ok":true,"requested":"relay","active":"relay","upgraded":false,"fallback":false,"reason":"relay is already active"}'
      ;;
    direct)
      if download_native; then
        UPGRADE_TO_NATIVE=1
        printf '{"ok":true,"requested":"direct","active":"native","upgraded":true,"fallback":true,"reason":"native driver downloaded; direct HTTP listener is not enabled yet"}'
      else
        printf '{"ok":true,"requested":"direct","active":"relay","upgraded":false,"fallback":true,"reason":"this POSIX agent does not run a direct HTTP listener yet"}'
      fi
      ;;
    webrtc)
      if download_native; then
        UPGRADE_TO_NATIVE=1
        printf '{"ok":true,"requested":"webrtc","active":"native","upgraded":true,"fallback":true,"reason":"native driver downloaded; WebRTC is not enabled in this driver yet"}'
      else
        printf '{"ok":true,"requested":"webrtc","active":"relay","upgraded":false,"fallback":true,"reason":"WebRTC needs a sender-side driver and an agent runtime with WebRTC support; this POSIX shell agent only has signaling support"}'
      fi
      ;;
    *)
      printf '{"ok":false,"requested":"%s","active":"relay","upgraded":false,"fallback":true,"reason":"unsupported transport"}' "$(json_value "$requested")"
      return 1
      ;;
  esac
}

post_bye() {
  if [ "\${SOE_NO_END_ON_EXIT:-}" = "1" ]; then
    return 0
  fi
  curl -fsS --connect-timeout 5 --max-time 10 -X POST "$BASE_URL/api/sessions/$SESSION_ID/end" >/dev/null 2>&1 || true
}

run_shell() {
  command_body=$1
  cwd=$2
  timeout_seconds=$3
  output_file=$4
  if [ -n "$cwd" ]; then
    if [ ! -d "$cwd" ]; then
      printf 'Working directory does not exist: %s\\n' "$cwd" > "$output_file"
      return 1
    fi
    cd "$cwd" || return 1
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" sh -c "$command_body" > "$output_file" 2>&1
  else
    sh -c "$command_body" > "$output_file" 2>&1 &
    command_pid=$!
    ( sleep "$timeout_seconds"; kill "$command_pid" 2>/dev/null ) &
    timeout_pid=$!
    wait "$command_pid"
    exit_code=$?
    kill "$timeout_pid" 2>/dev/null || true
    wait "$timeout_pid" 2>/dev/null || true
    return "$exit_code"
  fi
}

if copy_text "$SESSION_ID"; then
  CLIPBOARD='copied to clipboard'
else
  CLIPBOARD='clipboard copy unavailable'
fi

printf 'Session: %s (%s)\\nStop anytime: Ctrl+C\\n' "$SESSION_ID" "$CLIPBOARD"
trap 'post_bye; exit 0' INT TERM EXIT
curl -fsS --connect-timeout 5 --max-time 15 -X POST -H "X-Agent-Platform: $(uname -s)" -H "X-Agent-User: $(whoami)" --data-binary "$(pwd)" "$BASE_URL/api/sessions/$SESSION_ID/hello" >/dev/null

while true; do
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status_code=$(curl -sS --connect-timeout 5 --max-time 35 -D "$headers_file" -o "$body_file" -w "%{http_code}" "$BASE_URL/api/sessions/$SESSION_ID/next" || printf '000')
  if [ "$status_code" = "204" ]; then
    rm -f "$headers_file" "$body_file"
    continue
  fi
  if [ "$status_code" = "410" ] || [ "$status_code" = "404" ] || [ "$status_code" = "401" ]; then
    rm -f "$headers_file" "$body_file"
    exit 0
  fi
  if [ "$status_code" != "200" ]; then
    cat "$body_file"
    printf '\\n'
    rm -f "$headers_file" "$body_file"
    sleep 1
    continue
  fi
  command_id=$(header_value X-Command-Id "$headers_file")
  command_type=$(header_value X-Command-Type "$headers_file")
  [ -n "$command_type" ] || command_type=shell
  cwd=$(decode_b64 "$(header_value X-Command-Cwd-Base64 "$headers_file")")
  timeout_seconds=$(header_value X-Command-Timeout "$headers_file")
  [ -n "$timeout_seconds" ] || timeout_seconds=900
  result_file=$(mktemp)
  command_body=$(cat "$body_file")
  case "$command_type" in
    shell)
      (run_shell "$command_body" "$cwd" "$timeout_seconds" "$result_file")
      exit_code=$?
      ;;
    probe)
      probe_json > "$result_file"
      exit_code=0
      ;;
    config)
      config_json "$command_body" > "$result_file"
      exit_code=$?
      ;;
    *)
      printf '{"ok":false,"reason":"unsupported command type"}' > "$result_file"
      exit_code=1
      ;;
  esac
  curl -fsS --connect-timeout 5 --max-time 30 -X POST --data-binary "@$result_file" "$BASE_URL/api/sessions/$SESSION_ID/result/$command_id?exit=$exit_code" >/dev/null || true
  rm -f "$headers_file" "$body_file" "$result_file"
  if [ "$UPGRADE_TO_NATIVE" = "1" ] && [ -x "$NATIVE_FILE" ]; then
    SOE_NO_END_ON_EXIT=1
    trap - INT TERM EXIT
    exec "$NATIVE_FILE" --base-url "$BASE_URL" --session "$SESSION_ID"
  fi
done
`;
}
