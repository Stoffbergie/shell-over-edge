---
name: shell-over-edge
description: Use Shell Over Edge to reach a shell from anywhere over HTTPS, send commands, and close the session safely.
---

# Shell Over Edge

Use this skill when a user wants temporary shell access to another machine through `https://soe.stoff.dev`.

## Model

Shell Over Edge uses an 8-character session code as the capability. The target runs a generated relay agent. The agent long-polls the Worker for commands, executes them locally, and posts plain text output back.

## API

- `GET https://soe.stoff.dev` returns a POSIX agent script.
- `GET https://soe.stoff.dev/a.ps1` returns a PowerShell agent script.
- `POST https://soe.stoff.dev/api/sessions/<code>/send?timeout=30` sends a command.
- `POST https://soe.stoff.dev/api/sessions/<code>/end` closes the session.

## Workflow

1. Have the user run the generated agent on the target machine.
2. Capture the code printed by the agent or read it from the `X-Session-Id` response header.
3. Send commands as raw text unless `cwd` or timeout control is needed.
4. Read `/send` responses as plain command output.
5. End the session when finished.

## Commands

Create a POSIX session:

```sh
curl -sS https://soe.stoff.dev | sh
```

Create a PowerShell session:

```powershell
irm https://soe.stoff.dev/a.ps1 | iex
```

Send a raw command:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/send --data 'pwd'
```

Send with options:

```sh
curl -sS -X POST 'https://soe.stoff.dev/api/sessions/<code>/send?timeout=30' \
  --data '{"body":"pwd","cwd":"/tmp"}'
```

End the session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/end
```

## Rules

- Do not use bearer tokens, helper tokens, agent tokens, or URL tokens.
- Do not call retired endpoints such as `/commands`, `/events`, `/upload`, `/download`, `/api/agent/*`, `/start/*`, or `/connect.sh`.
- Put command timeout in the URL as `?timeout=30`, not in the JSON body.
- Do not expect JSON from `/send`; treat successful output as plain text.
- Do not invent or guess session codes.
- Keep commands explicit, scoped, and reversible.
- Prefer read-only checks before destructive commands.
- Close sessions with `/end`.

## Limits

- Session TTL: 2 hours.
- Command body: 64 KB.
- Result body: 1 MB.
- Timeout: 1-50 seconds.
