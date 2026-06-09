# soe

[![CI](https://github.com/Stoffberg/soe/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/soe/actions/workflows/ci.yml)
[![Deploy](https://github.com/Stoffberg/soe/actions/workflows/deploy.yml/badge.svg)](https://github.com/Stoffberg/soe/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Temporary remote support over a Cloudflare Worker.

Production: [https://soe.stoff.dev](https://soe.stoff.dev)

## How It Works

Create a session, send the generated command to the remote machine, then queue shell commands or file transfers through the session API. Sessions expire after two hours.

## Start A Session

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions \
  -H "Content-Type: application/json" \
  --data '{"helperName":"Dirk"}'
```

The response includes:

- `shellCommand`: run on macOS or Linux
- `windowsCommand`: run in PowerShell
- `helperToken`: use this from the helper side
- `agentToken`: embedded in the generated remote-side script

Tokens are sent through `Authorization: Bearer` headers, not URL query strings.

## Queue A Command

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<session-id>/commands \
  -H "Authorization: Bearer <helper-token>" \
  -H "Content-Type: application/json" \
  --data '{"body":"pwd"}'
```

Read events:

```sh
curl -sS https://soe.stoff.dev/api/sessions/<session-id>/events \
  -H "Authorization: Bearer <helper-token>"
```

End the session:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<session-id>/end \
  -H "Authorization: Bearer <helper-token>"
```

## File Transfer

Upload a file to the remote machine:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<session-id>/upload \
  -H "Authorization: Bearer <helper-token>" \
  -F "path=/tmp/example.txt" \
  -F "file=@./example.txt"
```

Read a file back:

```sh
curl -sS -X POST https://soe.stoff.dev/api/sessions/<session-id>/download \
  -H "Authorization: Bearer <helper-token>" \
  -H "Content-Type: application/json" \
  --data '{"path":"/tmp/example.txt"}'
```

Then fetch `/api/sessions/<session-id>/downloads/<download-id>` with the same helper token.

## Limits

| Limit | Value |
| --- | --- |
| Session TTL | 2 hours |
| Cleanup retention | 24 hours after expiry |
| Command body | 64 KB |
| Result body | 1 MB |
| File upload/download | 1 MB |
| Timeout | 1 to 3600 seconds |

## Local Development

```sh
pnpm install
pnpm run dev
```

## Validation

```sh
pnpm run check
pnpm run dry-run
pnpm run smoke:prod
```

`pnpm run validate` runs the local check chain plus a Wrangler dry run.

## Cloudflare

Required bindings:

- R2 bucket: `SOE_MAILBOX`
- Durable Object namespace: `COMMAND_BRIDGES`
- Custom domain: `soe.stoff.dev`
- Optional legacy flag: `ENABLE_LEGACY_BRIDGE=true`

GitHub deploys need these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
