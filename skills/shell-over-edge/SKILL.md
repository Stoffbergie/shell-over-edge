---
name: shell-over-edge
description: Use Shell Over Edge to reach a shell from anywhere over HTTPS, send commands, and close the session safely.
---

# Shell Over Edge

Use this skill when a user wants shell access to another machine through `https://soe.stoff.dev`.

## Core Model

Shell Over Edge uses an 8-character session code as the capability. The remote machine runs a bootstrap that starts the relay agent immediately and may upgrade to a native agent when one is available. The helper sends commands to `/send`; the agent executes them locally and returns plain text output.

Current API:

- `GET https://soe.stoff.dev/a` returns a POSIX bootstrap script.
- `GET https://soe.stoff.dev/a.ps1` returns a PowerShell bootstrap script.
- `POST https://soe.stoff.dev/api/sessions` returns a POSIX shell agent script.
- `POST https://soe.stoff.dev/api/sessions.ps1` returns a PowerShell agent script.
- `POST https://soe.stoff.dev/api/sessions/<code>/send` sends a command.
- `POST https://soe.stoff.dev/api/sessions/<code>/end` closes the session.

Direct-helper internals:

- `GET https://soe.stoff.dev/api/sessions/<code>/ice` returns STUN/TURN ICE config.
- `POST https://soe.stoff.dev/api/sessions/<code>/signals` publishes a short-lived direct signal.
- `GET https://soe.stoff.dev/api/sessions/<code>/signals?role=agent` lists agent direct signals.

## Workflow

1. Have the user run the generated agent on the target machine.
2. Capture the code printed by the agent or read it from the `X-Session-Id` response header.
3. Send commands as raw text unless `cwd` or timeout control is needed.
4. Read `/send` responses as plain command output.
5. End the session when finished.

Use the relay `/send` path by default. Only use direct signals when a helper has an actual reachable direct transport and can fall back quickly.

## Commands

Create a POSIX session:

```sh
curl -sS https://soe.stoff.dev/a | sh
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
curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/send \
  --data '{"body":"pwd","cwd":"/tmp","timeoutSeconds":30}'
```

End the session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/end
```

## Rules

- Do not use bearer tokens, helper tokens, agent tokens, or URL tokens.
- Do not call retired endpoints such as `/commands`, `/events`, `/upload`, `/download`, `/api/agent/*`, `/start/*`, or `/connect.sh`.
- Do not expect JSON from `/send`; treat successful output as plain text.
- Do not assume direct signals are reachable; keep direct attempts tightly timed and fall back to `/send`.
- Do not invent or guess session codes.
- Keep commands explicit, scoped, and reversible.
- Prefer read-only checks before destructive commands.
- Close sessions with `/end`.

## Limits

- Session TTL: 2 hours.
- Command body: 64 KB.
- Result body: 1 MB.
- Timeout: 1-3600 seconds.
