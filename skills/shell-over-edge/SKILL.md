---
name: shell-over-edge
description: Use Shell Over Edge for temporary shell access over HTTPS.
---

# Shell Over Edge

Use when SSH, VPN, or inbound ports are blocked and the user can run an agent on the target.

## Flow

- Start POSIX: `curl -sS https://soe.stoff.dev | sh`
- Start PowerShell: `irm https://soe.stoff.dev/a.ps1 | iex`
- Use the printed 8-character code, or read `X-Session-Id`.
- Send raw: `curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/send --data 'pwd'`
- Send with cwd/timeout: `curl -sS -X POST 'https://soe.stoff.dev/api/sessions/<code>/send?timeout=30' --data '{"body":"pwd","cwd":"/tmp"}'`
- Read successful `/send` responses as plain text.
- Close: `curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/end`

## API

- `GET https://soe.stoff.dev` returns a POSIX agent script.
- `GET https://soe.stoff.dev/a.ps1` returns a PowerShell agent script.
- `POST https://soe.stoff.dev/api/sessions/<code>/send?timeout=30` sends one command.
- `POST https://soe.stoff.dev/api/sessions/<code>/end` ends the session.

## Rules

- The code is the capability. Do not invent codes or add bearer/URL tokens.
- Prefer raw command bodies. Use JSON only for `body` and `cwd`.
- Put command timeout in the URL as `?timeout=30`, not in the JSON body.
- Do not call retired endpoints: `/commands`, `/events`, `/upload`, `/download`, `/api/agent/*`, `/start/*`, `/connect.sh`.
- Keep commands explicit and reversible. Close sessions with `/end`.

## Limits

- TTL: 2 hours.
- Command body: 64 KB.
- Result body: 1 MB.
- Timeout: 1-50 seconds.
