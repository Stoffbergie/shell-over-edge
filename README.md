# Shell Over Edge

[![CI](https://github.com/Stoffberg/shell-over-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/shell-over-edge/actions/workflows/ci.yml)
[![Deploy](https://github.com/Stoffberg/shell-over-edge/actions/workflows/deploy.yml/badge.svg)](https://github.com/Stoffberg/shell-over-edge/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Temporary shell access through Cloudflare Workers.

Production: [https://soe.stoff.dev](https://soe.stoff.dev)

Short name: `soe`.

## Agent Resources

- Compact agent reference: [`llms.txt`](llms.txt)
- Reusable agent skill: [`skills/shell-over-edge/SKILL.md`](skills/shell-over-edge/SKILL.md)
- Raw `llms.txt`: [`raw.githubusercontent.com/Stoffberg/shell-over-edge/main/llms.txt`](https://raw.githubusercontent.com/Stoffberg/shell-over-edge/main/llms.txt)
- Raw skill: [`raw.githubusercontent.com/Stoffberg/shell-over-edge/main/skills/shell-over-edge/SKILL.md`](https://raw.githubusercontent.com/Stoffberg/shell-over-edge/main/skills/shell-over-edge/SKILL.md)

## API

Create a POSIX shell session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions | sh
```

Create a PowerShell session:

```powershell
irm -Method Post https://soe.stoff.dev/api/sessions.ps1 | iex
```

Each generated agent prints and copies the session UUID when clipboard support is available. The UUID is also returned in the `X-Session-Id` response header.

Send a command:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/send --data 'pwd'
```

End a session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<uuid>/end
```

`/send` accepts raw text. It also accepts JSON when callers need `cwd`, `timeoutSeconds`, or `timeout`.

## How It Works

Sessions are UUID capabilities. R2 stores session metadata and the Durable Object for that UUID coordinates the live command handoff:

- helper calls `/send`
- generated agent long-polls `/next`
- agent executes the command locally
- agent posts output to `/result/<command-id>`
- `/send` returns the plain command output

Responses are intentionally plain text where possible. There are no bearer tokens or URL tokens in the current API.

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

`pnpm-workspace.yaml` keeps this as a pnpm workspace now, while leaving room for future `apps/*`, `packages/*`, and `tools/*` without splitting this Worker prematurely.

## Local Development

```sh
pnpm install
pnpm run dev
```

## Validation

```sh
pnpm run typecheck
pnpm run typecheck:test
pnpm run test
pnpm run check
pnpm run dry-run
pnpm run smoke:prod
```

`pnpm run validate` runs the full local check chain plus a Wrangler dry run.

## Limits

| Limit | Value |
| --- | --- |
| Session TTL | 2 hours |
| Cleanup retention | 24 hours after expiry |
| Command body | 64 KB |
| Result body | 1 MB |
| Timeout | 1 to 3600 seconds |

## Cloudflare

Required bindings:

- R2 bucket: `SOE_MAILBOX`
- Durable Object namespace: `COMMAND_BRIDGES`
- Custom domain: `soe.stoff.dev`
- Worker name: `soe`

GitHub deploys need these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
