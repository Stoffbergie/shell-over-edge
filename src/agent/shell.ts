import type { SessionMeta } from "../domain/session";
import { agentProtocolVersion, defaultCommandTimeoutSeconds } from "../shared/config";
import { quoteShell } from "../shared/strings";

export function shellAgentScript(baseUrl: string, meta: SessionMeta): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
SESSION_ID=${quoteShell(meta.code)}
AGENT_VERSION=${quoteShell(agentProtocolVersion)}

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

post_bye() {
  if [ "\${SOE_NO_END_ON_EXIT:-}" = "1" ]; then
    return 0
  fi
  curl -fsS --connect-timeout 5 --max-time 10 -X POST "$BASE_URL/$SESSION_ID/end" >/dev/null 2>&1 || true
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
curl -fsS --connect-timeout 5 --max-time 15 -X POST -H "X-Agent-Platform: $(uname -s)" "$BASE_URL/api/sessions/$SESSION_ID/hello" >/dev/null

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
  cwd=$(decode_b64 "$(header_value X-Command-Cwd-Base64 "$headers_file")")
  timeout_seconds=$(header_value X-Command-Timeout "$headers_file")
  [ -n "$timeout_seconds" ] || timeout_seconds=${defaultCommandTimeoutSeconds}
  result_file=$(mktemp)
  command_body=$(cat "$body_file")
  (run_shell "$command_body" "$cwd" "$timeout_seconds" "$result_file")
  exit_code=$?
  curl -fsS --connect-timeout 5 --max-time 30 -X POST --data-binary "@$result_file" "$BASE_URL/api/sessions/$SESSION_ID/result/$command_id?exit=$exit_code" >/dev/null || true
  rm -f "$headers_file" "$body_file" "$result_file"
done
`;
}
