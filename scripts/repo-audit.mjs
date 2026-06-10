import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", ".tmp", ".wrangler", ".zig-cache", "dist", "node_modules", "zig-out"]);
const banned = [
  "remote" + ".stoff.dev",
  "remote" + "-stoff-dev",
  "remote" + "_stoff",
  "Buddy Dev" + " Support",
  "[rem" + "ote]",
  "?token" + "="
];

const removedTransportTerms = [
  "SOE_WARM_NATIVE",
  "SOE_AUTO_UPGRADE",
  "SOE_NATIVE_URL",
  "SOE_NATIVE_BASE_URL",
  "SOE_WEBRTC_URL",
  "SOE_WEBRTC_BASE_URL",
  "soe-agent",
  "soe-webrtc",
  "WebRTC",
  "RTCPeerConnection",
  "stun.cloudflare.com",
  "turn.cloudflare.com",
  "/signals",
  "/ice",
  "/probe"
];

const allowedRemovedTermFiles = new Set([
  "scripts/repo-audit.mjs",
  "scripts/smoke-prod.mjs",
  "tests/e2e/agent-script.test.ts",
  "tests/integration/app-flow.test.ts",
  "tests/unit/scripts.test.ts"
]);

const requiredFiles = [
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/labeler.yml",
  ".gitattributes",
  "LICENSE",
  "llms.txt",
  "pnpm-workspace.yaml",
  "scripts/benchmark.mjs",
  "scripts/repo-audit.mjs",
  "scripts/smoke-prod.mjs",
  "skills/shell-over-edge/SKILL.md",
  "tsconfig.test.json",
  "vitest.config.ts"
];

const removedFiles = [
  ".github/workflows/release.yml",
  "build.zig",
  "go.mod",
  "go.sum",
  "native/agent/main.zig",
  "native/webrtc/main.go",
  "scripts/build-native-linux.mjs",
  "scripts/build-webrtc.mjs",
  "src/client/direct-send.ts",
  "src/domain/direct.ts",
  "src/worker/services/ice-servers.ts"
];

const textFiles = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) await walk(join(dir, entry.name));
      continue;
    }
    if (entry.isFile()) textFiles.push(join(dir, entry.name));
  }
}

async function readText(path) {
  return readFile(path, "utf8");
}

