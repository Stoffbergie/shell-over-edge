import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", ".tmp", ".wrangler", "node_modules"]);
const banned = [
  "remote" + ".stoff.dev",
  "remote" + "-stoff-dev",
  "remote" + "_stoff",
  "Buddy Dev" + " Support",
  "[rem" + "ote]",
  "?token" + "="
];

const requiredFiles = [
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/labeler.yml",
  ".github/workflows/release.yml",
  "LICENSE",
  "llms.txt",
  "pnpm-workspace.yaml",
  "scripts/repo-audit.mjs",
  "scripts/smoke-prod.mjs",
  "skills/shell-over-edge/SKILL.md",
  "tsconfig.test.json",
  "vitest.config.ts"
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

async function main() {
  await walk(root);
  const failures = [];

  for (const file of requiredFiles) {
    try {
      await readText(join(root, file));
    } catch {
      failures.push(`Missing ${file}`);
    }
  }

  for (const file of textFiles) {
    const rel = relative(root, file);
    if (rel === "pnpm-lock.yaml") continue;
    if (rel.startsWith("tests/") && rel.endsWith(".mjs")) failures.push(`${rel} must be a Vitest TypeScript test file`);
    const text = await readText(file).catch(() => "");
    for (const value of banned) {
      if (text.includes(value)) failures.push(`${rel} contains ${value}`);
    }
  }

  const pkg = JSON.parse(await readText(join(root, "package.json")));
  if (pkg.name !== "soe") failures.push("package.json name must be soe");
  if (pkg.private !== false) failures.push("package.json private must be false");
  if (pkg.description !== "Reach any shell from anywhere.") failures.push("package.json description is wrong");
  if (pkg.homepage !== "https://soe.stoff.dev") failures.push("package.json homepage must be https://soe.stoff.dev");
  if (pkg.repository?.url !== "https://github.com/Stoffberg/shell-over-edge.git") failures.push("package.json repository URL is wrong");
  if (pkg.scripts?.test !== "vitest run") failures.push("package.json test script must use Vitest");
  if (!pkg.scripts?.["test:load"]) failures.push("package.json missing test:load");
  if (!pkg.scripts?.["typecheck:test"]) failures.push("package.json missing typecheck:test");
  if (!pkg.devDependencies?.vitest) failures.push("package.json missing vitest");

  const wrangler = await readText(join(root, "wrangler.toml"));
  for (const value of ['name = "soe"', 'BASE_URL = "https://soe.stoff.dev"', 'pattern = "soe.stoff.dev"', 'bucket_name = "soe-mailbox"']) {
    if (!wrangler.includes(value)) failures.push(`wrangler.toml missing ${value}`);
  }

  const readme = await readText(join(root, "README.md"));
  if (!readme.includes("# Shell Over Edge")) failures.push("README must use the full product name");
  if (!readme.includes("Reach any shell from anywhere.")) failures.push("README one-liner is wrong");
  if (!readme.includes("```mermaid")) failures.push("README must include a Mermaid flow diagram");
  if (!readme.includes("/api/sessions/<uuid>/candidates")) failures.push("README must document direct candidates");
  if (!readme.includes("Direct Transport")) failures.push("README must document the direct transport tradeoff");
  if (!readme.includes("llms.txt")) failures.push("README must link llms.txt");
  if (!readme.includes("skills/shell-over-edge/SKILL.md")) failures.push("README must link the Shell Over Edge skill");
  if (readme.includes("Authorization: Bearer")) failures.push("README must not document retired bearer-token API");
  if (readme.includes("/commands")) failures.push("README must not document retired commands endpoint");

  const llms = await readText(join(root, "llms.txt"));
  if (!llms.includes("POST /api/sessions")) failures.push("llms.txt must document session creation");
  if (!llms.includes("POST /api/sessions/<uuid>/send")) failures.push("llms.txt must document command send");
  if (!llms.includes("POST /api/sessions/<uuid>/candidates")) failures.push("llms.txt must document direct candidates");
  if (llms.includes("Authorization: Bearer")) failures.push("llms.txt must not document retired bearer-token API");

  const skill = await readText(join(root, "skills/shell-over-edge/SKILL.md"));
  if (!skill.includes("name: shell-over-edge")) failures.push("Shell Over Edge skill missing name metadata");
  if (!skill.includes("POST https://soe.stoff.dev/api/sessions/<uuid>/send")) failures.push("Shell Over Edge skill must document command send");
  if (!skill.includes("POST https://soe.stoff.dev/api/sessions/<uuid>/candidates")) failures.push("Shell Over Edge skill must document direct candidates");
  if (skill.includes("Authorization: Bearer")) failures.push("Shell Over Edge skill must not document retired bearer-token API");

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log("repo audit passed");
}

await main();
