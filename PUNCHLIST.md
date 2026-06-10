# Punch List

Ordered by impact on a five-minute senior-engineer review.

## Open

No open items.

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

- [x] P2: Delete dead support code and template leftovers.
  - Fixed: removed the unused legacy bridge env/test option, deleted the unused JSON response helper and self-test, and reduced the pnpm workspace globs to the actual package.
  - Proof: no `rg` hits for the removed terms; `pnpm run validate`; `pnpm run build`; local `pnpm run dev` plus root curl.

- [x] P2: Test the real Durable Object command bridge directly.
  - Fixed: extracted the production queue/result implementation into `CommandBridgeCore`, kept the Durable Object as a thin adapter, and added direct tests for parallel result matching, `/end` waiter resolution, command timeout, and late-result acknowledgement.
  - Proof: `pnpm exec vitest run tests/unit/command-bridge-core.test.ts`; `pnpm run validate` with 26 passing tests; `pnpm run build`; local `pnpm run dev` plus root curl.

- [x] P3: Make the package scripts read like a production Worker.
  - Fixed: `pnpm run build` now typechecks and runs the Cloudflare Worker dry-run bundle. Root terminal usage now includes the close-session command.
  - Proof: `pnpm run validate`; `pnpm run build`; local `pnpm run dev` plus root output grep for bootstrap, send, and end commands.
