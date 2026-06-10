# Shell Over Edge

Reach any shell from anywhere.

[![CI](https://github.com/Stoffberg/shell-over-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/shell-over-edge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Shell Over Edge is a tiny HTTPS relay for temporary shell access. The target machine runs a generated script, prints an 8-character code, and long-polls the Cloudflare Worker for commands. The sender posts commands to that code and gets plain text output back.

It is for short-lived troubleshooting when SSH, VPN, or inbound networking is unavailable. The code is the capability, so there are no accounts, tokens, browser sessions, or local daemons to keep around after the session ends.

## Demo

Target machine:

```sh
$ curl -sS https://soe.stoff.dev/a | sh
Session: 1234abcd (copied to clipboard)
Stop anytime: Ctrl+C
```

Sender:

```sh
$ curl -sS -X POST https://soe.stoff.dev/api/sessions/1234abcd/send --data 'pwd'
/tmp

$ curl -sS -X POST https://soe.stoff.dev/api/sessions/1234abcd/send \
  --data '{"body":"printf hello","cwd":"/tmp","timeoutSeconds":10}'
hello

$ curl -sS -X POST https://soe.stoff.dev/api/sessions/1234abcd/end
ended
```

## Architecture

```mermaid
sequenceDiagram
    participant Target as "Target shell"
    participant Worker as "Cloudflare Worker"
    participant Bridge as "Durable Object"
    participant Sender as "Sender"

    Target->>Worker: "GET /a | sh"
    Worker-->>Target: "bootstrap"
    Target->>Worker: "POST /api/sessions"
    Worker-->>Target: "relay agent + code"
    Target->>Bridge: "GET /next"
    Sender->>Bridge: "POST /send"
    Bridge-->>Target: "command"
    Target->>Target: "run command"
    Target->>Bridge: "POST /result/:id"
    Bridge-->>Sender: "plain text output"
```

Cloudflare Worker routes create sessions and validate short codes. Session metadata lives in R2. A Durable Object owns the live queue for each session, pairs each command with its result, and handles parallel sends without mixing outputs.

No client credentials are needed. The session code is the capability. Sessions expire after 2 hours.

## Use

On macOS/Linux:

```sh
curl -sS https://soe.stoff.dev/a | sh
```

On Windows PowerShell:

```powershell
irm https://soe.stoff.dev/a.ps1 | iex
```

The target prints:

```text
Session: 1234abcd (copied to clipboard)
Stop anytime: Ctrl+C
```

Send a command:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/1234abcd/send --data 'pwd'
```

Send with options:

```sh
curl -sS -X POST 'https://soe.stoff.dev/api/sessions/1234abcd/send?timeout=30' \
  --data '{"body":"pwd","cwd":"/tmp"}'
```

Close the session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/1234abcd/end
```

## API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/a` | empty | POSIX bootstrap |
| `GET` | `/a.ps1` | empty | PowerShell bootstrap |
| `POST` | `/api/sessions` | empty | POSIX relay agent |
| `POST` | `/api/sessions.ps1` | empty | PowerShell relay agent |
| `POST` | `/api/sessions/<code>/send` | raw text or JSON | command output |
| `POST` | `/api/sessions/<code>/end` | empty | `ended` |

JSON command bodies are optional:

```json
{"body":"pwd","cwd":"/tmp","timeoutSeconds":30}
```

Raw text is preferred for quick commands.

## Requirements

- Node.js 24 or newer
- pnpm 11.5.2 via Corepack
- Docker, only for `pnpm run test:containers`

## Fresh Clone

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run validate
```

`pnpm run validate` runs typecheck, test typecheck, lint, Vitest, repo audit, and a Cloudflare Worker dry-run bundle.

## Local Development

Start the Worker:

```sh
pnpm run dev
```

Check it from another terminal:

```sh
curl -sS http://127.0.0.1:8787/
```

Load and generated-agent checks:

```sh
pnpm run test:load
pnpm run test:containers
pnpm run benchmark
```

Production smoke:

```sh
SOE_BASE_URL=https://soe.stoff.dev pnpm run smoke:prod
```

## Tech Decisions

- Cloudflare Worker keeps the public surface to one HTTPS deployment with no long-running server to operate.
- Durable Objects give each session a single ordered queue, which keeps parallel sends from mixing command results.
- R2 stores only session metadata and code lookup records; command bodies and outputs stay in the live Durable Object path.
- Generated POSIX and PowerShell agents avoid binary installs, native build chains, and platform-specific release assets.
- An 8-character code keeps the operator flow fast, while short TTLs and explicit `/end` keep the capability temporary.

## Limits

| Item | Limit |
| --- | --- |
| Session code | 8 characters |
| Session TTL | 2 hours |
| Command body | 64 KB |
| Result body | 1 MB |
| Command timeout | 1-50 seconds |

## Layout

```text
src/
  agent/                         generated POSIX and PowerShell relay agents
  worker/
    durable-objects/             command queue and result pairing
    routes/                      public HTTP API
    services/                    session storage and Durable Object lookup
  shared/                        config, HTTP, strings, ids
tests/
  unit/                          script and helper checks
  integration/                   Worker and Durable Object flows
  e2e/                           generated agents, containers, relay load
scripts/
  benchmark.mjs                  local relay benchmark
  smoke-prod.mjs                 production smoke test
  repo-audit.mjs                 repo hygiene guard
```

Automation instructions: [llms.txt](llms.txt)

Agent skill: [skills/shell-over-edge/SKILL.md](skills/shell-over-edge/SKILL.md)
