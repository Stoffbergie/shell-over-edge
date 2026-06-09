# Shell Over Edge

[![CI](https://github.com/Stoffberg/shell-over-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/shell-over-edge/actions/workflows/ci.yml)
[![Deploy](https://github.com/Stoffberg/shell-over-edge/actions/workflows/deploy.yml/badge.svg)](https://github.com/Stoffberg/shell-over-edge/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Reach any shell from anywhere.

Start a tiny generated agent on one machine, then send commands to it from any other machine over plain HTTPS. No dashboard. No account flow. A session UUID is the capability.

Production: [https://soe.stoff.dev](https://soe.stoff.dev)

## The Shape

```mermaid
sequenceDiagram
    participant Helper
    participant Worker as Cloudflare Worker
    participant Bridge as Durable Object
    participant Agent as Generated Agent

    Helper->>Worker: POST /api/sessions
    Worker-->>Helper: agent script + X-Session-Id

    Note over Agent: run script on target machine
    Agent->>Worker: POST /api/sessions/:id/hello
    Agent->>Worker: GET /api/sessions/:id/next
    Worker->>Bridge: wait for command

    Helper->>Worker: POST /api/sessions/:id/send
    Worker->>Bridge: enqueue command and wait
    Bridge-->>Agent: command + command id
    Agent->>Agent: execute locally
    Agent->>Worker: POST /api/sessions/:id/result/:commandId
    Worker->>Bridge: resolve waiter
    Bridge-->>Helper: plain command output

    Helper->>Worker: POST /api/sessions/:id/end
    Worker->>Bridge: close waiters
```

R2 stores session metadata. The Durable Object only coordinates the live command handoff.

## Quick Start

Start a POSIX agent on the target machine:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions | sh
```

Start a PowerShell agent on the target machine:

```powershell
irm -Method Post https://soe.stoff.dev/api/sessions.ps1 | iex
```

The agent prints the UUID and copies it to the clipboard when possible. The create response also returns it in `X-Session-Id`.

Send a command:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/send --data 'pwd'
```

End the session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/end
```

## API

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/sessions` | empty | POSIX shell agent script |
| `POST /api/sessions.ps1` | empty | PowerShell agent script |
| `POST /api/sessions/<uuid>/send` | raw text or JSON | plain command output |
| `POST /api/sessions/<uuid>/end` | empty | `ended` |

For simple commands, send raw text:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/send --data 'uname -a'
```

Use JSON only when you need options:

```json
{
  "body": "pwd",
  "cwd": "/tmp",
  "timeoutSeconds": 30
}
```

`timeout` is also accepted. Timeouts are clamped from 1 to 3600 seconds.

## Security Model

Sessions are UUID capabilities. Anyone with the UUID can use that session until it ends or expires.

There are no bearer tokens, helper tokens, agent tokens, URL tokens, or auth headers in the current API.

Treat a session UUID like a temporary password:

- keep it out of logs and screenshots
- end the session when finished
- do not leave agents running unattended

## Limits

| Limit | Value |
| --- | --- |
| Session TTL | 2 hours |
| Cleanup retention | 24 hours after expiry |
| Command body | 64 KB |
| Result body | 1 MB |
| Timeout | 1 to 3600 seconds |

## Agent Resources

- Compact agent reference: [`llms.txt`](llms.txt)
- Reusable agent skill: [`skills/shell-over-edge/SKILL.md`](skills/shell-over-edge/SKILL.md)
- Raw `llms.txt`: [raw.githubusercontent.com/Stoffberg/shell-over-edge/main/llms.txt](https://raw.githubusercontent.com/Stoffberg/shell-over-edge/main/llms.txt)
- Raw skill: [raw.githubusercontent.com/Stoffberg/shell-over-edge/main/skills/shell-over-edge/SKILL.md](https://raw.githubusercontent.com/Stoffberg/shell-over-edge/main/skills/shell-over-edge/SKILL.md)

## Tech

- Cloudflare Workers for the public HTTP API
- Hono for routing
- Durable Objects for live command coordination
- R2 for session metadata and cleanup
- TypeScript for the Worker and generated agent builders
- Vitest for unit, integration, and generated-agent e2e tests

## Repo Layout

```text
src/
  worker.ts                         Cloudflare Worker module entry
  worker/
    app.ts                          Hono app, root route, error/cache middleware
    env.ts                          Cloudflare binding types
    routes/sessions.ts              Public session API and agent callbacks
    durable-objects/command-bridge.ts
    services/session-bridge.ts      Durable Object lookup boundary
    services/session-store.ts       R2 session metadata and cleanup
  agent/
    shell.ts                        Generated POSIX agent
    powershell.ts                   Generated PowerShell agent
    terminal-usage.ts               Root terminal usage text
  domain/session.ts                 Session domain types
  shared/                           Small generic utilities
tests/
  unit/                             Pure utilities and generated script checks
  integration/                      Worker request/response flows with fake bindings
  e2e/                              Generated agent scripts against a local HTTP server
  helpers/                          Typed test harnesses
scripts/
  repo-audit.mjs                    Repo hygiene checks
  smoke-prod.mjs                    Live production smoke test
```

## Development

```sh
pnpm install
pnpm run dev
```

Full local validation:

```sh
pnpm run validate
```

That runs source typechecking, test typechecking, Vitest, repo audit, and a Wrangler dry run.

## Cloudflare

Required bindings:

- R2 bucket: `SOE_MAILBOX`
- Durable Object namespace: `COMMAND_BRIDGES`
- Custom domain: `soe.stoff.dev`
- Worker name: `soe`

Required GitHub deployment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
