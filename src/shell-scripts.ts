import { quoteShell } from "./strings";
import type { SessionMeta } from "./types";

export function simpleShellAgentScript(baseUrl: string): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import uuid; print(uuid.uuid4())'
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16 | awk '{ printf "%s-%s-4%s-8%s-%s\\n", substr($0,1,8), substr($0,9,4), substr($0,14,3), substr($0,17,3), substr($0,21,12) }'
  else
    printf ''
  fi
}

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

post_bye() {
  curl -fsS -X POST -H "x-api-key: $CODE" "$BASE_URL/api/v1/$CODE/bye" >/dev/null 2>&1 || true
}

run_command() {
  command_id=$1
  payload=$2
  timeout_seconds=\${payload%%:*}
  command_b64=\${payload#*:}
  command_body=$(decode_b64 "$command_b64")
  result_file=$(mktemp)
  printf '\\n$ %s\\n' "$command_body"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" sh -c "$command_body" > "$result_file" 2>&1
  else
    sh -c "$command_body" > "$result_file" 2>&1
  fi
  exit_code=$?
  cat "$result_file"
  if [ "$exit_code" -ne 0 ]; then
    printf '\\n[exit %s]\\n' "$exit_code"
  fi
  if curl -fsS -X POST -H "x-api-key: $CODE" --data-binary "@$result_file" "$BASE_URL/api/v1/$CODE/result/$command_id?exit=$exit_code" >/dev/null; then
    printf '[soe] result posted: %s\\n' "$command_id"
  else
    printf '[soe] result upload failed: %s\\n' "$command_id"
  fi
  rm -f "$result_file"
}

CODE=$(new_uuid)
if [ -z "$CODE" ]; then
  printf 'Could not generate a UUID on this machine.\\n'
  exit 1
fi

if copy_text "$CODE"; then
  CLIPBOARD='copied to clipboard'
else
  CLIPBOARD='clipboard copy unavailable'
fi

printf '\\nShell Over Edge\\n\\nCode: %s (%s)\\n\\nHelper command:\\ncurl -sS %s -H "x-api-key: %s" --data-binary "pwd"\\n\\nStop anytime: Ctrl+C\\n\\n' "$CODE" "$CLIPBOARD" "$BASE_URL" "$CODE"
trap 'post_bye; exit 0' INT TERM EXIT

while true; do
  event_type=''
  event_id=''
  event_data=''
  curl -fsS -N -H "x-api-key: $CODE" "$BASE_URL/api/v1/$CODE/events" | while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      event:\\ *) event_type=\${line#event: } ;;
      id:\\ *) event_id=\${line#id: } ;;
      data:\\ *) event_data=\${line#data: } ;;
      "")
        if [ "$event_type" = "command" ] && [ -n "$event_id" ] && [ -n "$event_data" ]; then
          run_command "$event_id" "$event_data"
        fi
        event_type=''
        event_id=''
        event_data=''
        ;;
    esac
  done
  sleep 1
done
`;
}

export function shellAgentScript(baseUrl: string, meta: SessionMeta, token: string): string {
  return `#!/bin/sh
set -u
BASE_URL=${quoteShell(baseUrl)}
CODE=${quoteShell(meta.code)}
TOKEN=${quoteShell(token)}
HELPER=${quoteShell(meta.helperName)}
EXPIRES=${quoteShell(new Date(meta.expiresAt).toISOString())}
POLL_SECONDS=2

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
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/$CODE/bye" >/dev/null 2>&1 || true
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

write_file() {
  source_file=$1
  target_path=$2
  output_file=$3
  if [ -z "$target_path" ]; then
    printf 'Missing target path\\n' > "$output_file"
    return 1
  fi
  parent_dir=$(dirname "$target_path")
  mkdir -p "$parent_dir" 2>/dev/null || true
  cp "$source_file" "$target_path" > "$output_file" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    size=$(wc -c < "$target_path" | tr -d ' ')
    printf 'Wrote %s bytes to %s\\n' "$size" "$target_path" > "$output_file"
  fi
  return "$status"
}

read_file() {
  target_path=$1
  output_file=$2
  if [ ! -f "$target_path" ]; then
    printf 'File not found: %s\\n' "$target_path" > "$output_file"
    return 1
  fi
  cp "$target_path" "$output_file"
}

printf '\\nShell Over Edge\\n\\nSession: %s\\nHelper: %s\\nAccess: command runner + file transfer\\nExpires: %s\\n\\nStop anytime: Ctrl+C\\n\\n' "$CODE" "$HELPER" "$EXPIRES"
trap 'post_bye; exit 0' INT TERM EXIT
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data "{\"platform\":\"$(uname -s)\",\"user\":\"$(whoami)\",\"cwd\":\"$(pwd | sed 's/"/\\\\"/g')\"}" "$BASE_URL/api/agent/$CODE/hello" >/dev/null

while true; do
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status_code=$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/$CODE/next" || printf '000')
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
  target_path=$(decode_b64 "$(header_value X-Command-Path-Base64 "$headers_file")")
  timeout_seconds=$(header_value X-Command-Timeout "$headers_file")
  [ -n "$timeout_seconds" ] || timeout_seconds=900
  result_file=$(mktemp)
  if [ "$command_type" = "shell" ]; then
    command_body=$(cat "$body_file")
    run_shell "$command_body" "$cwd" "$timeout_seconds" "$result_file"
    exit_code=$?
  elif [ "$command_type" = "write-file" ]; then
    write_file "$body_file" "$target_path" "$result_file"
    exit_code=$?
  elif [ "$command_type" = "read-file" ]; then
    read_file "$target_path" "$result_file"
    exit_code=$?
  else
    printf 'Unknown command type: %s\\n' "$command_type" > "$result_file"
    exit_code=1
  fi
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" --data-binary "@$result_file" "$BASE_URL/api/agent/$CODE/result/$command_id?exit=$exit_code" >/dev/null || true
  rm -f "$headers_file" "$body_file" "$result_file"
done
`;
}
