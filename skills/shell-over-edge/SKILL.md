---
name: shell-over-edge
description: Use Shell Over Edge to reach a shell from anywhere over HTTPS, send commands, and close the session safely.
---

# Shell Over Edge

Use this skill when a user wants shell access to another machine through `https://soe.stoff.dev`.

## Core Model

Shell Over Edge uses an 8-character session code as the capability. The remote machine runs a bootstrap that starts the relay agent immediately and can warm or download a native driver when config asks for it. `/config webrtc` downloads and starts a `soe-webrtc` sidecar for RTCDataChannel commands while keeping relay available. The helper probes capabilities, configures transport when needed, then sends commands through the active driver or `/send`; the agent executes them locally and returns plain text output.

Current API:

- `GET https://soe.stoff.dev/a` returns a POSIX bootstrap script.
- `GET https://soe.stoff.dev/a.ps1` returns a PowerShell bootstrap script.
- `POST https://soe.stoff.dev/api/sessions` returns a POSIX shell agent script.
- `POST https://soe.stoff.dev/api/sessions.ps1` returns a PowerShell agent script.
- `GET https://soe.stoff.dev/api/sessions/<code>/probe` returns machine, agent, network, and transport capability JSON.
- `POST https://soe.stoff.dev/api/sessions/<code>/config` requests `auto`, `relay`, `native`, `direct`, or `webrtc` and returns active transport JSON.
- `POST https://soe.stoff.dev/api/sessions/<code>/send` sends a command.
- `POST https://soe.stoff.dev/api/sessions/<code>/end` closes the session.

Direct-helper internals:

- `GET https://soe.stoff.dev/api/sessions/<code>/ice` returns STUN/TURN ICE config.
- `POST https://soe.stoff.dev/api/sessions/<code>/signals` publishes a short-lived direct signal.
- `GET https://soe.stoff.dev/api/sessions/<code>/signals?role=agent` lists agent direct signals.

## Workflow

1. Have the user run the generated agent on the target machine.
2. Capture the code printed by the agent or read it from the `X-Session-Id` response header.
3. Call `/probe` before guessing OS, hardware, shell, network, or transport support.
4. Call `/config` when the user asks to upgrade to `native`, `direct`, or `webrtc`.
5. Send commands as raw text unless `cwd` or timeout control is needed.
6. Read `/send` responses as plain command output.
7. End the session when finished.

Use the relay `/send` path by default. Use `/config` as the upgrade door. Only use direct signals when a helper has an actual reachable direct transport and can fall back quickly.

Native binary download is opt-in: set `SOE_WARM_NATIVE=1`, `SOE_AUTO_UPGRADE=1`, or `SOE_NATIVE_URL` before running the bootstrap, or request `native` or `direct` through `/config`. WebRTC sidecar download is opt-in through `/config webrtc` and uses release assets named like `soe-webrtc-aarch64-macos`, `soe-webrtc-x86_64-linux`, and `soe-webrtc-x86_64-windows.exe`.

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

Probe a session:

```sh
curl -sS https://soe.stoff.dev/api/sessions/<code>/probe
```

Request an upgrade:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/config --data 'native'
curl -sS -X POST https://soe.stoff.dev/api/sessions/<code>/config --data 'webrtc'
```

Send through WebRTC after `/config webrtc` reports `active: "webrtc"`:

```sh
soe-webrtc send --base-url https://soe.stoff.dev --session <code> --body 'pwd'
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
- Do expect JSON from `/probe` and `/config`.
- Do use `soe-webrtc send` for WebRTC DataChannel commands after `/config webrtc`; do not assume plain `/send` changes transport.
- Do not assume direct signals are reachable; keep direct attempts tightly timed and fall back to `/send`.
- Do not invent or guess session codes.
- Do not manually pause, kill, or replace the running agent to upgrade; use `/config`.
- Keep commands explicit, scoped, and reversible.
- Prefer read-only checks before destructive commands.
- Close sessions with `/end`.

## Limits

- Session TTL: 2 hours.
- Command body: 64 KB.
- Result body: 1 MB.
- Timeout: 1-3600 seconds.
