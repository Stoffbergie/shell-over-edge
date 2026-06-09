import { quoteShell } from "./strings";
import type { SessionMeta } from "./types";

export function shellAgentScript(baseUrl: string, meta: SessionMeta): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
SESSION_ID=${quoteShell(meta.id)}
EXPIRES=${quoteShell(new Date(meta.expiresAt).toISOString())}
POLL_SECONDS=2

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
    printf '%s' "$1" | base64 --decode 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null || printf ''
  else
    printf ''
  fi
}

header_value() {
  awk -F': ' -v name="$1" 'tolower($1) == tolower(name) { sub("\\r$", "", $2); print $2; exit }' "$2"
}

post_bye() {
  curl -fsS -X POST "$BASE_URL/api/sessions/$SESSION_ID/end" >/dev/null 2>&1 || true
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
    run_prefix="cd $(printf '%s' "$cwd" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/") && "
  else
    run_prefix=""
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" sh -c "$run_prefix$command_body" > "$output_file" 2>&1
  else
    sh -c "$run_prefix$command_body" > "$output_file" 2>&1
  fi
}

if copy_text "$SESSION_ID"; then
  CLIPBOARD='copied to clipboard'
else
  CLIPBOARD='clipboard copy unavailable'
fi

printf '\\nShell Over Edge\\n\\nSession: %s (%s)\\nExpires: %s\\n\\nSend command:\\ncurl -sS -X POST %s/api/sessions/%s/send --data '"'"'pwd'"'"'\\n\\nStop anytime: Ctrl+C\\n\\n' "$SESSION_ID" "$CLIPBOARD" "$EXPIRES" "$BASE_URL" "$SESSION_ID"
trap 'post_bye; exit 0' INT TERM EXIT
curl -fsS -X POST -H "X-Agent-Platform: $(uname -s)" -H "X-Agent-User: $(whoami)" --data-binary "$(pwd)" "$BASE_URL/api/sessions/$SESSION_ID/hello" >/dev/null

while true; do
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status_code=$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" "$BASE_URL/api/sessions/$SESSION_ID/next" || printf '000')
  if [ "$status_code" = "204" ]; then
    rm -f "$headers_file" "$body_file"
    sleep "$POLL_SECONDS"
    continue
  fi
  if [ "$status_code" = "410" ] || [ "$status_code" = "404" ] || [ "$status_code" = "401" ]; then
    cat "$body_file"
    printf '\\n'
    rm -f "$headers_file" "$body_file"
    exit 0
  fi
  if [ "$status_code" != "200" ]; then
    cat "$body_file"
    printf '\\n'
    rm -f "$headers_file" "$body_file"
    sleep "$POLL_SECONDS"
    continue
  fi
  command_id=$(header_value X-Command-Id "$headers_file")
  command_type=$(header_value X-Command-Type "$headers_file")
  cwd=$(decode_b64 "$(header_value X-Command-Cwd-Base64 "$headers_file")")
  timeout_seconds=$(header_value X-Command-Timeout "$headers_file")
  [ -n "$timeout_seconds" ] || timeout_seconds=900
  result_file=$(mktemp)
  if [ "$command_type" = "shell" ]; then
    command_body=$(cat "$body_file")
    run_shell "$command_body" "$cwd" "$timeout_seconds" "$result_file"
    exit_code=$?
  else
    printf 'Unknown command type: %s\\n' "$command_type" > "$result_file"
    exit_code=1
  fi
  curl -fsS -X POST --data-binary "@$result_file" "$BASE_URL/api/sessions/$SESSION_ID/result/$command_id?exit=$exit_code" >/dev/null || true
  rm -f "$headers_file" "$body_file" "$result_file"
done
`;
}
