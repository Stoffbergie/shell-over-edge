---
name: shell-over-edge
description: Use Shell Over Edge to create a temporary remote shell session through Cloudflare Workers, send commands, and close the session safely.
---

# Shell Over Edge

Use this skill when a user wants temporary shell access to a machine through `https://soe.stoff.dev`.

## Core Model

Shell Over Edge uses a UUID session as the capability. The remote machine runs a generated agent script. The helper sends commands to `/send`; the agent executes them locally and returns plain text output.

Current API:

- `POST https://soe.stoff.dev/api/sessions` returns a POSIX shell agent script.
- `POST https://soe.stoff.dev/api/sessions.ps1` returns a PowerShell agent script.
- `POST https://soe.stoff.dev/api/sessions/<uuid>/send` sends a command.
- `POST https://soe.stoff.dev/api/sessions/<uuid>/end` closes the session.

## Workflow

1. Have the user run the generated agent on the target machine.
2. Capture the UUID printed by the agent or read it from the `X-Session-Id` response header.
3. Send commands as raw text unless `cwd` or timeout control is needed.
4. Read `/send` responses as plain command output.
5. End the session when finished.

## Commands

Create a POSIX session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions | sh
```

Create a PowerShell session:

```powershell
irm -Method Post https://soe.stoff.dev/api/sessions.ps1 | iex
```

Send a raw command:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/send --data 'pwd'
```

Send with options:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/send \
  --data '{"body":"pwd","cwd":"/tmp","timeoutSeconds":30}'
```

End the session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/end
```

## Rules

- Do not use bearer tokens, helper tokens, agent tokens, or URL tokens.
- Do not call retired endpoints such as `/commands`, `/events`, `/upload`, `/download`, `/api/agent/*`, `/start/*`, or `/connect.sh`.
- Do not expect JSON from `/send`; treat successful output as plain text.
- Do not invent or guess UUIDs.
- Keep commands explicit, scoped, and reversible.
- Prefer read-only checks before destructive commands.
- Close sessions with `/end`.

## Limits

- Session TTL: 2 hours.
- Command body: 64 KB.
- Result body: 1 MB.
- Timeout: 1-3600 seconds.
