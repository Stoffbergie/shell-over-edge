# Punch List

Ordered by impact on a five-minute senior-engineer review.

## Open

- [ ] P2: Delete dead support code and template leftovers.
  - Problem: `ENABLE_LEGACY_BRIDGE` and `legacyBridge` are unused, `jsonResponse` only exists for its own unit test, and `pnpm-workspace.yaml` advertises nonexistent workspace package globs.
  - Proof required: `pnpm run validate`.

- [ ] P2: Test the real Durable Object command bridge directly.
  - Problem: integration/load tests exercise a duplicated fake bridge, so the production `CommandBridge` queue/result behavior can drift without a direct test failing.
  - Proof required: direct bridge tests for queued sends, result matching, end behavior, and timeout edge cases; `pnpm run test`.

- [ ] P3: Make the package scripts read like a production Worker.
  - Problem: `build` only runs TypeScript, while the real Worker bundle proof is `wrangler deploy --dry-run`. The root terminal usage also omits the close-session command.
  - Proof required: `pnpm run build`; local `pnpm run dev` root output includes start, send, and end.

## Done

- [x] P0: Stop exposing session capabilities and local target details.
  - Fixed: `session_created` no longer logs short session codes, session creation no longer returns `X-Session-Internal-Id`, public routes no longer accept internal UUIDs, and generated agents no longer send username/current-directory telemetry.
  - Proof: `pnpm run typecheck && pnpm run typecheck:test && pnpm run test`; `pnpm run validate`; local `pnpm run dev` with `POST /api/sessions` showed only `X-Session-Id`/`X-Session-Code` and no removed telemetry strings.

- [x] P1: Add a real lint target and wire it into the quality gate.
  - Fixed: added Biome linting, included it in `pnpm run check`, removed the unnecessary Durable Object constructor, and made the test server header copy callback explicit.
  - Proof: `pnpm run lint`; `pnpm run validate`; `pnpm run build`.

- [x] P1: Make the README pass a cold-clone skim.
  - Fixed: added a concrete terminal demo, runtime requirements, fresh-clone setup, separate local-development instructions, tech-decision rationale, and removed the internal tool label. `repo-audit` now guards the required README sections.
  - Proof: `corepack enable`; `pnpm install --frozen-lockfile`; `pnpm run repo:audit`; `pnpm run validate`; `pnpm run build`; local `pnpm run dev` plus `curl -sS http://127.0.0.1:8787/`.
