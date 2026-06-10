---
name: shell-over-edge
description: Use Shell Over Edge for temporary shell access over HTTPS.
---

# Shell Over Edge

Use when SSH, VPN, or inbound ports are blocked and the user can run an agent on the target.

## Flow

- Start POSIX: `curl -sS https://soe.stoff.dev | sh`
- Start PowerShell: `irm https://soe.stoff.dev | iex`
- Use the printed 8-character code, or read `X-Session-Id`.
- Send raw: `curl -sS -X POST https://soe.stoff.dev/<code>/send --data 'pwd'`
- Send with cwd: `curl -sS -X POST https://soe.stoff.dev/<code>/send --data '{"body":"pwd","cwd":"/tmp"}'`
- Add `?timeout=10` only for a custom timeout.
- Read successful `/send` responses as plain text.
- Close: `curl -sS -X POST https://soe.stoff.dev/<code>/end`

## API

- `GET https://soe.stoff.dev` returns POSIX by default, PowerShell when `User-Agent` or `Accept` contains `PowerShell` or `pwsh`.
- `POST https://soe.stoff.dev/<code>/send` sends one command.
- `POST https://soe.stoff.dev/<code>/send?timeout=10` sends one command with a custom timeout.
- `POST https://soe.stoff.dev/<code>/end` ends the session.

## Rules

- The code is the capability. Do not invent codes or add bearer/URL tokens.
- Prefer raw command bodies. Use JSON only for `body` and `cwd`.
- Default timeout is 30 seconds. Put custom timeout in the URL as `?timeout=10`, not in the JSON body.
- Do not call retired endpoints: `/commands`, `/events`, `/upload`, `/download`, `/api/agent/*`, `/start/*`, `/connect.sh`.
- Keep commands explicit and reversible. Close sessions with `/end`.

## Limits

- TTL: 2 hours.
- Command body: 64 KB.
- Result body: 1 MB.
- Timeout: 1-50 seconds.