async function exists(path) {
  try {
    await readText(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await walk(root);
  const failures = [];

  for (const file of requiredFiles) {
    if (!await exists(join(root, file))) failures.push(`Missing ${file}`);
  }
  for (const file of removedFiles) {
    if (await exists(join(root, file))) failures.push(`${file} should not exist in relay-only mode`);
  }

  for (const file of textFiles) {
    const rel = relative(root, file);
    if (rel === "pnpm-lock.yaml") continue;
    if (rel.startsWith("tests/") && rel.endsWith(".mjs")) failures.push(`${rel} must be a Vitest TypeScript test file`);
    const text = await readText(file).catch(() => "");
    for (const value of banned) {
      if (text.includes(value)) failures.push(`${rel} contains ${value}`);
    }
    if (!allowedRemovedTermFiles.has(rel)) {
      for (const value of removedTransportTerms) {
        if (text.includes(value)) failures.push(`${rel} still references removed transport term ${value}`);
      }
    }
  }

  const pkg = JSON.parse(await readText(join(root, "package.json")));
  if (pkg.name !== "soe") failures.push("package.json name must be soe");
  if (pkg.private !== false) failures.push("package.json private must be false");
  if (pkg.description !== "Reach any shell from anywhere.") failures.push("package.json description is wrong");
  if (pkg.homepage !== "https://soe.stoff.dev") failures.push("package.json homepage must be https://soe.stoff.dev");
  if (pkg.repository?.url !== "https://github.com/Stoffberg/shell-over-edge.git") failures.push("package.json repository URL is wrong");
  if (pkg.scripts?.test !== "vitest run") failures.push("package.json test script must use Vitest");
  if (pkg.scripts?.["test:load"] !== "vitest run tests/e2e/relay-load.test.ts tests/e2e/agent-script.test.ts") failures.push("package.json test:load must cover relay load and generated agents");
  if (!pkg.scripts?.["test:containers"]) failures.push("package.json missing test:containers");
  for (const script of ["native:build", "native:build:linux", "test:native", "test:webrtc", "webrtc:build", "webrtc:build:all"]) {
    if (pkg.scripts?.[script]) failures.push(`package.json still has ${script}`);
  }
  if (!pkg.scripts?.["typecheck:test"]) failures.push("package.json missing typecheck:test");
  if (!pkg.devDependencies?.vitest) failures.push("package.json missing vitest");

  const ci = await readText(join(root, ".github/workflows/ci.yml"));
  if (ci.includes("setup-go") || ci.includes("setup-zig") || ci.includes("test:native") || ci.includes("test:webrtc")) {
    failures.push("CI still installs or tests removed native/WebRTC tooling");
  }

  const wrangler = await readText(join(root, "wrangler.toml"));
  for (const value of ['name = "soe"', 'BASE_URL = "https://soe.stoff.dev"', 'pattern = "soe.stoff.dev"', 'bucket_name = "soe-mailbox"']) {
    if (!wrangler.includes(value)) failures.push(`wrangler.toml missing ${value}`);
  }

  const readme = await readText(join(root, "README.md"));
  if (!readme.includes("# Shell Over Edge")) failures.push("README must use the full product name");
  if (!readme.includes("Reach any shell from anywhere.")) failures.push("README one-liner is wrong");
  if (!readme.includes("## Demo")) failures.push("README must include a concrete demo");
  if (!readme.includes("```mermaid")) failures.push("README must include a Mermaid flow diagram");
  if (!readme.includes("## Requirements")) failures.push("README must document runtime requirements");
  if (!readme.includes("## Fresh Clone")) failures.push("README must document fresh-clone setup");
  if (!readme.includes("corepack enable")) failures.push("README must document Corepack setup");
  if (!readme.includes("pnpm install --frozen-lockfile")) failures.push("README must use frozen-lockfile install");
  if (!readme.includes("pnpm run validate")) failures.push("README must document validate");
  if (!readme.includes("## Tech Decisions")) failures.push("README must explain tech decisions");
  if (!readme.includes("curl -sS https://soe.stoff.dev/a | sh")) failures.push("README must document POSIX bootstrap");
  if (!readme.includes("/api/sessions/<code>/send")) failures.push("README must document send endpoint");
  if (!readme.includes("pnpm run benchmark")) failures.push("README must document performance benchmark");
  if (!readme.includes("llms.txt")) failures.push("README must link llms.txt");
  if (!readme.includes("skills/shell-over-edge/SKILL.md")) failures.push("README must link the Shell Over Edge skill");
  if (readme.includes("Codex")) failures.push("README must not mention internal tooling");
  if (readme.includes("Authorization: Bearer")) failures.push("README must not document retired bearer-token API");

  const llms = await readText(join(root, "llms.txt"));
  if (!llms.includes("GET /a")) failures.push("llms.txt must document POSIX bootstrap");
  if (!llms.includes("POST /api/sessions")) failures.push("llms.txt must document session creation");
  if (!llms.includes("POST /api/sessions/<code>/send")) failures.push("llms.txt must document command send");
  if (llms.includes("Authorization: Bearer")) failures.push("llms.txt must not document retired bearer-token API");

  const skill = await readText(join(root, "skills/shell-over-edge/SKILL.md"));
  if (!skill.includes("name: shell-over-edge")) failures.push("Shell Over Edge skill missing name metadata");
  if (!skill.includes("GET https://soe.stoff.dev/a")) failures.push("Shell Over Edge skill must document POSIX bootstrap");
  if (!skill.includes("POST https://soe.stoff.dev/api/sessions/<code>/send")) failures.push("Shell Over Edge skill must document command send");
  if (skill.includes("Authorization: Bearer")) failures.push("Shell Over Edge skill must not document retired bearer-token API");

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log("repo audit passed");
}

await main();
